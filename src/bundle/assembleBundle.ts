/**
 * assembleBundle — ONE evidence-bundle PDF per envelope (F-8, spec v0.4.0).
 *
 * Rendered pages, in order (F-8.1):
 *   1. signature page(s)  — per-signer verdict blocks + envelope metadata + the
 *                           bundle fingerprint + a verifier QR/URL + the no-seal note
 *   2. shared document D  — rendered EXACTLY ONCE (Family B: no single cover; each
 *                           signer's cover is embedded, not rendered N times)
 * Embedded files (never rendered): document-original.pdf (D), cover-<n>.pdf (per
 * signer), signer-<n>.eml, proofs/signer-<n>.{tsr,ots}, keys.json, VERIFY-README.txt.
 *
 * The bundle carries NO digital-signature dictionary (F-8.2 / AC-63) — asserted
 * before return. Deterministic given its inputs (F-8.4): metadata + embedded-file
 * dates are pinned to the completion time, the QR is content-derived, and pages are
 * added in a fixed order, so assembling twice yields byte-identical output.
 *
 * Pure over resolved inputs — fetching the canonical PDF bytes (blob store) and the
 * raw `.eml`s (run402 inbound store) is the caller's job (Phase 10 / Phase 14).
 */
import { Buffer } from 'node:buffer';
import { PDFDocument } from 'pdf-lib';
import QRCode from 'qrcode';
import type { AssembleBundleInput, AssembledBundle } from './types.js';
import { buildEvidenceManifest } from './evidenceManifest.js';
import { computeBundleFingerprint } from './fingerprint.js';
import { renderSignaturePages, type SignaturePageSigner } from './signaturePage.js';
import { hasSignatureDictionary } from './signatureDict.js';
import { extractSigningText } from '../api/signing/mimeExtract.js';
import { firstIntentLineVerbatim } from '../api/signing/signingIntent.js';

const PRODUCER_TAG = 'kysigned-bundle-v0.4.0';

/** The verbatim first body line of a signer's forward, for the signature page. */
function verbatimIntentLine(rawEml: Uint8Array): string {
  const str = Buffer.from(rawEml).toString('latin1');
  // text/plain, or the text/html part for HTML-only (iPhone) forwards.
  const part = extractSigningText(str);
  const line = part ? firstIntentLineVerbatim(part.content, part.cte, part.isHtml) : null;
  return line ?? 'I sign this document';
}

export async function assembleBundle(input: AssembleBundleInput): Promise<AssembledBundle> {
  // 1. Evidence manifest (the five classes, F-8.4 order) + fingerprint (F-8.2).
  const manifest = buildEvidenceManifest(input);
  const fingerprint = computeBundleFingerprint(manifest);

  // 2. Verifier QR — content-derived, so deterministic.
  const base = input.verifierBaseUrl.replace(/\/+$/, '');
  const qrPng = new Uint8Array(
    await QRCode.toBuffer(`${base}/verify`, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 240,
    }),
  );

  // 3. New document with deterministic metadata (pinned to completion time).
  const doc = await PDFDocument.create();
  doc.setTitle(`kysigned signing record ${input.envelope.id}`);
  doc.setAuthor('kysigned');
  doc.setSubject(`Signing record: ${input.envelope.documentName}`);
  doc.setProducer(PRODUCER_TAG);
  doc.setCreator(PRODUCER_TAG);
  doc.setCreationDate(input.envelope.completedAt);
  doc.setModificationDate(input.envelope.completedAt);

  // 4. Signature page(s) FIRST.
  const sigSigners: SignaturePageSigner[] = input.signers.map((s) => ({
    index: s.index,
    name: s.name,
    email: s.email,
    onBehalfOf: s.onBehalfOf,
    signingDomain: s.signingDomain,
    selector: s.selector,
    signedAt: s.signedAt,
    emlSha256: s.emlSha256,
    intentLine: verbatimIntentLine(s.rawEml),
  }));
  await renderSignaturePages(doc, {
    envelope: input.envelope,
    signers: sigSigners,
    fingerprint,
    verifierBaseUrl: base,
    qrPng,
  });

  // 5. The shared document D — rendered EXACTLY ONCE, after the sig pages (Family B:
  //    per-signer covers are embedded as cover-<n>.pdf, not rendered N times).
  const sharedDoc = await PDFDocument.load(input.documentOriginal);
  const pages = await doc.copyPages(sharedDoc, sharedDoc.getPageIndices());
  for (const p of pages) doc.addPage(p);

  // 6. Embed the five evidence-file classes (pinned dates → deterministic).
  for (const f of manifest) {
    await doc.attach(f.bytes, f.path, {
      mimeType: f.mimeType,
      creationDate: input.envelope.completedAt,
      modificationDate: input.envelope.completedAt,
    });
  }

  // 7. Save — no object streams keeps text ASCII-readable + bytes stable.
  const bytes = new Uint8Array(await doc.save({ useObjectStreams: false, updateFieldAppearances: false }));

  // 8. Guard: the bundle MUST carry no signature dictionary (clean open, no red-X).
  if (hasSignatureDictionary(bytes)) {
    throw new Error('assembleBundle: output carries a signature dictionary (F-8.2 / AC-63 violation)');
  }

  return { bytes, fingerprint, manifest };
}
