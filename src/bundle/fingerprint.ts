/**
 * Bundle fingerprint (F-8.2) — SHA-256 over the embedded EVIDENCE set
 * (document-original.pdf + each signer-<n>.eml + the proofs/ files + keys.json),
 * concatenated in the deterministic F-8.4 manifest order. NOT a signature: no key,
 * no certificate, no CA. A human-checkable integrity reference the verifier
 * recomputes (F-10.3); printed on the signature page (F-8.1).
 *
 * VERIFY-README.txt is embedded but excluded (it's a static doc, not evidence) —
 * the manifest marks it `inFingerprint: false`.
 */
import { createHash } from 'node:crypto';
import type { EmbeddedFile } from './types.js';

/** SHA-256 (64-hex) over the `inFingerprint` files, in manifest order. */
export function computeBundleFingerprint(manifest: EmbeddedFile[]): string {
  const h = createHash('sha256');
  for (const f of manifest) {
    if (f.inFingerprint) h.update(f.bytes);
  }
  return h.digest('hex');
}
