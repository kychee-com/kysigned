/**
 * Embedded-file extractor (Node) — F-10.3. Shares the pdf-lib navigation with the
 * browser verifier via `extractCore.ts`; decodes FlateDecode streams with
 * `node:zlib`. The browser path (`extractWeb.ts`) decodes with DecompressionStream.
 *
 * The round-trip (assemble → extract) is asserted against the assembler output so
 * the verifier reads exactly what we wrote.
 */
import { Buffer } from 'node:buffer';
import { inflateSync } from 'node:zlib';
import { rawEmbeddedEntries } from './extractCore.js';

export interface ExtractedFile {
  path: string;
  bytes: Uint8Array;
}

/** Extract every embedded file (path + decoded bytes) from a bundle PDF. */
export async function extractEmbeddedFiles(pdfBytes: Uint8Array): Promise<ExtractedFile[]> {
  const entries = await rawEmbeddedEntries(pdfBytes);
  return entries.map((e) => ({
    path: e.path,
    bytes: e.isFlate ? new Uint8Array(inflateSync(Buffer.from(e.raw))) : e.raw,
  }));
}

/** Convenience: extract into a `path → bytes` map. */
export async function extractEmbeddedFileMap(pdfBytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const files = await extractEmbeddedFiles(pdfBytes);
  return new Map(files.map((f) => [f.path, f.bytes]));
}
