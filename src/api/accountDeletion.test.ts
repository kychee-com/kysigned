/**
 * Account deletion tests — DPA Section 11 commitment / F-013.
 *
 * "Off-chain personal data is deleted in full within 30 days of a customer's
 * deletion request." This is a hard contractual commitment, so the procedure
 * is end-to-end tested and returns a verifiable report on completion.
 *
 * Scope of deletion:
 *   - Every envelope where the identity is the sender (by email)
 *   - Every envelope_signers row attached to those envelopes
 *   - Every stored blob for each envelope — the shared document D AND each
 *     per-signer cover, at their REAL document_hash/signing_token keys (F-013:
 *     the old code deleted a null pdf_storage_key, so the document blob was never
 *     purged), skipping any already-ephemerally-deleted and retaining a shared
 *     content-addressed document another creator still needs
 *   - The identity's row in allowed_senders + allowed_sender_usage
 *
 * Evidence bundles already delivered to other parties are NOT recallable.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deleteAccount, verifyDeletion } from './accountDeletion.js';
import type { DbPool } from '../db/pool.js';

const DOC = (h: string) => `envelopes/${h}/document.pdf`;
const COVER = (h: string, t: string) => `envelopes/${h}/cover-${t}.pdf`;

interface MockState {
  envelopes: any[]; // { id, sender_email, document_hash, pdf_deleted_at }
  signers: any[]; // { envelope_id, signing_token }
  allowed: any[];
  usage: any[];
}

function createMockPool(state: MockState) {
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as any[];

      // Verification COUNT branches (must precede the SELECT ... FROM envelopes branch).
      if (text.includes('SELECT COUNT(*) FROM envelope_signers')) {
        return { rows: [{ count: '0' }] } as any;
      }
      if (text.includes('SELECT COUNT(*) FROM envelopes')) {
        const count = state.envelopes.filter((e) => e.sender_email === v[0]).length;
        return { rows: [{ count: String(count) }] } as any;
      }
      if (text.includes('SELECT COUNT(*) FROM allowed_senders')) {
        const count = state.allowed.filter((a) => a.identity === v[0]).length;
        return { rows: [{ count: String(count) }] } as any;
      }
      if (text.includes('SELECT COUNT(*) FROM allowed_sender_usage')) {
        const count = state.usage.filter((u) => u.identity === v[0]).length;
        return { rows: [{ count: String(count) }] } as any;
      }

      // purgeEnvelopeBlobs' shared-document guard: is any OTHER envelope still
      // referencing this document_hash (pdf_deleted_at null)? Runs after rows are
      // deleted, so it sees only survivors.
      if (text.includes('FROM envelopes') && text.includes('document_hash')) {
        const [docHash, selfId] = v;
        const sibling = state.envelopes.find(
          (e) => e.document_hash === docHash && e.id !== selfId && !e.pdf_deleted_at,
        );
        return { rows: sibling ? [{ one: 1 }] : [] } as any;
      }

      // Gather signers (their tokens key the covers) — before the DELETE below.
      if (text.includes('SELECT envelope_id, signing_token FROM envelope_signers')) {
        const ids = v[0] as string[];
        return { rows: state.signers.filter((s) => ids.includes(s.envelope_id)) } as any;
      }

      // Find envelopes by sender identity.
      if (text.includes('FROM envelopes') && text.includes('sender_email')) {
        return { rows: state.envelopes.filter((e) => e.sender_email === v[0]) } as any;
      }
      // Delete signer rows.
      if (text.includes('DELETE FROM envelope_signers WHERE envelope_id = ANY')) {
        const ids = v[0] as string[];
        const before = state.signers.length;
        state.signers = state.signers.filter((s) => !ids.includes(s.envelope_id));
        return { rows: [], rowCount: before - state.signers.length } as any;
      }
      // Delete envelope rows.
      if (text.includes('DELETE FROM envelopes WHERE id = ANY')) {
        const ids = v[0] as string[];
        const before = state.envelopes.length;
        state.envelopes = state.envelopes.filter((e) => !ids.includes(e.id));
        return { rows: [], rowCount: before - state.envelopes.length } as any;
      }
      // Delete allowlist / usage.
      if (text.includes('DELETE FROM allowed_senders WHERE identity')) {
        const before = state.allowed.length;
        state.allowed = state.allowed.filter((a) => a.identity !== v[0]);
        return { rows: [], rowCount: before - state.allowed.length } as any;
      }
      if (text.includes('DELETE FROM allowed_sender_usage WHERE identity')) {
        const before = state.usage.length;
        state.usage = state.usage.filter((u) => u.identity !== v[0]);
        return { rows: [], rowCount: before - state.usage.length } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    },
    async end() {},
  };
  return pool;
}

function createStorage(failKeys: Set<string> = new Set()) {
  const deleted: string[] = [];
  return {
    deleted,
    async deletePdf(key: string) {
      if (failKeys.has(key)) throw new Error(`fail ${key}`);
      deleted.push(key); // idempotent in prod — a missing key is a no-op success
    },
  };
}

function makeState(): MockState {
  return { envelopes: [], signers: [], allowed: [], usage: [] };
}

describe('deleteAccount — DPA Section 11 / F-013', () => {
  it('returns a zero report for an identity with no data', async () => {
    const state = makeState();
    const report = await deleteAccount(createMockPool(state), createStorage(), 'email', 'unknown@t.com');
    assert.equal(report.envelopes_deleted, 0);
    assert.equal(report.signers_deleted, 0);
    assert.equal(report.pdfs_deleted, 0);
    assert.equal(report.allowed_sender_rows_deleted, 0);
    assert.equal(report.usage_rows_deleted, 0);
  });

  it('purges the document D + every cover for a creator (real keys, not pdf_storage_key)', async () => {
    const state = makeState();
    state.envelopes = [
      { id: 'e1', sender_email: 'alice@t.com', document_hash: 'ha', pdf_deleted_at: null },
      { id: 'e2', sender_email: 'alice@t.com', document_hash: 'hb', pdf_deleted_at: null },
      { id: 'e3', sender_email: 'other@t.com', document_hash: 'hc', pdf_deleted_at: null },
    ];
    state.signers = [
      { envelope_id: 'e1', signing_token: 'a1' },
      { envelope_id: 'e1', signing_token: 'a2' },
      { envelope_id: 'e2', signing_token: 'b1' },
      { envelope_id: 'e3', signing_token: 'c1' },
    ];
    state.allowed = [
      { identity_type: 'email', identity: 'alice@t.com' },
      { identity_type: 'email', identity: 'other@t.com' },
    ];
    state.usage = [
      { identity_type: 'email', identity: 'alice@t.com', period: '2026-04' },
      { identity_type: 'email', identity: 'alice@t.com', period: '2026-03' },
      { identity_type: 'email', identity: 'other@t.com', period: '2026-04' },
    ];

    const storage = createStorage();
    const report = await deleteAccount(createMockPool(state), storage, 'email', 'alice@t.com');

    assert.equal(report.envelopes_deleted, 2);
    assert.equal(report.signers_deleted, 3);
    // e1: doc(ha) + cover(a1) + cover(a2) = 3; e2: doc(hb) + cover(b1) = 2 → 5 blobs.
    assert.equal(report.pdfs_deleted, 5);
    assert.deepEqual(storage.deleted.sort(), [
      DOC('ha'), COVER('ha', 'a1'), COVER('ha', 'a2'),
      DOC('hb'), COVER('hb', 'b1'),
    ].sort());
    assert.equal(report.allowed_sender_rows_deleted, 1);
    assert.equal(report.usage_rows_deleted, 2);

    // Other creator untouched — never deleted their document.
    assert.ok(!storage.deleted.includes(DOC('hc')));
    assert.equal(state.envelopes.length, 1);
    assert.equal(state.envelopes[0].id, 'e3');
  });

  it('retains a document still shared by ANOTHER creator (content-addressed dedup)', async () => {
    const state = makeState();
    // alice + carol both uploaded the same file → same document_hash 'shared'.
    state.envelopes = [
      { id: 'e1', sender_email: 'alice@t.com', document_hash: 'shared', pdf_deleted_at: null },
      { id: 'e2', sender_email: 'carol@t.com', document_hash: 'shared', pdf_deleted_at: null },
    ];
    state.signers = [
      { envelope_id: 'e1', signing_token: 'a1' },
      { envelope_id: 'e2', signing_token: 'c1' },
    ];
    const storage = createStorage();
    const report = await deleteAccount(createMockPool(state), storage, 'email', 'alice@t.com');

    assert.equal(report.envelopes_deleted, 1);
    // alice's cover is freed; the SHARED document is retained (carol still needs it).
    assert.deepEqual(storage.deleted, [COVER('shared', 'a1')]);
    assert.ok(!storage.deleted.includes(DOC('shared')));
    assert.equal(report.pdfs_deleted, 1);
  });

  it('skips blobs already ephemerally deleted (pdf_deleted_at set)', async () => {
    const state = makeState();
    state.envelopes = [
      { id: 'e1', sender_email: 'alice@t.com', document_hash: 'ha', pdf_deleted_at: new Date() },
    ];
    state.signers = [{ envelope_id: 'e1', signing_token: 'a1' }];
    const storage = createStorage();
    const report = await deleteAccount(createMockPool(state), storage, 'email', 'alice@t.com');
    assert.equal(report.envelopes_deleted, 1);
    assert.equal(report.pdfs_deleted, 0); // already freed by retention
    assert.equal(storage.deleted.length, 0);
  });

  it('counts but does not abort when a single blob delete fails', async () => {
    const state = makeState();
    state.envelopes = [
      { id: 'e1', sender_email: 'alice@t.com', document_hash: 'ha', pdf_deleted_at: null },
      { id: 'e2', sender_email: 'alice@t.com', document_hash: 'hb', pdf_deleted_at: null },
    ];
    state.signers = [
      { envelope_id: 'e1', signing_token: 'a1' },
      { envelope_id: 'e2', signing_token: 'b1' },
    ];
    const storage = createStorage(new Set([DOC('ha')])); // e1's document delete throws
    const report = await deleteAccount(createMockPool(state), storage, 'email', 'alice@t.com');
    assert.equal(report.envelopes_deleted, 2);
    // cover(a1) + doc(hb) + cover(b1) succeed = 3; doc(ha) fails = 1.
    assert.equal(report.pdfs_deleted, 3);
    assert.equal(report.pdf_delete_failures, 1);
  });
});

describe('verifyDeletion — DPA Section 11', () => {
  it('returns ok=true when no data remains', async () => {
    const state = makeState();
    const result = await verifyDeletion(createMockPool(state), 'email', 'alice@t.com');
    assert.equal(result.ok, true);
    assert.equal(result.envelopes_remaining, 0);
    assert.equal(result.allowed_sender_rows_remaining, 0);
  });

  it('returns ok=false when envelopes still exist', async () => {
    const state = makeState();
    state.envelopes = [{ id: 'e1', sender_email: 'alice@t.com' }];
    const result = await verifyDeletion(createMockPool(state), 'email', 'alice@t.com');
    assert.equal(result.ok, false);
    assert.equal(result.envelopes_remaining, 1);
  });

  it('returns ok=false when allowlist row still exists', async () => {
    const state = makeState();
    state.allowed = [{ identity_type: 'email', identity: 'alice@t.com' }];
    const result = await verifyDeletion(createMockPool(state), 'email', 'alice@t.com');
    assert.equal(result.ok, false);
    assert.equal(result.allowed_sender_rows_remaining, 1);
  });
});
