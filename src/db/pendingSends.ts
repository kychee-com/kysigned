/**
 * pendingSends — F-40.1 / F-40.6, the draft that outlives the tab (DD-56).
 *
 * F-39.3 used to hold a guest draft in ONE tab's memory, which made the tab a
 * mail client opens the one tab that could not finish the send. This store moves
 * the draft to the service so whichever browser ends up holding the session
 * completes the job — including the in-app WebViews (Gmail iOS, Outlook) whose
 * separate cookie jar the composing tab can never observe.
 *
 * It is NOT an envelope: nothing is delivered, no credit moves, and it is
 * invisible on the dashboard until claimed. Bounds that keep it that way:
 *
 *   - bound to the address the sign-in link was requested for; only a session
 *     for that address may claim it;
 *   - claimed exactly once, settled by the WHERE clause of a single UPDATE, so
 *     two tabs racing produce one envelope and one credit movement;
 *   - the document lives in the existing content-addressed `pdf_blobs`, and no
 *     read path here returns bytes — the storage key IS the file reference, used
 *     only by the claim;
 *   - retained 7 days, DELIBERATELY longer than the 15-minute sign-in link: the
 *     most common failure is the link expiring, and a draft that expired with it
 *     would leave nothing to restore (F-40.3 would be dead on arrival).
 *
 * The pool is HTTP-backed with no cross-call transactions (see pool.ts), so the
 * claim is a two-step with a compensating release: claim atomically, create the
 * envelope, record its id — and if the create fails, release the claim so the
 * visitor can retry rather than owning a draft nobody can send.
 */
import { randomUUID } from 'node:crypto';
import type { DbPool } from './pool.js';

/** run402's magic-link lifetime (`services/magic-link.ts`, read at 414cc643). */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

/** 7 days, matching the session cookie — and far outliving the link above. */
export const PENDING_SEND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingSigner {
  email: string;
  name: string;
  on_behalf_of?: string;
}

export interface PendingSendDraft {
  documentName: string;
  storageKey: string;
  byteCount: number;
  signers: PendingSigner[];
  autoClose: boolean;
}

export interface PendingSendRecord extends PendingSendDraft {
  id: string;
  boundEmail: string;
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
  claimedEnvelopeId: string | null;
}

export type ClaimResult =
  | { outcome: 'claimed'; record: PendingSendRecord }
  | { outcome: 'already'; envelopeId: string | null }
  | { outcome: 'wrong_account' }
  | { outcome: 'expired' }
  | { outcome: 'not_found' };

/** The one place the bound address is canonicalized; claim compares the same way. */
export function normalizeBoundEmail(email: string): string {
  return email.trim().toLowerCase();
}

interface Row {
  id: string;
  bound_email: string;
  document_name: string;
  storage_key: string;
  byte_count: number | string;
  draft: unknown;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  claimed_envelope_id: string | null;
}

function toRecord(row: Row): PendingSendRecord {
  // The HTTP DB layer may hand back JSONB as an object or as its text form.
  const draft = (typeof row.draft === 'string' ? JSON.parse(row.draft) : row.draft) as {
    signers?: PendingSigner[];
    auto_close?: boolean;
  } | null;
  return {
    id: row.id,
    boundEmail: row.bound_email,
    documentName: row.document_name,
    storageKey: row.storage_key,
    byteCount: Number(row.byte_count),
    signers: Array.isArray(draft?.signers) ? draft!.signers : [],
    autoClose: draft?.auto_close !== false,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
    claimedEnvelopeId: row.claimed_envelope_id,
  };
}

export async function createPendingSend(
  pool: DbPool,
  boundEmail: string,
  draft: PendingSendDraft,
  opts: { now?: Date; id?: string } = {},
): Promise<string> {
  const now = opts.now ?? new Date();
  const id = opts.id ?? `ps_${randomUUID()}`;
  const expiresAt = new Date(now.getTime() + PENDING_SEND_TTL_MS);
  await pool.query(
    `INSERT INTO pending_sends
       (id, bound_email, document_name, storage_key, byte_count, draft, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      id,
      normalizeBoundEmail(boundEmail),
      draft.documentName,
      draft.storageKey,
      draft.byteCount,
      JSON.stringify({ signers: draft.signers, auto_close: draft.autoClose }),
      expiresAt.toISOString(),
    ],
  );
  return id;
}

/**
 * AC-243 — the anti-anonymous-storage bound, counted in the DATABASE rather than
 * in memory: a Lambda has no shared process to hold a counter, so an in-memory
 * limiter would reset with every cold start. Live = unclaimed and unexpired.
 */
export async function countLivePendingSends(pool: DbPool, boundEmail: string, now: Date = new Date()): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM pending_sends
      WHERE bound_email = $1 AND claimed_at IS NULL AND expires_at > $2`,
    [normalizeBoundEmail(boundEmail), now.toISOString()],
  );
  const row = result.rows[0] as { n: number | string } | undefined;
  return row ? Number(row.n) : 0;
}

