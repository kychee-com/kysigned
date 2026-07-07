/**
 * blobKeys — enumerate EVERY object-storage blob an envelope holds.
 *
 * Family B (F-3.4): an envelope stores the shared document D ONCE
 * (`envelopes/<document_hash>/document.pdf`) plus one per-signer cover
 * (`envelopes/<document_hash>/cover-<signing_token>.pdf`) — the per-signer
 * canonical PDF P_i = cover_i ++ D is regenerated, never stored, and the bundle
 * is delivered only as a completion-email attachment (never persisted server-side).
 * So an envelope maps to MANY blob keys, which is why deletion can't hang off a
 * single `pdf_storage_key` column (F-013: that column is never written, so every
 * key-derived-from-it delete no-oped and blobs accumulated forever).
 *
 * This is the single source of truth for those keys, so the create/store path
 * (envelope.ts), the read path (config.ts prepareBundle / signerApi), and every
 * DELETE path (void / expire / retention sweep / account deletion) all agree.
 */
import { documentBlobKey } from './documentKey.js';

/** The deterministic object-storage key for a signer's per-signer cover page. */
export function coverBlobKey(documentHash: string, signingToken: string): string {
  return `envelopes/${documentHash}/cover-${signingToken}.pdf`;
}

export interface EnvelopeBlobKeys {
  /** The shared document D — `envelopes/<hash>/document.pdf`. */
  documentKey: string;
  /** One per-signer cover — `envelopes/<hash>/cover-<token>.pdf`. */
  coverKeys: string[];
  /** documentKey + coverKeys, in a stable order (document first). */
  allKeys: string[];
}

/**
 * Every blob key an envelope holds: the shared document D + one cover per signer.
 * The evidence bundle is NOT included — it is delivered only as a completion-email
 * attachment and never stored on our servers, so there is no bundle blob to purge.
 */
export function envelopeBlobKeys(
  envelope: { document_hash: string },
  signers: { signing_token: string }[],
): EnvelopeBlobKeys {
  const documentKey = documentBlobKey(envelope.document_hash);
  const coverKeys = signers.map((s) => coverBlobKey(envelope.document_hash, s.signing_token));
  return { documentKey, coverKeys, allKeys: [documentKey, ...coverKeys] };
}
