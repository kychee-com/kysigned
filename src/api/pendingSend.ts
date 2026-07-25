/**
 * pendingSend — F-40 route handlers (DD-56/DD-57), the four doors of the handover.
 *
 *   POST   /v1/pending-send            the gate's write (public)
 *   GET    /v1/pending-send/:id        metadata for the restored editor (public by handle)
 *   PATCH  /v1/pending-send/:id        edit while unclaimed (public by handle)
 *   POST   /v1/pending-send/:id/claim  claim + create (SESSION)
 *
 * The first three are reachable without a session, because the visitor holding
 * a draft does not have one yet — that is the whole point. So the bounds live at
 * the door:
 *
 *   - every write runs the SAME free preflight a guest Send already runs, so an
 *     invalid draft never becomes a stored record;
 *   - a per-address cap on LIVE drafts stops the surface being used as anonymous
 *     storage (counted in the database, since a Lambda has no shared memory to
 *     hold a counter across cold starts);
 *   - no read path returns document bytes — only the claim reads them, and only
 *     to hand them to the create;
 *   - the claim is authorized by the SESSION's address matching the binding,
 *     never by possession of the handle (DD-57). The handle rides a URL; it is
 *     a pointer, not a credential.
 *
 * The store + create are injected so the entry can wire the real DAO while the
 * tests drive every branch, including the two that matter most: a create that
 * THROWS and a create that REFUSES both release the claim, so a visitor is never
 * left owning a draft nobody can send.
 */
import type { DbPool } from '../db/pool.js';
import { handleCreatePreflight } from './createPreflight.js';
import { isUploadTooLarge, uploadTooLargeMessage } from './uploadGuard.js';
import { decodePdfBase64, computePdfHash } from '../pdf/hash.js';
import type { ClaimResult, PendingSendPatch, PendingSendRecord, PendingSigner } from '../db/pendingSends.js';

/** Live (unclaimed, unexpired) drafts one address may hold at once. */
export const MAX_LIVE_PENDING_SENDS_PER_ADDRESS = 5;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface PendingSendStore {
  create(boundEmail: string, draft: Omit<PendingSendRecord, 'id' | 'boundEmail' | 'createdAt' | 'expiresAt' | 'claimedAt' | 'claimedEnvelopeId'>): Promise<string>;
  get(id: string): Promise<PendingSendRecord | null>;
  update(id: string, patch: PendingSendPatch): Promise<boolean>;
  claim(id: string, sessionEmail: string): Promise<ClaimResult>;
  countLive(boundEmail: string): Promise<number>;
  recordEnvelope(id: string, envelopeId: string): Promise<void>;
  release(id: string): Promise<void>;
  putBlob(storageKey: string, bytes: Uint8Array): Promise<void>;
  getBlob(storageKey: string): Promise<Uint8Array | null>;
}

export interface PendingSendResult {
  status: number;
  body: Record<string, unknown>;
}

export interface PendingSendCtx {
  pool: DbPool;
  store: PendingSendStore;
  /**
   * The ordinary authenticated create, invoked on the claimant's behalf. Kept as
   * a seam so the claim path cannot drift from the create every other caller
   * uses (credit gate, allowlist, delivery — all unchanged).
   */
  createEnvelope(actorEmail: string, request: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
}

/**
 * Shape validation the DOOR owns. `handleCreatePreflight` runs the rendering,
 * plus-alias and duplicate-inbox guards but not the address SHAPE (the create
 * does that later), and a draft we are about to STORE must not carry an address
 * that could never receive anything. Every signer needs a name and a deliverable
 * address, which is exactly what the editor already requires before Send.
 */
function readSigners(value: unknown): PendingSigner[] | null {
  if (!Array.isArray(value)) return null;
  const out: PendingSigner[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    if (typeof s.email !== 'string' || typeof s.name !== 'string') return null;
    if (!EMAIL_RE.test(s.email.trim()) || s.name.trim() === '') return null;
    out.push({
      email: s.email,
      name: s.name,
      ...(typeof s.on_behalf_of === 'string' && s.on_behalf_of ? { on_behalf_of: s.on_behalf_of } : {}),
    });
  }
  return out;
}

/** The create body a draft becomes. One shape, used by preflight AND by the claim. */
function toCreateBody(documentName: string, signers: PendingSigner[], autoClose: boolean, pdfBase64: string) {
  return { document_name: documentName, pdf_base64: pdfBase64, signers, auto_close: autoClose };
}

export async function handleCreatePendingSend(
  ctx: PendingSendCtx,
  body: Record<string, unknown>,
): Promise<PendingSendResult> {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !EMAIL_RE.test(email)) {
    return { status: 400, body: { error: 'A valid email address is required', code: 'validation_email' } };
  }
  const documentName = typeof body.document_name === 'string' ? body.document_name.trim() : '';
  const pdfBase64 = typeof body.pdf_base64 === 'string' ? body.pdf_base64 : '';
  const signers = readSigners(body.signers);
  const autoClose = body.auto_close !== false;
  if (!documentName || !pdfBase64 || !signers || signers.length === 0) {
    return { status: 400, body: { error: 'A document, a name and at least one signer are required', code: 'validation_draft' } };
  }