/** Metadata read. Returns claimed rows too, so a loser can be told where its envelope went. */
export async function getPendingSend(pool: DbPool, id: string): Promise<PendingSendRecord | null> {
  const result = await pool.query(
    `SELECT id, bound_email, document_name, storage_key, byte_count, draft,
            created_at, expires_at, claimed_at, claimed_envelope_id
       FROM pending_sends
      WHERE id = $1`,
    [id],
  );
  if (result.rows.length === 0) return null;
  return toRecord(result.rows[0] as Row);
}

export interface PendingSendPatch {
  documentName?: string;
  signers?: PendingSigner[];
  autoClose?: boolean;
}

/**
 * F-40.4 — edit the metadata while unclaimed. The claimed/expired refusal lives
 * in the WHERE clause rather than in a read-then-write, so it cannot lose a race
 * with a claim landing at the same moment. The document file is never touched.
 */
export async function updatePendingSendDraft(
  pool: DbPool,
  id: string,
  patch: PendingSendPatch,
  opts: { now?: Date } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const result = await pool.query(
    `UPDATE pending_sends
        SET document_name = COALESCE($2, document_name),
            draft = jsonb_build_object(
              'signers', COALESCE($3::jsonb, draft->'signers'),
              'auto_close', COALESCE($4::boolean, (draft->>'auto_close')::boolean)
            )
      WHERE id = $1
        AND claimed_at IS NULL
        AND expires_at > $5`,
    [
      id,
      patch.documentName ?? null,
      patch.signers ? JSON.stringify(patch.signers) : null,
      patch.autoClose ?? null,
      now.toISOString(),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * AC-238 — the single-winner claim. Everything that decides the winner is in the
 * WHERE clause of one statement; a caller that loses reads the row afterwards
 * ONLY to explain why (already sent / wrong account / expired / gone).
 */
export async function claimPendingSend(
  pool: DbPool,
  id: string,
  sessionEmail: string,
  opts: { now?: Date } = {},
): Promise<ClaimResult> {
  const now = opts.now ?? new Date();
  const email = normalizeBoundEmail(sessionEmail);
  const claimed = await pool.query(
    `UPDATE pending_sends
        SET claimed_at = $4
      WHERE id = $1
        AND claimed_at IS NULL
        AND bound_email = $3
        AND expires_at > $2
      RETURNING id, bound_email, document_name, storage_key, byte_count, draft,
                created_at, expires_at, claimed_at, claimed_envelope_id`,
    [id, now.toISOString(), email, now.toISOString()],
  );
  if (claimed.rows.length > 0) {
    return { outcome: 'claimed', record: toRecord(claimed.rows[0] as Row) };
  }
  const existing = await getPendingSend(pool, id);
  if (!existing) return { outcome: 'not_found' };
  if (existing.boundEmail !== email) return { outcome: 'wrong_account' };
  if (existing.claimedAt) return { outcome: 'already', envelopeId: existing.claimedEnvelopeId };
  return { outcome: 'expired' };
}

export async function recordClaimedEnvelope(pool: DbPool, id: string, envelopeId: string): Promise<void> {
  await pool.query(`UPDATE pending_sends SET claimed_envelope_id = $2 WHERE id = $1`, [id, envelopeId]);
}

/**
 * Compensating action for a create that threw AFTER the claim. Guarded on
 * `claimed_envelope_id IS NULL` so a claim that DID produce an envelope can
 * never be released back into a second send.
 */
export async function releasePendingSendClaim(pool: DbPool, id: string): Promise<void> {
  await pool.query(
    `UPDATE pending_sends SET claimed_at = NULL WHERE id = $1 AND claimed_envelope_id IS NULL`,
    [id],
  );
}

/**
 * AC-243 — finished means gone: a draft that produced an envelope, or one that
 * expired unclaimed. The orphan-blob pass then drops any document no envelope
 * and no live draft still points at (content-addressed, so a blob shared with a
 * real envelope is never touched).
 */
export async function deleteFinishedPendingSends(pool: DbPool, now: Date = new Date()): Promise<number> {
  const result = await pool.query(
    `DELETE FROM pending_sends
      WHERE claimed_envelope_id IS NOT NULL OR expires_at <= $1`,
    [now.toISOString()],
  );
  await pool.query(
    `DELETE FROM pdf_blobs b
      WHERE b.storage_key LIKE 'pending/%'
        AND NOT EXISTS (SELECT 1 FROM envelopes e WHERE e.pdf_storage_key = b.storage_key)
        AND NOT EXISTS (SELECT 1 FROM pending_sends p WHERE p.storage_key = b.storage_key)`,
  );
  return result.rowCount ?? 0;
}
