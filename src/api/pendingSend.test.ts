/**
 * pendingSend.test.ts — F-40.1/40.4/40.6 route behaviour (AC-238, AC-241, AC-243).
 *
 * The routes are the door, so the door is where the bounds live:
 *   - the write runs the SAME free preflight a guest Send already runs, so an
 *     invalid draft never becomes a stored record;
 *   - a per-address cap stops the surface being used as anonymous storage;
 *   - no read path returns document bytes to an unauthenticated caller;
 *   - the claim is authorized by the SESSION's address, never by possession of
 *     the handle, and produces exactly one envelope.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { DbPool } from '../db/pool.js';
import {
  handleCreatePendingSend,
  handleCreateCeremonyPendingSend,
  handleGetPendingSend,
  handlePatchPendingSend,
  handleClaimPendingSend,
  handleClaimCeremonyPendingSend,
  MAX_LIVE_PENDING_SENDS_PER_ADDRESS,
  type PendingSendCtx,
} from './pendingSend.js';
import type { PendingSendRecord } from '../db/pendingSends.js';

const PDF_B64 = Buffer.from('%PDF-1.4 fake').toString('base64');

/** Composite handle: an id alone authorizes nothing (F-028). */
const HANDLE = 'ps_1.the-secret-half';

const VALID_BODY = {
  email: 'creator@example.com',
  document_name: 'contract',
  pdf_base64: PDF_B64,
  signers: [{ email: 'alice@example.com', name: 'Alice Doe' }],
  auto_close: true,
};

function record(over: Partial<PendingSendRecord> = {}): PendingSendRecord {
  return {
    id: HANDLE,
    boundEmail: 'creator@example.com',
    documentName: 'contract',
    storageKey: 'pending/abc/original.pdf',
    byteCount: 13,
    signers: [{ email: 'alice@example.com', name: 'Alice Doe' }],
    autoClose: true,
    createdAt: new Date('2026-07-25T10:00:00.000Z'),
    expiresAt: new Date('2026-08-01T10:00:00.000Z'),
    claimedAt: null,
    claimedEnvelopeId: null,
    ...over,
  };
}

const noopPool: DbPool = { async query() { return { rows: [], rowCount: 0 } as never; }, async end() {} };

function ctx(over: Partial<PendingSendCtx> = {}): PendingSendCtx {
  return {
    pool: noopPool,
    store: {
      create: mock.fn(async () => 'ps_new'),
      get: mock.fn(async () => record()),
      update: mock.fn(async () => true),
      claim: mock.fn(async () => ({ outcome: 'claimed', record: record() }) as const),
      countLive: mock.fn(async () => 0),
      recordEnvelope: mock.fn(async () => {}),
      release: mock.fn(async () => {}),
      putBlob: mock.fn(async () => {}),
      getBlob: mock.fn(async () => new Uint8Array([1, 2, 3])),
    },
    createEnvelope: mock.fn(async () => ({ status: 200, body: { envelope_id: 'env_new' } })),
    ...over,
  } as PendingSendCtx;
}

