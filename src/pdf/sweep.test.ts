/**
 * Retention sweep tests — F8.6 / F-013.
 *
 * sweepRetention scans every non-purged TERMINAL-state envelope (not "has a
 * pdf_storage_key" — that column is always null, the F-013 bug), applies
 * shouldDeletePdf, and when true stamps pdf_deleted_at and purges the envelope's
 * REAL blobs (document D + per-signer covers) at their deterministic keys.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sweepRetention } from './sweep.js';
import type { DbPool } from '../db/pool.js';
import type { Envelope, EnvelopeSigner } from '../db/types.js';

const NOW = new Date('2026-04-15T12:00:00Z');
const DOC = (h: string) => `envelopes/${h}/document.pdf`;
const COVER = (h: string, t: string) => `envelopes/${h}/cover-${t}.pdf`;

function envelope(o: Partial<Envelope> = {}): Envelope {
  return {
    id: 'env-1', sender_email: 'sender@test.com',
    document_name: 'NDA', document_hash: 'a'.repeat(64), source_hash: null,
    status: 'completed', consent_language_version: '1.0',
    created_at: new Date('2026-04-10T00:00:00Z'),
    completed_at: new Date('2026-04-14T00:00:00Z'),
    pdf_storage_key: null, // F-013: never written on create
    expiry_at: null, pdf_deleted_at: null,
    completion_distributed_at: null, internal_test: false, ...o,
  };
}
function signer(o: Partial<EnvelopeSigner> = {}): EnvelopeSigner {
  return {
    id: 's-1', envelope_id: 'env-1', email: 'a@t.com', name: 'A', on_behalf_of: null,
    verification_level: 2, signing_method: 'email',
    status: 'signed', sent_pdf_hash: null,
    signing_token: 'tok1', token_expires_at: NOW,
    signed_at: new Date('2026-04-13T00:00:00Z'),
    reminder_count: 0, last_reminder_at: null,
    completion_email_delivered_at: null, completion_email_bounced_at: null,
    completion_email_provider_msg_id: null, undeliverable_at: null,
    acceptance_notified_at: null, ...o,
  };
}

// F-014: the production HttpDbPool returns TIMESTAMPTZ columns as ISO strings
// (run402's HTTP DB serializes rows via row_to_json → JSON). Local node-`pg` parses
// them to Date, which is why the sweep's raw `SELECT *` scan looked fine in tests but
// crashed in prod: shouldDeletePdf called `.getTime()` on a string. This mock now
// returns rows in the REAL wire shape (timestamps → ISO strings) so the sweep's
// boundary rehydration is actually exercised. The in-memory store keeps rich Date
// objects for the guard/stamp logic; only the ROWS handed back to the sweep are
// serialized — exactly like the real transport.
const TIMESTAMP_COLS = [
  'created_at', 'completed_at', 'expiry_at', 'pdf_deleted_at', 'completion_distributed_at',
  'signed_at', 'token_expires_at', 'last_reminder_at', 'completion_email_delivered_at',
  'completion_email_bounced_at', 'undeliverable_at', 'acceptance_notified_at',
];
function asDbRow<T extends Record<string, any>>(row: T): T {
  const out: any = { ...row };
  for (const c of TIMESTAMP_COLS) {
    if (c in out && out[c] instanceof Date) out[c] = out[c].toISOString();
  }
  return out;
}

/** A mock pool that models the candidate query, the shared-document guard, the
 *  signers query, and the pdf_deleted_at stamp (mutating the fixtures so the
 *  guard reflects the live state within one sweep). Rows returned to the sweep are
 *  serialized to the production wire shape (ISO-string timestamps) via asDbRow. */
