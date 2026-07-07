/**
 * F-3.3 / DD-9 (Family B) — per-signer canonical PDF composer.
 *
 * Each signer of an envelope signs their OWN canonical PDF
 *   P_i = cover_i ++ D
 * where D is the shared uploaded document (stored once) and cover_i names that
 * signer (F-4 / F-22). This composes the per-signer cover + the shared document
 * into P_i and returns P_i plus its `sentPdfHash = sha256(P_i)` — the value the
 * signer's forward must return byte-for-byte (F-6.4). `H_D = sha256(D)` is the
 * shared envelope fingerprint, cited on every cover (`sourceDocHash`) and computed
 * once by the caller. Assembly is deterministic (F-4.3) so the verifier can
 * reconstruct P_i from (cover_i, D) at verification time (F-10.3).
 */
import { PDFDocument } from 'pdf-lib';
import { generateCoverPage, type EnvelopeCoverMetadata, type CoverPageSize } from './coverPage.js';
import { assembleCanonicalPdf } from './assembleCanonicalPdf.js';
import { computePdfHash } from './hash.js';

/**
 * The source document's first-page size, so the cover (#33) adopts it and reads
 * as a natural part of the PDF instead of a mismatched Letter sheet. Falls back
 * to the cover generator's own default (Letter) if the source can't be measured.
 */
async function sourcePageSize(sourceBytes: Uint8Array): Promise<CoverPageSize | undefined> {
  try {
    const src = await PDFDocument.load(sourceBytes);
    const first = src.getPage(0);
    const { width, height } = first.getSize();
    if (width > 0 && height > 0) return { width, height };
  } catch {
    // Unreadable/zero-page source — let generateCoverPage use its Letter default.
  }
  return undefined;
}

/**
 * Inputs for one signer's canonical PDF: the envelope-level cover metadata plus
 * that signer's identity (signerEmail is required here — a per-signer PDF always
 * belongs to a signer). `sourceDocHash` is `H_D` (= sha256 of the shared D).
 */
export type SignerCanonicalInput = EnvelopeCoverMetadata & {
  signerEmail: string;
};

export interface SignerCanonicalPdf {
  /** `P_i = cover_i ++ D` — the bytes attached to this signer's request. */
  pdf: Uint8Array;
  /** `sha256(P_i)` — the per-signer return-what-we-sent target (F-6.4). */
  sentPdfHash: string;
  /**
   * This signer's cover-page bytes alone (page 1 of `P_i`). Stored so the
   * completion bundle can embed `cover-<n>.pdf` and the verifier can reconstruct
   * `P_i = cover_i ++ D` byte-exactly (F-10.3) — the cover's `generatedAt` is
   * wall-clock at creation, so it cannot be regenerated identically later.
   */
  cover: Uint8Array;
}

export async function buildSignerCanonicalPdf(
  input: SignerCanonicalInput,
  sourceBytes: Uint8Array,
): Promise<SignerCanonicalPdf> {
  const cover = await generateCoverPage(input, await sourcePageSize(sourceBytes));
  const pdf = await assembleCanonicalPdf(cover, sourceBytes);
  const sentPdfHash = computePdfHash(pdf);
  return { pdf, sentPdfHash, cover };
}
