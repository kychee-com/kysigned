/**
 * documentKey — the single source of truth for an envelope's shared-document
 * blob key.
 *
 * Family B (F-3.4): the uploaded document D is stored ONCE at create; each
 * signer's canonical PDF P_i = cover_i ++ D is regenerated, never stored. The
 * bundle assembler and the per-signer/owner PDF readers all need D's blob key —
 * and they MUST agree with where create stored it, or they silently fail.
 */

/** The deterministic object-storage key for the shared document D. */
export function documentBlobKey(documentHash: string): string {
  return `envelopes/${documentHash}/document.pdf`;
}

/**
 * Resolve where an envelope's document blob actually lives: the explicit
 * `pdf_storage_key` column when set, else the deterministic key derived from
 * `document_hash`. The fallback is load-bearing — `pdf_storage_key` is NOT
 * written on create, so the column is null in practice; without the fallback the
 * completion bundle assembler (`prepareBundle`) bails on every envelope and no
 * bundle is ever emailed.
 */
export function resolveDocumentKey(envelope: {
  pdf_storage_key: string | null;
  document_hash: string;
}): string {
  return envelope.pdf_storage_key ?? documentBlobKey(envelope.document_hash);
}