  let bytes: Uint8Array;
  try {
    bytes = decodePdfBase64(pdfBase64);
  } catch {
    return { status: 400, body: { error: 'The document could not be read', code: 'validation_pdf' } };
  }
  if (isUploadTooLarge(bytes.byteLength)) {
    return { status: 400, body: { error: uploadTooLargeMessage(bytes.byteLength), code: 'validation_pdf_size' } };
  }

  // The same deterministic validation a guest Send already runs. Nothing is
  // stored until it passes, so an invalid draft never becomes a record.
  const preflight = await handleCreatePreflight(
    toCreateBody(documentName, signers, autoClose, pdfBase64),
    ctx.pool,
  );
  if (preflight.status !== 200) return { status: preflight.status, body: preflight.body };

  if ((await ctx.store.countLive(email)) >= MAX_LIVE_PENDING_SENDS_PER_ADDRESS) {
    return {
      status: 429,
      body: {
        error: 'Too many documents are waiting to be sent from this address. Send or finish one first.',
        code: 'rate_size_pending_sends',
      },
    };
  }

  // Content-addressed under a `pending/` prefix so the retention sweep can find
  // orphans without ever touching a blob a real envelope shares.
  const storageKey = `pending/${computePdfHash(bytes)}/original.pdf`;
  await ctx.store.putBlob(storageKey, bytes);
  const id = await ctx.store.create(email, {
    documentName,
    storageKey,
    byteCount: bytes.byteLength,
    signers,
    autoClose,
  });
  return { status: 200, body: { draft_id: id } };
}

export async function handleGetPendingSend(ctx: PendingSendCtx, id: string): Promise<PendingSendResult> {
  const found = await ctx.store.get(id);
  if (!found) return { status: 404, body: { error: 'That document is no longer available', code: 'not_found' } };
  // Identity, never contents (AC-243): a name, a size, the recipients. The bytes
  // are reachable only through the claim.
  //
  // The bound address IS returned, so the restored editor's resend control can
  // prefill it (AC-240) without the visitor retyping the address they already
  // gave. It leaks nothing beyond what the reader already has: the handle
  // arrived in that mailbox, alongside a sign-in token that grants the whole
  // account. Same bound as DD-56.
  return {
    status: 200,
    body: {
      email: found.boundEmail,
      document_name: found.documentName,
      byte_count: found.byteCount,
      signers: found.signers,
      auto_close: found.autoClose,
      claimed: found.claimedAt !== null,
      ...(found.claimedEnvelopeId ? { envelope_id: found.claimedEnvelopeId } : {}),
      expires_at: found.expiresAt.toISOString(),
    },
  };
}