describe('POST /v1/pending-send — the gate write (AC-238)', () => {
  it('validates with the SAME preflight a guest Send runs, and stores nothing when it fails', async () => {
    const c = ctx();
    const res = await handleCreatePendingSend(c, { ...VALID_BODY, signers: [{ email: 'nope', name: '' }] });
    assert.equal(res.status, 400);
    assert.equal((c.store.create as ReturnType<typeof mock.fn>).mock.callCount(), 0);
    assert.equal((c.store.putBlob as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });

  it('requires the address the link will be sent to', async () => {
    const c = ctx();
    const res = await handleCreatePendingSend(c, { ...VALID_BODY, email: 'not-an-address' });
    assert.equal(res.status, 400);
    assert.equal((c.store.create as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });

  it('stores the document under a pending/ key and returns only the handle', async () => {
    const c = ctx();
    const res = await handleCreatePendingSend(c, VALID_BODY);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { draft_id: 'ps_new' });
    const put = (c.store.putBlob as ReturnType<typeof mock.fn>).mock.calls[0]!;
    assert.match(put.arguments[0] as string, /^pending\//, 'blob key is namespaced so the sweep can find orphans');
  });

  it('refuses past the per-address cap instead of becoming anonymous storage (AC-243)', async () => {
    const c = ctx();
    (c.store.countLive as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => MAX_LIVE_PENDING_SENDS_PER_ADDRESS,
    );
    const res = await handleCreatePendingSend(c, VALID_BODY);
    assert.equal(res.status, 429);
    assert.equal((c.store.create as ReturnType<typeof mock.fn>).mock.callCount(), 0);
    assert.match(String((res.body as { error: string }).error), /too many/i);
  });

  it('rejects an oversize document at the door', async () => {
    const c = ctx();
    const huge = Buffer.alloc(3_000_001).toString('base64');
    const res = await handleCreatePendingSend(c, { ...VALID_BODY, pdf_base64: huge });
    assert.equal(res.status, 400);
    assert.equal((c.store.putBlob as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });
});

describe('GET /v1/pending-send/:id — identity, never contents (AC-243)', () => {
  it('returns the metadata the restored editor needs and NO bytes', async () => {
    const res = await handleGetPendingSend(ctx(), HANDLE);
    assert.equal(res.status, 200);
    const body = res.body as Record<string, unknown>;
    assert.equal(body.document_name, 'contract');
    assert.equal(body.byte_count, 13);
    assert.deepEqual(body.signers, [{ email: 'alice@example.com', name: 'Alice Doe' }]);
    assert.equal(body.claimed, false);
    assert.equal(body.email, 'creator@example.com', 'so the resend control can prefill it (AC-240)');
    const serialized = JSON.stringify(body);
    assert.ok(!/pdf_base64|storage_key/.test(serialized), 'no byte channel and no internal key');
  });

  it('reports a claimed draft as claimed, so a waiting tab can stop waiting', async () => {
    const c = ctx();
    (c.store.get as ReturnType<typeof mock.fn>).mock.mockImplementation(async () =>
      record({ claimedAt: new Date(), claimedEnvelopeId: 'env_done' }),
    );
    const res = await handleGetPendingSend(c, HANDLE);
    assert.equal((res.body as { claimed: boolean }).claimed, true);
    assert.equal((res.body as { envelope_id?: string }).envelope_id, 'env_done');
  });

  it('404s an unknown handle', async () => {
    const c = ctx();
    (c.store.get as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => null);
    assert.equal((await handleGetPendingSend(c, 'ps_nope.secret')).status, 404);
  });
});

describe('PATCH /v1/pending-send/:id — editable until claimed (AC-241)', () => {
  it('saves a corrected signer address', async () => {
    const c = ctx();
    const res = await handlePatchPendingSend(c, HANDLE, {
      signers: [{ email: 'corrected@example.com', name: 'Alice Doe' }],
    });
    assert.equal(res.status, 200);
    const patch = (c.store.update as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments[1] as {
      signers: Array<{ email: string }>;
    };
    assert.equal(patch.signers[0]!.email, 'corrected@example.com');
  });

  it('runs the edited draft through preflight, so an edit cannot smuggle past validation', async () => {
    const c = ctx();
    const res = await handlePatchPendingSend(c, HANDLE, { signers: [{ email: 'nope', name: '' }] });
    assert.equal(res.status, 400);
    assert.equal((c.store.update as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });

  it('409s once the draft is claimed', async () => {
    const c = ctx();
    (c.store.update as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => false);
    const res = await handlePatchPendingSend(c, HANDLE, { document_name: 'x' });
    assert.equal(res.status, 409);
  });

  it('offers no way to replace the document file', async () => {
    const c = ctx();
    await handlePatchPendingSend(c, HANDLE, { document_name: 'x', pdf_base64: PDF_B64 } as Record<string, unknown>);
    const patch = (c.store.update as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments[1] as Record<string, unknown>;
    assert.ok(!('pdf_base64' in patch) && !('storageKey' in patch));
  });
});

describe('POST /v1/pending-send/:id/claim — one envelope, ever (AC-238)', () => {
  it('claims, creates, and records the envelope', async () => {
    const c = ctx();
    const res = await handleClaimPendingSend(c, HANDLE, 'creator@example.com');
    assert.equal(res.status, 200);
    assert.equal((res.body as { envelope_id: string }).envelope_id, 'env_new');
    assert.equal((c.store.recordEnvelope as ReturnType<typeof mock.fn>).mock.callCount(), 1);
    assert.equal((c.store.release as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });

  it('a loser gets the winner\'s envelope, not a second one', async () => {
    const c = ctx();
    (c.store.claim as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => ({
      outcome: 'already',
      envelopeId: 'env_first',
    }));
    const res = await handleClaimPendingSend(c, HANDLE, 'creator@example.com');
    assert.equal(res.status, 200);
    assert.equal((res.body as { envelope_id: string }).envelope_id, 'env_first');
    assert.equal((res.body as { already_sent: boolean }).already_sent, true);
    assert.equal((c.createEnvelope as ReturnType<typeof mock.fn>).mock.callCount(), 0, 'no second create');
  });

  it('refuses a session for a different address', async () => {
    const c = ctx();
    (c.store.claim as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => ({ outcome: 'wrong_account' }));
    const res = await handleClaimPendingSend(c, HANDLE, 'someone@else.com');
    assert.equal(res.status, 403);
    assert.equal((c.createEnvelope as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });

  it('RELEASES the claim when the create fails, so the visitor can retry', async () => {
    const c = ctx();
    (c.createEnvelope as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => {
      throw new Error('boom');
    });
    await assert.rejects(() => handleClaimPendingSend(c, HANDLE, 'creator@example.com'));
    assert.equal((c.store.release as ReturnType<typeof mock.fn>).mock.callCount(), 1);
    assert.equal((c.store.recordEnvelope as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });

  it('releases the claim when the create returns a REFUSAL too (no credit, allowlist)', async () => {
    const c = ctx();
    (c.createEnvelope as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => ({
      status: 402,
      body: { error: 'Insufficient credit', code: 'credit_insufficient' },
    }));
    const res = await handleClaimPendingSend(c, HANDLE, 'creator@example.com');
    assert.equal(res.status, 402);
    assert.equal((c.store.release as ReturnType<typeof mock.fn>).mock.callCount(), 1, 'a refused send is retryable');
    assert.equal((c.store.recordEnvelope as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });

  it('reports an expired draft distinctly rather than as a generic failure', async () => {
    const c = ctx();
    (c.store.claim as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => ({ outcome: 'expired' }));
    const res = await handleClaimPendingSend(c, HANDLE, 'creator@example.com');
    assert.equal(res.status, 409);
    assert.equal((res.body as { code: string }).code, 'state_pending_send_expired');
  });
});

// ── F-028 (red team cycle 22, P0) ────────────────────────────────────────────
// `GET /v1/pending-send/:id` returned the creator's address and the whole signer
// list to anyone holding an id, with no authentication at all — and a claimed
// record still resolved in full. Both are pinned here at the door.
describe('F-028 — a bare id is not a capability', () => {
  it('404s a handle with no secret half, without ever reaching the store', async () => {
    const c = ctx();
    const res = await handleGetPendingSend(c, 'ps_3f2a9c14-8b7e-4d1a-9f60-5c2e7a1b8d34');
    assert.equal(res.status, 404);
    assert.equal((c.store.get as ReturnType<typeof mock.fn>).mock.callCount(), 0, 'no read is even attempted');
  });

  it('passes the secret to the store, so authorization is not the route\'s to fake', async () => {
    const c = ctx();
    await handleGetPendingSend(c, HANDLE);
    const call = (c.store.get as ReturnType<typeof mock.fn>).mock.calls[0]!;
    assert.equal(call.arguments[0], 'ps_1');
    assert.equal(call.arguments[1], 'the-secret-half');
  });

  it('refuses an EDIT on a bare id too', async () => {
    const c = ctx();
    const res = await handlePatchPendingSend(c, 'ps_3f2a9c14-8b7e-4d1a-9f60-5c2e7a1b8d34', { document_name: 'x' });
    assert.equal(res.status, 404);
    assert.equal((c.store.update as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });

  it('gives a wrong secret the SAME answer as a missing draft (no oracle)', async () => {
    const c = ctx();
    (c.store.get as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => null);
    const wrong = await handleGetPendingSend(c, 'ps_1.wrong-secret');
    const missing = await handleGetPendingSend(c, 'ps_gone.some-secret');
    assert.deepEqual(wrong, missing);
  });

  it('uses only the ID half for the claim, where the SESSION is the authority', async () => {
    const c = ctx();
    await handleClaimPendingSend(c, HANDLE, 'creator@example.com');
    assert.equal((c.store.claim as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments[0], 'ps_1');
  });
});

describe('ceremony-bound doors (F-41.6 / DD-59)', () => {
  it('creates a CEREMONY-bound pending send: no email required, ceremony create used, handle returned', async () => {
    const c = ctx();
    (c.store as unknown as Record<string, unknown>).createCeremony = mock.fn(async () => 'ps_cer.secret-half');
    const r = await handleCreateCeremonyPendingSend(c, { ...VALID_BODY });
    assert.equal(r.status, 200);
    assert.equal((r.body as { draft_id?: string }).draft_id, 'ps_cer.secret-half');
    const createCeremony = (c.store as unknown as { createCeremony: ReturnType<typeof mock.fn> }).createCeremony;
    assert.equal(createCeremony.mock.callCount(), 1);
    assert.equal((c.store.create as ReturnType<typeof mock.fn>).mock.callCount(), 0, 'never the email-bound create');
  });

  it('runs the same preflight: an invalid ceremony draft stores nothing', async () => {
    const c = ctx();
    (c.store as unknown as Record<string, unknown>).createCeremony = mock.fn(async () => 'ps_cer.secret');
    const r = await handleCreateCeremonyPendingSend(c, { ...VALID_BODY, signers: [] });
    assert.equal(r.status, 400);
    assert.equal((c.store.putBlob as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });

  it('bounds live ceremony drafts (the anonymous-storage backstop)', async () => {
    const c = ctx();
    (c.store as unknown as Record<string, unknown>).createCeremony = mock.fn(async () => 'ps_cer.secret');
    (c.store.countLive as unknown as ReturnType<typeof mock.fn>).mock.mockImplementation(async () => 200);
    const r = await handleCreateCeremonyPendingSend(c, { ...VALID_BODY });
    assert.equal(r.status, 429);
    assert.equal((r.body as { code?: string }).code, 'rate_size_pending_sends');
  });

  it('claims a ceremony draft for the establishing session and creates the envelope', async () => {
    const c = ctx();
    (c.store.claim as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => ({ outcome: 'claimed', record: record({ boundEmail: 'fresh@example.com' }) }) as const,
    );
    const r = await handleClaimCeremonyPendingSend(c, HANDLE, 'fresh@example.com');
    assert.equal(r.status, 200);
    assert.equal((r.body as { envelope_id?: string }).envelope_id, 'env_new');
    const [id, secret, email] = (c.store.claim as ReturnType<typeof mock.fn>).mock.calls[0]!
      .arguments as [string, string, string];
    assert.equal(id, 'ps_1');
    assert.equal(secret, 'the-secret-half', 'the handle secret authorizes the bind');
    assert.equal(email, 'fresh@example.com');
  });

  it('a create REFUSAL releases the ceremony claim and reports the refusal (F-39.4)', async () => {
    const c = ctx({ createEnvelope: mock.fn(async () => ({ status: 402, body: { code: 'payment_insufficient_credit' } })) });
    (c.store.claim as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => ({ outcome: 'claimed', record: record({ boundEmail: 'fresh@example.com' }) }) as const,
    );
    const r = await handleClaimCeremonyPendingSend(c, HANDLE, 'fresh@example.com');
    assert.equal(r.status, 402);
    assert.equal((c.store.release as ReturnType<typeof mock.fn>).mock.callCount(), 1);
  });

  it('an already-claimed ceremony draft answers already_sent with its envelope (a success, not an error)', async () => {
    const c = ctx();
    (c.store.claim as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => ({ outcome: 'already', envelopeId: 'env_prior' }) as const,
    );
    const r = await handleClaimCeremonyPendingSend(c, HANDLE, 'fresh@example.com');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { envelope_id: 'env_prior', already_sent: true });
  });
});

describe('a ceremony-bound draft must be finishable by EITHER method (AC-252)', () => {
  // AC-252: "completing sign-in from there by EITHER method sends that same
  // draft exactly once." A visitor who abandons Google at its consent screen
  // and switches to the emailed link must not hit a dead end. Before the claim
  // paths were unified, the session claim matched on bound_email, and a
  // ceremony row's sentinel binding could never match a real address — a 403
  // "started for a different email address" on the visitor's own document.
  it('the emailed-link claim and the ceremony claim are the SAME secret-authorized door', async () => {
    const c = ctx();
    (c.store.claim as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async (_id: string, _secret: string, sessionEmail: string) =>
        ({ outcome: 'claimed', record: record({ boundEmail: sessionEmail }) }) as const,
    );
    const viaLink = await handleClaimPendingSend(c, HANDLE, 'visitor@example.com');
    assert.equal(viaLink.status, 200, 'finishing by email after abandoning Google must work');
    assert.equal((viaLink.body as { envelope_id?: string }).envelope_id, 'env_new');
    // Both entry points carry the secret through, so neither can drift.
    const args = (c.store.claim as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments;
    assert.equal(args[1], 'the-secret-half');
    assert.equal(handleClaimCeremonyPendingSend, handleClaimPendingSend, 'one door, two names');
  });
});
