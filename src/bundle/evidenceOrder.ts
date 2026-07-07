/**
 * Evidence ordering for the fingerprint recompute (F-8.2 / F-8.4) — browser-safe,
 * shared by the Node engine (`verify.ts`) and the browser engine (`verifyWeb.ts`)
 * so both recompute the fingerprint over EXACTLY the same byte sequence. Rebuilds
 * the deterministic manifest order (document → emls → proofs → keys.json) from a
 * `path → bytes` map; VERIFY-README is excluded (it is not evidence).
 */
import type { EmbeddedFile } from './types.js';

/** Ascending signer indices present as `signer-<n>.eml`. */
export function signerIndices(files: Map<string, Uint8Array>): number[] {
  return [...files.keys()]
    .map((p) => /^signer-(\d+)\.eml$/.exec(p))
    .filter((m): m is RegExpExecArray => m != null)
    .map((m) => parseInt(m[1], 10))
    .sort((a, b) => a - b);
}

/** The F-8.4-ordered evidence files (everything except VERIFY-README). */
export function orderedEvidence(files: Map<string, Uint8Array>): EmbeddedFile[] {
  const out: EmbeddedFile[] = [];
  const mk = (path: string, mimeType: string): void => {
    const bytes = files.get(path);
    if (bytes) out.push({ path, bytes, mimeType, inFingerprint: true });
  };
  mk('document-original.pdf', 'application/pdf');
  const nums = signerIndices(files);
  // Family B (DD-9): per-signer covers come right after the document — the SAME
  // order as buildEvidenceManifest, so the recomputed fingerprint matches the
  // printed one (and a tampered cover changes the fingerprint).
  for (const n of nums) mk(`cover-${n}.pdf`, 'application/pdf');
  for (const n of nums) mk(`signer-${n}.eml`, 'message/rfc822');
  for (const n of nums) {
    mk(`proofs/signer-${n}.tsr`, 'application/timestamp-reply');
    mk(`proofs/signer-${n}.ots`, 'application/octet-stream');
  }
  mk('keys.json', 'application/json');
  return out;
}