export async function handlePatchPendingSend(
  ctx: PendingSendCtx,
  id: string,
  body: Record<string, unknown>,
): Promise<PendingSendResult> {
  const existing = await ctx.store.get(id);
  if (!existing) return { status: 404, body: { error: 'That document is no longer available', code: 'not_found' } };

  const documentName = typeof body.document_name === 'string' ? body.document_name.trim() : undefined;
  const signers = body.signers === undefined ? undefined : readSigners(body.signers);
  const autoClose = typeof body.auto_close === 'boolean' ? body.auto_close : undefined;
  if (body.signers !== undefined && signers === null) {
    return { status: 400, body: { error: 'Each signer needs a name and an email address', code: 'validation_signers' } };
  }
  if (documentName === '' ) {
    return { status: 400, body: { error: 'Please enter a document name', code: 'validation_document_name' } };
  }

  // An edit is a draft too: run it through the same validation, so a correction
  // cannot smuggle an address past the rules the original had to satisfy. The
  // document is immutable, so the preflight reuses the stored size via a stub
  // body — only the signer/name rules are re-checked here.
  const merged = {
    document_name: documentName ?? existing.documentName,
    signers: signers ?? existing.signers,
    auto_close: autoClose ?? existing.autoClose,
  };
  const preflight = await handleCreatePreflight({ ...merged, pdf_base64: '' }, ctx.pool);
  // A missing/empty pdf is expected here (the file is immutable and not resent);
  // any OTHER rejection is a real one and must block the edit.
  const preflightCode = (preflight.body as { code?: string }).code;
  if (preflight.status !== 200 && preflightCode !== 'validation_pdf') {
    return { status: preflight.status, body: preflight.body };
  }

  const patch: PendingSendPatch = {
    ...(documentName !== undefined ? { documentName } : {}),
    ...(signers ? { signers } : {}),
    ...(autoClose !== undefined ? { autoClose } : {}),
  };
  const updated = await ctx.store.update(id, patch);
  if (!updated) {
    return {
      status: 409,
      body: { error: 'That document has already been sent, so it can no longer be changed', code: 'state_pending_send_claimed' },
    };
  }
  return { status: 200, body: { ok: true } };
}

export async function handleClaimPendingSend(
  ctx: PendingSendCtx,
  id: string,
  actorEmail: string,
): Promise<PendingSendResult> {
  const claim = await ctx.store.claim(id, actorEmail);
  switch (claim.outcome) {
    case 'not_found':
      return { status: 404, body: { error: 'That document is no longer available', code: 'not_found' } };
    case 'wrong_account':
      return {
        status: 403,
        body: {
          error: 'This document was started for a different email address. Sign in with that address to send it.',
          code: 'auth_pending_send_scope',
        },
      };
    case 'expired':
      // 409 + state_*, matching the F-12.1 status contract for a lifecycle
      // conflict (the same shape "already sealed" and "already signed" use).
      return {
        status: 409,
        body: { error: 'That document was held too long and has been removed', code: 'state_pending_send_expired' },
      };
    case 'already':
      // A success, not an error: the other tab already sent it (AC-239).
      return { status: 200, body: { envelope_id: claim.envelopeId, already_sent: true } };
    case 'claimed':
      break;
  }

  const record = claim.record;
  let result: { status: number; body: unknown };
  try {
    const bytes = await ctx.store.getBlob(record.storageKey);
    if (!bytes) throw new Error(`pending send ${id} lost its document`);
    result = await ctx.createEnvelope(
      record.boundEmail,
      toCreateBody(record.documentName, record.signers, record.autoClose, Buffer.from(bytes).toString('base64')),
    );
  } catch (err) {
    // The claim is only worth holding if it produced an envelope. It did not, so
    // hand it back rather than stranding the visitor with a draft nobody can send.
    await ctx.store.release(id).catch(() => {});
    throw err;
  }

  if (result.status < 200 || result.status >= 300) {
    // A REFUSAL (no credit, allowlist, a create-time rule) is retryable after the
    // creator fixes it — top up, then send the same draft (F-39.4).
    await ctx.store.release(id).catch(() => {});
    return { status: result.status, body: result.body as Record<string, unknown> };
  }

  const envelopeId = (result.body as { envelope_id?: string }).envelope_id ?? '';
  if (envelopeId) await ctx.store.recordEnvelope(id, envelopeId);
  return { status: 200, body: result.body as Record<string, unknown> };
}
