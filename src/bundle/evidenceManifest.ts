/**
 * Evidence manifest — the ordered set of embedded files (F-8.1 five classes) in
 * the deterministic F-8.4 order that also defines the F-8.2 fingerprint input:
 *
 *   1. document-original.pdf     (the shared document D)
 *   2. cover-<n>.pdf             (each signer's per-signer cover, Family B)
 *   3. signer-<n>.eml            (each signer, index order)
 *   4. proofs/signer-<n>.{tsr,ots} (each signer, tsr then ots, omit if absent)
 *   5. keys.json
 *   6. VERIFY-README.txt         (embedded but NOT in the fingerprint)
 *
 * Pure + deterministic. The assembler embeds these into the PDF and the
 * fingerprint is SHA-256 over the `inFingerprint` files in this order.
 */
import { Buffer } from 'node:buffer';
import type { AssembleBundleInput, EmbeddedFile } from './types.js';
import type { TimestampProof } from '../timestamp/contract.js';
import { keysJsonBytes } from './keysJson.js';
import { buildVerifyReadme } from './verifyReadme.js';

function proofBytes(proof: TimestampProof): Uint8Array {
  return new Uint8Array(Buffer.from(proof.data, 'base64'));
}

/** Build the ordered embedded-file set for a bundle (the five classes). */
export function buildEvidenceManifest(input: AssembleBundleInput): EmbeddedFile[] {
  const files: EmbeddedFile[] = [];

  // 1. The shared document D (Family B — no cover; covers are per-signer below).
  files.push({
    path: 'document-original.pdf',
    bytes: input.documentOriginal,
    mimeType: 'application/pdf',
    inFingerprint: true,
  });

  // 1b. Each signer's per-signer cover (Family B, DD-9) — so the verifier can
  //     reconstruct P_i = cover-<n>.pdf ++ document-original.pdf and byte-match it
  //     to that signer's `.eml` attachment (F-10.3).
  for (const s of input.signers) {
    files.push({
      path: `cover-${s.index}.pdf`,
      bytes: s.cover,
      mimeType: 'application/pdf',
      inFingerprint: true,
    });
  }

  // 2. Each signer's byte-complete raw forward.
  for (const s of input.signers) {
    files.push({
      path: `signer-${s.index}.eml`,
      bytes: s.rawEml,
      mimeType: 'message/rfc822',
      inFingerprint: true,
    });
  }

  // 3. The timestamp proofs (tsr then ots per signer; omit a proof that's absent).
  for (const s of input.signers) {
    if (s.tsaToken) {
      files.push({
        path: `proofs/signer-${s.index}.tsr`,
        bytes: proofBytes(s.tsaToken),
        mimeType: 'application/timestamp-reply',
        inFingerprint: true,
      });
    }
    if (s.otsProof) {
      files.push({
        path: `proofs/signer-${s.index}.ots`,
        bytes: proofBytes(s.otsProof),
        mimeType: 'application/octet-stream',
        inFingerprint: true,
      });
    }
  }

  // 4. The observed-DKIM-key record.
  files.push({
    path: 'keys.json',
    bytes: keysJsonBytes(input.signers),
    mimeType: 'application/json',
    inFingerprint: true,
  });

  // 5. The verification README (NOT part of the fingerprint).
  files.push({
    path: 'VERIFY-README.txt',
    bytes: buildVerifyReadme(input.envelope, input.verifierBaseUrl),
    mimeType: 'text/plain',
    inFingerprint: false,
  });

  return files;
}
