/**
 * gen-sign-request-assets.mjs (F-25 / 29.2) — generate the /hashcheck test assets,
 * OFFLINE, derived from the existing committed `sample-bundle.pdf` so they stay
 * byte-consistent with it (the standalone original equals the bundle's embedded D).
 *
 * Writes to `docs/test-assets/`:
 *   - sample-document-original.pdf        the original document D, standalone (the
 *                                         /hashcheck "left" input). Byte-identical to
 *                                         the `document-original.pdf` embedded in
 *                                         sample-bundle.pdf.
 *   - sample-sign-request.pdf             a real sign-request P_i = cover-1 ++ D (the
 *                                         canonical PDF signer 1 received attached).
 *   - sample-sign-request-tampered-doc.pdf  same cover, a DIFFERENT document inside
 *                                         (the negative content-match case).
 *
 * Validated by `src/bundle/testAssets.test.ts`. DUMMY data only. No network.
 * Run:  node --import tsx scripts/gen-sign-request-assets.mjs
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { PDFDocument } from 'pdf-lib';
import { extractEmbeddedFileMap } from '../src/bundle/extract.ts';
import { assembleCanonicalPdf } from '../src/pdf/assembleCanonicalPdf.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'test-assets');
const load = (n) => new Uint8Array(readFileSync(join(OUT, n)));
const write = (n, b) => {
  writeFileSync(join(OUT, n), Buffer.from(b));
  console.log(`  wrote ${n} (${b.length} bytes)`);
};
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function makeTamperedDoc() {
  const d = await PDFDocument.create();
  d.setCreationDate(new Date('2026-06-20T00:00:00Z'));
  d.setModificationDate(new Date('2026-06-20T00:00:00Z'));
  const p = d.addPage([612, 792]);
  p.drawText('A DIFFERENT DOCUMENT — this is the tampered sign-request.', { x: 56, y: 720, size: 12 });
  return new Uint8Array(await d.save({ useObjectStreams: false }));
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log('Generating /hashcheck sign-request assets (offline, from sample-bundle.pdf) …');
  const files = await extractEmbeddedFileMap(load('sample-bundle.pdf'));
  const D = files.get('document-original.pdf');
  if (!D) throw new Error('sample-bundle.pdf has no document-original.pdf');
  const coverKey = [...files.keys()].find((k) => /^cover-.*\.pdf$/.test(k));
  if (!coverKey) throw new Error('no cover-*.pdf embedded in sample-bundle.pdf');
  const cover = files.get(coverKey);
  console.log(`  extracted D (${D.length} b, sha ${sha(D).slice(0, 16)}…) + ${coverKey} (${cover.length} b)`);

  write('sample-document-original.pdf', D);
  write('sample-sign-request.pdf', await assembleCanonicalPdf(cover, D));
  write('sample-sign-request-tampered-doc.pdf', await assembleCanonicalPdf(cover, await makeTamperedDoc()));
  console.log('Done. 3 sign-request assets written to docs/test-assets/.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