function createMockPool(envelopes: Envelope[], signersByEnv: Record<string, EnvelopeSigner[]>) {
  const stamped: string[] = [];
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as any[];
      // Shared-document guard (checked first — it also says FROM envelopes).
      if (text.includes('FROM envelopes') && text.includes('document_hash')) {
        const [docHash, selfId] = v;
        const sibling = envelopes.find((e) => e.document_hash === docHash && e.id !== selfId && !e.pdf_deleted_at);
        return { rows: sibling ? [{ one: 1 }] : [] } as any;
      }
      // Candidate query. Rows are serialized to the prod wire shape (ISO-string
      // timestamps) so the sweep's boundary rehydration is exercised (F-014).
      if (text.includes('FROM envelopes') && text.includes('status IN')) {
        return { rows: envelopes.filter((e) => !e.pdf_deleted_at && ['voided', 'expired', 'completed'].includes(e.status)).map(asDbRow) } as any;
      }
      // Signers for an envelope (also serialized to the prod wire shape).
      if (text.includes('FROM envelope_signers WHERE envelope_id')) {
        return { rows: (signersByEnv[v[0] as string] ?? []).map(asDbRow) } as any;
      }
      // Stamp pdf_deleted_at.
      if (text.includes('UPDATE envelopes SET pdf_deleted_at')) {
        const id = v[0] as string;
        const at = v[1] as Date;
        const e = envelopes.find((x) => x.id === id);
        if (e) { e.pdf_deleted_at = at; stamped.push(id); }
        return { rows: [], rowCount: e ? 1 : 0 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    },
    async end() {},
  };
  return { pool, stamped };
}

function createMockStorage() {
  const deleted: string[] = [];
  return { deleted, async deletePdf(key: string) { deleted.push(key); } };
}

