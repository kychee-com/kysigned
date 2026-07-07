/**
 * hashCheck.ts (F-25) — confirm a specific ORIGINAL document is the one carried
 * inside a kysigned artifact. The engine behind the `/hashcheck` tool: the creator
 * (or anyone) drops their original document plus EITHER a completed signing record
 * OR a sign-request PDF, and this confirms the document inside is theirs, untouched.
 *
 * Browser-safe: pure pdf-lib + `@noble/hashes` (isomorphic, Phase-26) + an INJECTED
 * embedded-file extractor (Node: `extract.ts`; web: `extractWeb.ts`). No `node:*`
 * imports, so it bundles for the `/hashcheck` SPA with zero Node deps.
 *
 * Two modes, auto-detected from the artifact:
 *  - **bundle** (a completed signing record) embeds `document-original.pdf` →
 *    **byte-exact**: `A = sha256(original)` must equal `sha256(document-original.pdf)`.
 *    Combined with the verifier's reconstruction (every signer signed
 *    `cover-<n> ++ document-original`), a match proves the signers signed THIS exact
 *    document.
 *  - **sign-request** (the `cover ++ document` PDF a signer received) has no embedded
 *    files → a **content-level** match. The 29.1 spike proved byte-exact
 *    reconstruction is impossible (prepending the cover re-serializes the document),
 *    so we compare the NORMALIZED document pages (pages 2..N) against the normalized
 *    original (DD-20). Honestly labelled "content match, not byte-identical".
 */
import { PDFDocument } from 'pdf-lib';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export type HashCheckKind = 'bundle' | 'sign-request' | 'unrecognized';
export type HashCheckGuarantee = 'byte-exact' | 'content-level';

export interface HashCheckResult {
  kind: HashCheckKind;
  match: boolean;
  guarantee: HashCheckGuarantee | null;
  /**
   * SHA-256 (hex) fingerprint of YOUR supplied original, as it was compared. The
   * KIND depends on `guarantee`: byte-exact (bundle) = sha256 of the raw original
   * file (this is `A`, F-10.9); content-level (sign-request) = sha256 of the
   * NORMALIZED page content — the value that actually decided the match, NOT the
   * raw file hash (prepending the cover re-serializes the bytes, DD-20). Always set.
   */
  originalSha256: string;
  /**
   * SHA-256 (hex) fingerprint of the ARTIFACT-side document, as compared. Set
   * whenever a comparison ran (both modes; absent only for an unrecognized file):
   * byte-exact = sha256 of the embedded `document-original.pdf`; content-level =
   * sha256 of the NORMALIZED inner document (the pages after the cover) — the inner
   * original that was signed, before the cover was prepended.
   */
  foundSha256?: string;
  reason: string;
}

/** Injected embedded-file extractor; the per-runtime inflate keeps this browser-safe. */
export type ExtractMap = (pdfBytes: Uint8Array) => Promise<Map<string, Uint8Array>>;

const hex = (b: Uint8Array): string => bytesToHex(sha256(b));

// latin1 <-> bytes, Buffer-free (mirrors assembleCanonicalPdf.ts) so this runs in
// the /hashcheck SPA where `Buffer` is undefined.
function bytesToLatin1(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return s;
}
function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// Empty the volatile PDF date VALUES. pdf-lib's `save()` rewrites `/ModDate` to the
// current wall-clock, which would make byte-identical content hash differently. The
// normalized output is only hashed for comparison (never re-parsed), so emptying the
// dates — even though that yields an invalid PDF — is exactly right.
function stripDates(bytes: Uint8Array): Uint8Array {
  const s = bytesToLatin1(bytes)
    .replace(/\/ModDate \([^)]*\)/g, '/ModDate ()')
    .replace(/\/CreationDate \([^)]*\)/g, '/CreationDate ()');
  return latin1ToBytes(s);
}

/**
 * Re-embed `pageIndices` of `pdfBytes` into a fresh PDF with fixed metadata and the
 * dates stripped, so two PDFs whose page CONTENT is identical normalize to identical
 * bytes regardless of their surrounding structure/metadata (DD-20 content-level).
 */
export async function normalizeDocPages(pdfBytes: Uint8Array, pageIndices?: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(pdfBytes);
  const out = await PDFDocument.create();
  const idx = pageIndices ?? src.getPageIndices();
  const pages = await out.copyPages(src, idx);
  for (const p of pages) out.addPage(p);
  out.setProducer('kysigned-hashcheck-norm');
  out.setCreator('kysigned-hashcheck-norm');
  out.setTitle('');
  out.setAuthor('');
  out.setCreationDate(new Date(0));
  out.setModificationDate(new Date(0));
  const saved = new Uint8Array(await out.save({ useObjectStreams: false }));
  return stripDates(saved);
}

export async function checkOriginalInArtifact(
  originalBytes: Uint8Array,
  artifactBytes: Uint8Array,
  extractMap: ExtractMap,
): Promise<HashCheckResult> {
  const originalSha256 = hex(originalBytes);

  // Bundle mode? A completed signing record embeds `document-original.pdf`.
  let embedded: Map<string, Uint8Array> | null = null;
  try {
    embedded = await extractMap(artifactBytes);
  } catch {
    embedded = null;
  }
  const docOriginal = embedded?.get('document-original.pdf');
  if (docOriginal) {
    const foundSha256 = hex(docOriginal);
    const match = foundSha256 === originalSha256;
    return {
      kind: 'bundle',
      match,
      guarantee: 'byte-exact',
      originalSha256,
      foundSha256,
      reason: match
        ? 'Byte-exact match: the original document is identical to the document embedded in the signing record, so every signer provably signed this exact document.'
        : 'Mismatch: the document embedded in the signing record is not the supplied original (different SHA-256).',
    };
  }

  // Sign-request mode? A `cover ++ document` PDF — pages 2..N are the document.
  let art: PDFDocument;
  try {
    art = await PDFDocument.load(artifactBytes);
  } catch {
    return {
      kind: 'unrecognized',
      match: false,
      guarantee: null,
      originalSha256,
      reason: 'Unrecognized file: it has no embedded document-original.pdf (so it is not a completed signing record) and is not a readable PDF.',
    };
  }
  if (art.getPageCount() < 2) {
    return {
      kind: 'unrecognized',
      match: false,
      guarantee: null,
      originalSha256,
      reason: 'Unrecognized file: a sign-request PDF must have a cover page plus the document (2 or more pages).',
    };
  }
  const normOriginal = await normalizeDocPages(originalBytes);
  const normDoc = await normalizeDocPages(artifactBytes, art.getPageIndices().slice(1));
  // Content-level fingerprints: the NORMALIZED page-content hashes that actually
  // decide the match (the inner document with the cover removed), surfaced so the UI
  // shows the value that matched — NOT sha256 of the raw file, which differs because
  // prepending the cover re-serializes the bytes (DD-20).
  const originalContentSha256 = hex(normOriginal);
  const foundContentSha256 = hex(normDoc);
  const match = originalContentSha256 === foundContentSha256;
  return {
    kind: 'sign-request',
    match,
    guarantee: 'content-level',
    originalSha256: originalContentSha256,
    foundSha256: foundContentSha256,
    reason: match
      ? 'Content match: the document inside this sign-request is the supplied original. This is a content match, not byte-identical. Prepending the cover re-serializes the document.'
      : 'Mismatch: the document inside this sign-request is not the supplied original.',
  };
}
