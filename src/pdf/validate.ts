import { PDFDocument } from 'pdf-lib';

/**
 * F-017 — is `bytes` a parseable PDF?
 *
 * A creator-supplied `pdf_url` that fetches successfully but is NOT a PDF (e.g. a
 * GitHub README), or a `pdf_base64` blob of non-PDF content, must be a clean coded
 * 400 — never the uncoded 500 that pdf-lib throws deep in per-signer assembly
 * (`assembleCanonicalPdf` calls `PDFDocument.load(sourceBytes)` with NO options;
 * this mirrors it exactly, so the check accepts precisely what assembly accepts).
 */
export async function isPdfParseable(bytes: Uint8Array): Promise<boolean> {
  try {
    await PDFDocument.load(bytes);
    return true;
  } catch {
    return false;
  }
}
