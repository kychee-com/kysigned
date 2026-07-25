/**
 * pendingSends.test.ts — F-40.1 / F-40.6 (AC-238, AC-243), the store that lets
 * the tab a visitor LANDS in finish the send.
 *
 * The invariants under test are the ones the whole handover rests on:
 *   - a claim is atomic and single-winner, so two tabs racing cannot produce
 *     two envelopes or two credit movements;
 *   - the draft OUTLIVES the 15-minute sign-in link (7 days), because the most
 *     common failure IS the link expiring and a same-TTL draft would leave
 *     nothing to restore;
 *   - only a session for the bound address may claim;
 *   - a create that fails AFTER the claim releases it, so the visitor can retry
 *     rather than owning a draft nobody can send.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DbPool } from './pool.js';
import {
  createPendingSend,
  getPendingSend,
  updatePendingSendDraft,
  claimPendingSend,
  recordClaimedEnvelope,
  releasePendingSendClaim,
  deleteFinishedPendingSends,
  PENDING_SEND_TTL_MS,
  MAGIC_LINK_TTL_MS,
  hashRestoreSecret,
  parseHandle,
} from './pendingSends.js';

/** The secret half of a handle. The stored row keeps only its hash (F-028). */
const SECRET = 'test-secret-value-0123456789abcdef';

interface Captured {
  text: string;
  values: unknown[];
}

function capturePool(handler: (text: string, values: unknown[]) => { rows: unknown[]; rowCount: number } | null) {
  const queries: Captured[] = [];
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as unknown[];
      queries.push({ text, values: v });
      return (handler(text, v) ?? { rows: [], rowCount: 0 }) as never;
    },
    async end() {},
  };
  return { pool, queries };
}

const DRAFT = {
  documentName: 'contract',
  storageKey: 'envelopes/abc123/original.pdf',
  byteCount: 4096,
  signers: [{ email: 'alice@example.com', name: 'Alice Doe' }],
  autoClose: true,
};

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'ps_1',
    bound_email: 'creator@example.com',
    document_name: 'contract',
    storage_key: DRAFT.storageKey,
    byte_count: 4096,
    draft: { signers: DRAFT.signers, auto_close: true },
    created_at: '2026-07-25T10:00:00.000Z',
    expires_at: '2026-08-01T10:00:00.000Z',
    claimed_at: null,
    claimed_envelope_id: null,
    restore_token_hash: hashRestoreSecret(SECRET),
    ...over,
  };
}

