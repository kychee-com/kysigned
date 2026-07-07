/**
 * Embedded-file extractor (browser) — F-10.1 / F-10.3. Shares the pdf-lib
 * navigation with the Node CLI (`extractCore.ts`) and decodes FlateDecode streams
 * with the web-standard `DecompressionStream` — no `node:zlib`. Runs in the browser
 * AND in Node ≥18 (both have DecompressionStream), so it is differential-tested
 * against the Node extractor.
 */
import { rawEmbeddedEntries } from './extractCore.js';

export interface ExtractedFile {
  path: string;
  bytes: Uint8Array;
}

/** Inflate a zlib-wrapped (FlateDecode) stream using DecompressionStream. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function extractEmbeddedFilesWeb(pdfBytes: Uint8Array): Promise<ExtractedFile[]> {
  const entries = await rawEmbeddedEntries(pdfBytes);
  const out: ExtractedFile[] = [];
  for (const e of entries) {
    out.push({ path: e.path, bytes: e.isFlate ? await inflate(e.raw) : e.raw });
  }
  return out;
}

export async function extractEmbeddedFileMapWeb(pdfBytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const files = await extractEmbeddedFilesWeb(pdfBytes);
  return new Map(files.map((f) => [f.path, f.bytes]));
}
