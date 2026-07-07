/**
 * blobPurge — delete an envelope's stored blobs at their REAL keys (F-013).
 *
 * The shared purge every terminal-state path uses (void / expire / retention
 * sweep / account deletion). It enumerates the envelope's blob keys via
 * `envelopeBlobKeys` (document D + per-signer covers) and deletes them — NOT the
 * always-null `pdf_storage_key` column, whose nullness silently no-oped every
 * prior delete path and let blobs accumulate forever.
 *
 * The one subtlety is the shared document D: it is content-addressed by
 * `document_hash` and stored ONCE, so two envelopes built from the same upload
 * (e.g. F16.C "resend to missing", or the same file uploaded twice) share the
 * SAME `document.pdf` blob. Deleting it out from under a still-live sibling would
 * break that sibling's signing / bundle assembly. So D is deleted ONLY when no
 * OTHER envelope still references it. Callers stamp the envelope's
 * `pdf_deleted_at` BEFORE calling, so the "last referencer" guard correctly sees
 * this envelope as already purged (and excludes it via `id <> $2`).
 *
 * Per-signer covers are keyed by the globally-unique `signing_token`, so they are
 * never shared and are always safe to delete.
 *
 * Fail-soft per key (a storage error is counted, not thrown) so a transient
 * backend blip never aborts the caller's terminal-state transition; the next
 * retention sweep re-attempts anything left behind.
 */
import type { DbPool } from '../db/pool.js';
import { envelopeBlobKeys } from './blobKeys.js';

export interface BlobDeleteStorage {
  deletePdf(key: string): Promise<void>;
}

export interface PurgeResult {
  /** Keys successfully deleted. */
  deleted: number;
  /** Keys whose delete threw (counted, not fatal). */
  failed: number;
  /** The keys this purge attempted to delete (document D included only when purged). */
  keys: string[];
}

/**
 * Delete an envelope's covers (always) + its shared document D (only when this is
 * the last envelope referencing it). Returns per-key counts. Fail-soft.
 */
export async function purgeEnvelopeBlobs(
  pool: DbPool,
  storage: BlobDeleteStorage,
  envelope: { id: string; document_hash: string },
  signers: { signing_token: string }[],
): Promise<PurgeResult> {
  const { documentKey, coverKeys } = envelopeBlobKeys(envelope, signers);
  const keys = [...coverKeys];

  // Delete the shared document D only when no OTHER envelope still holds it (an
  // envelope holds D until its own retention stamps pdf_deleted_at). The caller
  // has already stamped THIS envelope, so `id <> $2 AND pdf_deleted_at IS NULL`
  // asks exactly "does any live sibling still need D?".
  const others = await pool.query(
    `SELECT 1 FROM envelopes WHERE document_hash = $1 AND id <> $2 AND pdf_deleted_at IS NULL LIMIT 1`,
    [envelope.document_hash, envelope.id],
  );
  if (others.rows.length === 0) keys.push(documentKey);

  let deleted = 0;
  let failed = 0;
  for (const key of keys) {
    try {
      await storage.deletePdf(key);
      deleted++;
    } catch {
      failed++;
    }
  }
  return { deleted, failed, keys };
}