describe('pending-send retention window (F-40.3 depends on it)', () => {
  it('OUTLIVES the sign-in link, which is the whole point of the failure path', () => {
    assert.ok(
      PENDING_SEND_TTL_MS > MAGIC_LINK_TTL_MS,
      'a draft that dies with its link leaves nothing to restore when the link expires',
    );
    assert.equal(PENDING_SEND_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  });
});

describe('createPendingSend', () => {
  it('binds the LOWERCASED address and stamps an expiry from the TTL', async () => {
    const now = new Date('2026-07-25T10:00:00.000Z');
    const { pool, queries } = capturePool(() => ({ rows: [row()], rowCount: 1 }));
    const handle = await createPendingSend(pool, ' Creator@Example.COM ', DRAFT, { now, secret: 'S'.repeat(43) });
    const id = handle.split('.')[0];
    const insert = queries.find((q) => q.text.includes('INSERT INTO pending_sends'));
    assert.ok(insert, 'wrote the pending send');
    assert.equal(insert!.values[0], id, 'the handle is minted here, not assigned by the database');
    assert.ok(handle.includes('.'), 'the visitor gets id.secret, never a bare id (F-028)');
    assert.ok(!(insert!.values as string[]).includes('S'.repeat(43)), 'the RAW secret is never stored');
    assert.match(
      id,
      /^ps_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      'the handle is unguessable — it travels in a URL (DD-57)',
    );
    assert.equal(insert!.values[1], 'creator@example.com', 'bound address is normalized to lowercase');
    assert.equal(
      new Date(insert!.values[6] as string).getTime(),
      now.getTime() + PENDING_SEND_TTL_MS,
      'expiry is now + the 7-day TTL',
    );
  });

  it('stores the signer set as one JSON draft column, never as loose signer rows', async () => {
    const { pool, queries } = capturePool(() => ({ rows: [row()], rowCount: 1 }));
    await createPendingSend(pool, 'creator@example.com', DRAFT);
    const insert = queries.find((q) => q.text.includes('INSERT INTO pending_sends'))!;
    const draft = JSON.parse(insert.values[5] as string) as { signers: unknown[]; auto_close: boolean };
    assert.deepEqual(draft.signers, DRAFT.signers);
    assert.equal(draft.auto_close, true);
    assert.equal(queries.length, 1, 'exactly one statement — no per-signer inserts');
  });
});

describe('getPendingSend', () => {
  it('returns the draft metadata including byte count, and NEVER selects bytes', async () => {
    const { pool, queries } = capturePool(() => ({ rows: [row()], rowCount: 1 }));
    const found = await getPendingSend(pool, 'ps_1', SECRET);
    assert.equal(found?.documentName, 'contract');
    assert.equal(found?.byteCount, 4096);
    assert.deepEqual(found?.signers, DRAFT.signers);
    assert.equal(found?.claimedAt, null);
    // The bytes live in pdf_blobs and are reachable only via the storage key at
    // claim time — no read path here can return them (AC-243).
    assert.ok(!queries.some((q) => /bytes_b64|pdf_blobs/i.test(q.text)));
  });

  it('returns null for an unknown id', async () => {
    const { pool } = capturePool(() => ({ rows: [], rowCount: 0 }));
    assert.equal(await getPendingSend(pool, 'ps_nope', SECRET), null);
  });
});

describe('updatePendingSendDraft — editable until claimed (F-40.4)', () => {
  it('updates the metadata and refuses once claimed or expired, in the statement itself', async () => {
    const { pool, queries } = capturePool(() => ({ rows: [row()], rowCount: 1 }));
    const ok = await updatePendingSendDraft(pool, 'ps_1', {
      documentName: 'contract v2',
      signers: [{ email: 'corrected@example.com', name: 'Alice Doe' }],
      autoClose: false,
    }, SECRET);
    assert.equal(ok, true);
    const update = queries.find((q) => q.text.includes('UPDATE pending_sends'))!;
    assert.match(update.text, /claimed_at IS NULL/, 'a claimed draft can never be edited');
    assert.match(update.text, /expires_at >/, 'an expired draft can never be edited');
    assert.ok(
      !/storage_key|byte_count/.test(update.text.split('WHERE')[0]!),
      'the document file is immutable for the life of the pending send',
    );
  });

  it('reports false when nothing was updated (claimed, expired, or gone)', async () => {
    const { pool } = capturePool(() => ({ rows: [], rowCount: 0 }));
    assert.equal(await updatePendingSendDraft(pool, 'ps_1', { documentName: 'x' }, SECRET), false);
  });
});

describe('claimPendingSend — one winner, ever (AC-238)', () => {
  it('claims with a single conditional UPDATE and returns the draft', async () => {
    const { pool, queries } = capturePool((text) =>
      text.startsWith('UPDATE') ? { rows: [row({ claimed_at: '2026-07-25T10:05:00.000Z' })], rowCount: 1 } : null,
    );
    const result = await claimPendingSend(pool, 'ps_1', 'Creator@Example.com');
    assert.equal(result.outcome, 'claimed');
    assert.equal(result.outcome === 'claimed' ? result.record.documentName : '', 'contract');
    const claim = queries[0]!;
    assert.match(claim.text, /UPDATE pending_sends[\s\S]*SET claimed_at/);
    assert.match(claim.text, /claimed_at IS NULL/, 'the race is settled by the WHERE clause, not by a read');
    assert.match(claim.text, /RETURNING/, 'the winner learns it won from the same statement');
    assert.equal(claim.values[2], 'creator@example.com', 'compared lowercased');
  });

  it('a second claim wins nothing and reports the envelope the first one created', async () => {
    let call = 0;
    const { pool } = capturePool((text) => {
      if (text.startsWith('UPDATE')) return { rows: [], rowCount: 0 };
      call += 1;
      return { rows: [row({ claimed_at: '2026-07-25T10:05:00.000Z', claimed_envelope_id: 'env_first' })], rowCount: 1 };
    });
    const result = await claimPendingSend(pool, 'ps_1', 'creator@example.com');
    assert.equal(result.outcome, 'already');
    assert.equal(result.outcome === 'already' ? result.envelopeId : null, 'env_first');
    assert.equal(call, 1, 'falls back to exactly one read to find out why it lost');
  });

  it('refuses a session for a DIFFERENT address rather than reporting "already"', async () => {
    const { pool } = capturePool((text) =>
      text.startsWith('UPDATE') ? { rows: [], rowCount: 0 } : { rows: [row()], rowCount: 1 },
    );
    const result = await claimPendingSend(pool, 'ps_1', 'someone-else@example.com');
    assert.equal(result.outcome, 'wrong_account');
  });

  it('reports expiry distinctly, so the caller can say so plainly', async () => {
    const { pool } = capturePool((text) =>
      text.startsWith('UPDATE')
        ? { rows: [], rowCount: 0 }
        : { rows: [row({ expires_at: '2026-07-24T10:00:00.000Z' })], rowCount: 1 },
    );
    const result = await claimPendingSend(pool, 'ps_1', 'creator@example.com', {
      now: new Date('2026-07-25T10:00:00.000Z'),
    });
    assert.equal(result.outcome, 'expired');
  });

  it('reports a missing draft as not_found', async () => {
    const { pool } = capturePool(() => ({ rows: [], rowCount: 0 }));
    const result = await claimPendingSend(pool, 'ps_gone', 'creator@example.com');
    assert.equal(result.outcome, 'not_found');
  });
});

describe('claim bookkeeping', () => {
  it('records the envelope the claim produced', async () => {
    const { pool, queries } = capturePool(() => ({ rows: [], rowCount: 1 }));
    await recordClaimedEnvelope(pool, 'ps_1', 'env_new');
    assert.match(queries[0]!.text, /SET claimed_envelope_id/);
    assert.deepEqual(queries[0]!.values, ['ps_1', 'env_new']);
  });

  it('releases the claim when the create FAILED, but never one that already produced an envelope', async () => {
    const { pool, queries } = capturePool(() => ({ rows: [], rowCount: 1 }));
    await releasePendingSendClaim(pool, 'ps_1');
    assert.match(queries[0]!.text, /SET claimed_at = NULL/);
    assert.match(
      queries[0]!.text,
      /claimed_envelope_id IS NULL/,
      'a claim that produced an envelope must never be released back',
    );
  });
});

describe('deleteFinishedPendingSends — held no longer than the job needs (AC-243)', () => {
  it('deletes claimed and expired rows, then the blobs nothing else references', async () => {
    const { pool, queries } = capturePool(() => ({ rows: [], rowCount: 2 }));
    const removed = await deleteFinishedPendingSends(pool, new Date('2026-08-02T10:00:00.000Z'));
    assert.equal(removed, 2);
    const del = queries.find((q) => q.text.includes('DELETE FROM pending_sends'))!;
    assert.match(del.text, /claimed_envelope_id IS NOT NULL OR expires_at <=/);
    const blobs = queries.find((q) => q.text.includes('DELETE FROM pdf_blobs'))!;
    assert.ok(blobs, 'orphan blobs are swept too');
    assert.match(blobs.text, /NOT EXISTS[\s\S]*envelopes/, 'never deletes a blob a real envelope still points at');
    assert.match(blobs.text, /NOT EXISTS[\s\S]*pending_sends/, 'never deletes a blob a live draft still points at');
  });
});

// ── F-028 (red team cycle 22, P0) ────────────────────────────────────────────
// The first cut treated the row's `id` as a capability, so anyone holding one
// read the creator's address and the whole signer list unauthenticated. An id is
// not a secret: it rides `?draft=` in the URL bar, sits in browser history, and
// is echoed in claim requests and logs. These pin the fix.
describe('F-028 — an id alone reads nothing', () => {
  it('splits the handle into an id and a secret, and rejects a bare id', () => {
    assert.deepEqual(parseHandle('ps_abc.sekrit'), { id: 'ps_abc', secret: 'sekrit' });
    assert.equal(parseHandle('ps_abc'), null, 'a bare id is not a handle');
    assert.equal(parseHandle('.sekrit'), null);
    assert.equal(parseHandle('ps_abc.'), null);
  });

  it('refuses a read whose secret does not match the stored hash', async () => {
    const { pool } = capturePool(() => ({ rows: [row()], rowCount: 1 }));
    assert.equal(await getPendingSend(pool, 'ps_1', 'not-the-secret'), null);
    assert.ok(await getPendingSend(pool, 'ps_1', SECRET), 'the right secret still reads');
  });

  it('refuses a read on a row with NO stored hash (a pre-fix row is inert)', async () => {
    const { pool } = capturePool(() => ({ rows: [row({ restore_token_hash: null })], rowCount: 1 }));
    assert.equal(await getPendingSend(pool, 'ps_1', SECRET), null);
  });

  it('binds the edit to the secret in the statement, not in a prior read', async () => {
    const { pool, queries } = capturePool(() => ({ rows: [], rowCount: 0 }));
    await updatePendingSendDraft(pool, 'ps_1', { documentName: 'x' }, SECRET);
    const update = queries.find((q) => q.text.includes('UPDATE pending_sends'))!;
    assert.match(update.text, /restore_token_hash = \$6/);
    assert.ok((update.values as string[]).includes(hashRestoreSecret(SECRET)));
    assert.ok(!(update.values as string[]).includes(SECRET), 'the raw secret never reaches the database');
  });

  it('REDACTS the draft the moment it is claimed, leaving only a receipt', async () => {
    const { pool, queries } = capturePool(() => ({ rows: [], rowCount: 1 }));
    await recordClaimedEnvelope(pool, 'ps_1', 'env_new');
    const q = queries[0]!.text;
    assert.match(q, /SET claimed_envelope_id/);
    for (const col of ['bound_email', 'document_name', 'storage_key', 'draft']) {
      assert.match(q, new RegExp(`${col} =`), `${col} must be cleared on claim (AC-243)`);
    }
  });
});
