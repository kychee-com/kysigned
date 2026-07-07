/**
 * F22.1 + F22.9 — Canonical envelope PDF assembly.
 *
 * Concatenates the kysigned-generated cover page (page 1) and the envelope
 * creator's source content (pages 2..N) into a single canonical PDF. The
 * SHA-256 of the output bytes is the v0.19.0 `docHash` per F22.9 — what the
 * signer's "I SIGN" email is cryptographically bound to.
 *
 * Determinism per DD-69 — identical inputs (same cover bytes, same source
 * bytes) produce byte-identical output. pdf-lib metadata fields are pinned
 * to deterministic values derived from the input cover's metadata.
 */
import { PDFDocument } from 'pdf-lib';

const PRODUCER_TAG = 'kysigned-canonical-v0.19.0';

export async function assembleCanonicalPdf(
  coverBytes: Uint8Array,
  sourceBytes: Uint8Array,
): Promise<Uint8Array> {
  const canonical = await PDFDocument.create();

  const coverDoc = await PDFDocument.load(coverBytes);
  const sourceDoc = await PDFDocument.load(sourceBytes);

  // Copy cover pages first (page 1+), then source pages.
  const coverPages = await canonical.copyPages(coverDoc, coverDoc.getPageIndices());
  for (const p of coverPages) canonical.addPage(p);

  const sourcePages = await canonical.copyPages(sourceDoc, sourceDoc.getPageIndices());
  for (const p of sourcePages) canonical.addPage(p);

  // Inherit deterministic metadata from the cover (which baked in
  // generatedAt). Override Producer/Creator to distinguish the canonical
  // artifact from the standalone cover.
  const coverCreationDate = coverDoc.getCreationDate();
  const coverModificationDate = coverDoc.getModificationDate();
  const coverTitle = coverDoc.getTitle();
  const coverSubject = coverDoc.getSubject();

  canonical.setProducer(PRODUCER_TAG);
  canonical.setCreator(PRODUCER_TAG);
  canonical.setAuthor('kysigned');
  if (coverTitle) canonical.setTitle(coverTitle);
  if (coverSubject) canonical.setSubject(coverSubject);
  // CreationDate is the stable reference (the cover's generatedAt, baked in at
  // envelope creation); a fixed epoch is the last-resort fallback. setCreationDate
  // STICKS through save(); setModificationDate does NOT — pdf-lib's save()
  // unconditionally rewrites /ModDate to the current wall-clock (updateInfoDict),
  // so we pin it AFTER save (below).
  const stampDate = coverCreationDate ?? coverModificationDate ?? new Date(0);
  canonical.setCreationDate(stampDate);

  const bytes = await canonical.save({
    useObjectStreams: false,
    updateFieldAppearances: false,
  });
  return pinModDateToCreationDate(new Uint8Array(bytes));
}

/**
 * pdf-lib's `save()` always stamps `/ModDate` with the CURRENT time
 * (`updateInfoDict`), which makes the output non-reproducible — so the verifier's
 * reconstruction never byte-matches the originally-sent P_i and EVERY real-bundle
 * "document matches" check fails (Barry QA — the first real bundle). The ModDate is
 * the ONLY non-deterministic field (confirmed by diffing two reconstructions). We
 * overwrite its value with the (pinned, deterministic) `/CreationDate` value
 * IN PLACE — a PDF date is a fixed-width string `D:YYYYMMDDHHMMSS<tz>`, so the
 * substitution preserves every byte offset and keeps the xref table valid. The PDF
 * is treated as latin1 (1:1 byte mapping) so binary content is untouched. F-4.3 /
 * DD-69 determinism.
 *
 * MUST stay Node-`Buffer`-free: this runs in the /verify SPA (verifyBundleWeb
 * reconstructs P_i in the browser, where `Buffer` is undefined) — a Buffer here
 * threw "Could not read that file" for every bundle in-browser (Barry QA). The
 * latin1 helpers mirror verifyWeb.ts's own. NB TextDecoder('latin1') is
 * windows-1252 (lossy 0x80-0x9F), so it CANNOT round-trip binary — only the
 * explicit fromCharCode/charCodeAt mapping is byte-exact.
 */
const PDF_DATE = `D:[0-9]{14}(?:Z|[+\\-][0-9]{2}'[0-9]{2}')?`;
function pinModDateToCreationDate(bytes: Uint8Array): Uint8Array {
  const str = bytesToLatin1(bytes);
  const cd = new RegExp(`/CreationDate \\((${PDF_DATE})\\)`).exec(str);
  if (!cd) return bytes;
  const patched = str.replace(
    new RegExp(`/ModDate \\((${PDF_DATE})\\)`),
    (m, mod: string) => (mod.length === cd[1].length ? `/ModDate (${cd[1]})` : m),
  );
  return latin1ToBytes(patched);
}

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
