/**
 * Return-what-we-sent attachment gate — F-6.4 / AC-14 (spec v0.4.0).
 *
 * The forwarded signing reply must carry the canonical PDF back to us, byte-for-byte.
 * The signer cannot have altered the document: any change (even one byte) yields a
 * different SHA-256 and is rejected with the attachment-mismatch bounce (F-7). A
 * forward with no PDF part at all is the "attachment missing — forward the original
 * email" case.
 *
 * This is the document-integrity half of the signing event (the intent line is the
 * consent half, F-6.3). Together with the classical DKIM verification (F-6.2) they
 * prove: this exact signer consented to this exact document.
 */
import { createHash } from 'node:crypto';
import { extractPdfAttachments } from './mimeExtract.js';

export type AttachmentCheckResult =
  | {
      ok: true;
      /** Lowercase hex SHA-256 of the matched attachment (== canonical). */
      sha256: string;
      /** Filename of the matched attachment, if the part declared one. */
      filename: string | null;
    }
  | {
      ok: false;
      /** `missing` = no PDF part at all; `modified` = a PDF part whose bytes differ. */
      reason: 'missing' | 'modified';
    };

/** Lowercase hex SHA-256 of raw bytes — the canonical content address used throughout. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Decide whether a forwarded reply returned the canonical PDF unmodified.
 *
 * @param rawMime         the raw RFC-822 forward.
 * @param canonicalSha256 lowercase hex SHA-256 of the envelope's stored canonical PDF.
 */
export function checkForwardedAttachment(
  rawMime: string,
  canonicalSha256: string,
): AttachmentCheckResult {
  const want = canonicalSha256.trim().toLowerCase();
  const pdfs = extractPdfAttachments(rawMime);
  if (pdfs.length === 0) {
    return { ok: false, reason: 'missing' };
  }
  for (const pdf of pdfs) {
    const got = sha256Hex(pdf.bytes);
    if (got === want) {
      return { ok: true, sha256: got, filename: pdf.filename };
    }
  }
  // A PDF was attached but none matched — the document was altered (or it is the
  // wrong document). Distinct from "missing" so the bounce can name the issue.
  return { ok: false, reason: 'modified' };
}
