/**
 * Embedded-file navigation (browser-safe core) — F-10.3.
 *
 * Walks a bundle PDF's `/Names /EmbeddedFiles` name tree and returns each file's
 * path + RAW (still-`/Filter`-encoded) stream bytes. Uses ONLY pdf-lib (which is
 * browser-safe) — no `node:zlib`/`node:buffer` — so the Node CLI (`extract.ts`,
 * sync zlib) and the browser verifier (`extractWeb.ts`, DecompressionStream) can
 * share this exact navigation and decode per-runtime.
 */
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream } from 'pdf-lib';

export interface RawEmbeddedEntry {
  path: string;
  /** Raw stream bytes as stored (decode per `isFlate`). */
  raw: Uint8Array;
  /** True when `/Filter` is FlateDecode (the entry must be inflated). */
  isFlate: boolean;
}

function nameText(obj: unknown): string {
  const o = obj as { decodeText?: () => string; asString?: () => string } | null;
  if (o && typeof o.decodeText === 'function') return o.decodeText();
  if (o && typeof o.asString === 'function') return o.asString();
  return String(obj);
}

function isFlate(stream: PDFRawStream): boolean {
  const filter = stream.dict.get(PDFName.of('Filter'));
  return filter != null && filter.toString().includes('FlateDecode');
}

function collect(node: PDFDict, out: RawEmbeddedEntry[]): void {
  const names = node.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (names) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      const path = nameText(names.get(i));
      const spec = names.lookupMaybe(i + 1, PDFDict);
      if (!spec) continue;
      const ef = spec.lookupMaybe(PDFName.of('EF'), PDFDict);
      const streamObj = ef?.lookup(PDFName.of('F'));
      if (streamObj instanceof PDFRawStream) {
        out.push({ path, raw: new Uint8Array(streamObj.contents), isFlate: isFlate(streamObj) });
      }
    }
  }
  const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (kids) {
    for (let i = 0; i < kids.size(); i++) {
      const kid = kids.lookupMaybe(i, PDFDict);
      if (kid) collect(kid, out);
    }
  }
}

/** Navigate a bundle PDF and return raw (undecoded) embedded-file entries. */
export async function rawEmbeddedEntries(pdfBytes: Uint8Array): Promise<RawEmbeddedEntry[]> {
  const doc = await PDFDocument.load(pdfBytes, { throwOnInvalidObject: false });
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const ef = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  if (!ef) return [];
  const out: RawEmbeddedEntry[] = [];
  collect(ef, out);
  return out;
}