describe('sweepRetention — F8.6 / F-013', () => {
  it('purges the document D + covers for a voided envelope (real keys, not pdf_storage_key)', async () => {
    const e = envelope({ id: 'v-1', status: 'voided', document_hash: 'h1' });
    const { pool, stamped } = createMockPool([e], { 'v-1': [signer({ envelope_id: 'v-1', signing_token: 'tv' })] });
    const storage = createMockStorage();

    const result = await sweepRetention(pool, storage, NOW);

    assert.deepEqual(storage.deleted.sort(), [COVER('h1', 'tv'), DOC('h1')].sort());
    assert.deepEqual(stamped, ['v-1']);
    assert.equal(result.deleted, 1);
    assert.equal(result.scanned, 1);
  });

  it('purges a completed envelope where every signer delivered', async () => {
    const e = envelope({ id: 'd-1', document_hash: 'h2' });
    const s1 = signer({ id: 's-1', envelope_id: 'd-1', signing_token: 'ta', completion_email_delivered_at: new Date('2026-04-14T01:00:00Z') });
    const s2 = signer({ id: 's-2', envelope_id: 'd-1', signing_token: 'tb', completion_email_delivered_at: new Date('2026-04-14T02:00:00Z') });
    const { pool } = createMockPool([e], { 'd-1': [s1, s2] });
    const storage = createMockStorage();

    const result = await sweepRetention(pool, storage, NOW);
    assert.equal(result.deleted, 1);
    assert.deepEqual(storage.deleted.sort(), [COVER('h2', 'ta'), COVER('h2', 'tb'), DOC('h2')].sort());
  });

  it('skips completed envelopes still waiting on delivery (no stamp, no delete)', async () => {
    const e = envelope({ id: 'w-1' });
    const s = signer({ envelope_id: 'w-1', completion_email_delivered_at: null });
    const { pool, stamped } = createMockPool([e], { 'w-1': [s] });
    const storage = createMockStorage();

    const result = await sweepRetention(pool, storage, NOW);
    assert.equal(result.deleted, 0);
    assert.equal(stamped.length, 0);
    assert.equal(storage.deleted.length, 0);
    assert.equal(result.scanned, 1);
  });

  it('does not call storage.deletePdf when nothing is eligible', async () => {
    const { pool } = createMockPool([], {});
    const storage = createMockStorage();
    const result = await sweepRetention(pool, storage, NOW);
    assert.equal(result.deleted, 0);
    assert.equal(result.scanned, 0);
    assert.equal(storage.deleted.length, 0);
  });

  it('shared document D: two voided envelopes off the same upload — D deleted once, by the last', async () => {
    // Both share document_hash 'shared'; each has its own cover. The first purge
    // sees the second still un-stamped → skips D; the second (now the last
    // referencer) deletes D. Each cover is always freed.
    const e1 = envelope({ id: 'x-1', status: 'voided', document_hash: 'shared' });
    const e2 = envelope({ id: 'x-2', status: 'voided', document_hash: 'shared' });
    const { pool } = createMockPool([e1, e2], {
      'x-1': [signer({ envelope_id: 'x-1', signing_token: 'c1' })],
      'x-2': [signer({ envelope_id: 'x-2', signing_token: 'c2' })],
    });
    const storage = createMockStorage();

    const result = await sweepRetention(pool, storage, NOW);

    assert.equal(result.scanned, 2);
    // Both covers freed; the shared document deleted exactly once.
    assert.ok(storage.deleted.includes(COVER('shared', 'c1')));
    assert.ok(storage.deleted.includes(COVER('shared', 'c2')));
    assert.equal(storage.deleted.filter((k) => k === DOC('shared')).length, 1);
  });

  it('continues sweeping if a delete throws (fail-soft, counts the envelope as failed)', async () => {
    const e1 = envelope({ id: 'f-1', status: 'voided', document_hash: 'hbad' });
    const e2 = envelope({ id: 'f-2', status: 'voided', document_hash: 'hgood' });
    const { pool } = createMockPool([e1, e2], {
      'f-1': [signer({ envelope_id: 'f-1', signing_token: 'g1' })],
      'f-2': [signer({ envelope_id: 'f-2', signing_token: 'g2' })],
    });
    const storage = {
      deleted: [] as string[],
      async deletePdf(key: string) {
        if (key === DOC('hbad')) throw new Error('storage down');
        this.deleted.push(key);
      },
    };
    const result = await sweepRetention(pool, storage, NOW);
    assert.equal(result.scanned, 2);
    assert.equal(result.deleted, 1); // f-2 fully purged
    assert.equal(result.failed, 1);  // f-1 had a failed key
    assert.ok(storage.deleted.includes(DOC('hgood')));
  });

  // ── F-014: the sweep must survive prod-shape (string) timestamps ─────────────
  // Cycle 12 found the hourly retention_sweep crashing 5/5 whenever a just-completed
  // envelope with a still-pending blob was in scope: shouldDeletePdf called
  // `completed_at.getTime()` on a string (HttpDbPool returns TIMESTAMPTZ as an ISO
  // string) → TypeError, aborting the whole sweep and leaving the 30-day hard-cap net
  // down. These two tests reproduce that exact scope through the string-shape mock.

  it('F-014: does NOT crash on a just-completed, within-cap envelope (blob pending) and KEEPS it', async () => {
    // A completed envelope 1 day old with no delivery confirmation yet (blob pending).
    // Pre-fix this threw inside the sweep; it must now complete cleanly and keep the blob.
    const e = envelope({ id: 'jc-1', document_hash: 'hjc', completed_at: new Date('2026-04-14T00:00:00Z') });
    const s = signer({ envelope_id: 'jc-1', signing_token: 'tjc', completion_email_delivered_at: null });
    const { pool, stamped } = createMockPool([e], { 'jc-1': [s] });
    const storage = createMockStorage();

    const result = await sweepRetention(pool, storage, NOW);

    assert.equal(result.scanned, 1);
    assert.equal(result.deleted, 0);        // within cap, not all delivered → keep
    assert.equal(stamped.length, 0);        // not stamped
    assert.equal(storage.deleted.length, 0); // nothing purged
  });

  it('F-014: deletes an over-30-day completed envelope when timestamps arrive as strings', async () => {
    // Same string wire shape, but past the 30-day hard cap → the backstop must fire.
    const e = envelope({ id: 'oc-1', document_hash: 'hoc', completed_at: new Date('2026-03-15T00:00:00Z') }); // 31 days
    const s = signer({ envelope_id: 'oc-1', signing_token: 'toc', completion_email_delivered_at: null });
    const { pool, stamped } = createMockPool([e], { 'oc-1': [s] });
    const storage = createMockStorage();

    const result = await sweepRetention(pool, storage, NOW);

    assert.equal(result.scanned, 1);
    assert.equal(result.deleted, 1);
    assert.deepEqual(stamped, ['oc-1']);
    assert.deepEqual(storage.deleted.sort(), [COVER('hoc', 'toc'), DOC('hoc')].sort());
  });
});
