#!/usr/bin/env node
/**
 * Generates `docs/test-assets/acme-anvil-waiver-sign-request.pdf` — the SIGN-REQUEST
 * package for the acme-anvil-waiver document: the per-signer canonical PDF
 * `cover ++ document`, i.e. exactly what a signer received attached to their
 * signing-request email. The third file for manually testing the `/hashcheck` page
 * with the acme set:
 *
 *   acme-anvil-waiver.pdf                 the original document  (drop this on the left)
 *   acme-anvil-waiver-signed-bundle.pdf   the completed record   -> byte-exact match
 *   acme-anvil-waiver-sign-request.pdf     cover ++ document      -> content match  (NEW)
 *
 * It is DERIVED from the committed `acme-anvil-waiver-signed-bundle.pdf` (extract its
 * `document-original.pdf` + a real `cover-<n>.pdf`, then re-run the deterministic
 * canonical assembler), so the sign-request stays byte-consistent with that bundle
 * and the cover is the genuine one a signer saw. Because it uses the kysigned engine
 * (the deterministic assembler + the embedded-file extractor), run it with tsx:
 *
 *   cd kysigned
 *   node --import tsx docs/test-assets/build-acme-anvil-waiver-sign-request.mjs
 *
 * Output: docs/test-assets/acme-anvil-waiver-sign-request.pdf
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { extractEmbeddedFileMap } from '../../src/bundle/extract.ts';
import { assembleCanonicalPdf } from '../../src/pdf/assembleCanonicalPdf.ts';
import { checkOriginalInArtifact } from '../../src/bundle/hashCheck.ts';

const DIR = dirname(fileURLToPath(import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const load = (n) => {
  const p = join(DIR, n);
  if (!existsSync(p)) throw new Error(`missing ${p} — build the bundle/original first`);
  return new Uint8Array(readFileSync(p));
};

async function main() {
  const original = load('acme-anvil-waiver.pdf');
  const bundle = load('acme-anvil-waiver-signed-bundle.pdf');

  const files = await extractEmbeddedFileMap(bundle);
  const D = files.get('document-original.pdf');
  if (!D) throw new Error('bundle has no document-original.pdf');
  const coverKey = [...files.keys()].find((k) => /^cover-.*\.pdf$/.test(k));
  if (!coverKey) throw new Error('bundle has no cover-*.pdf');
  const cover = files.get(coverKey);

  console.log('original acme-anvil-waiver.pdf :', sha(original).slice(0, 16), `(${original.length} b)`);
  console.log('bundle embedded document       :', sha(D).slice(0, 16), `(${D.length} b)`);
  console.log('original == embedded document  :', sha(original) === sha(D), `(cover: ${coverKey})`);

  const signRequest = await assembleCanonicalPdf(cover, D);
  const out = join(DIR, 'acme-anvil-waiver-sign-request.pdf');
  writeFileSync(out, Buffer.from(signRequest));
  console.log(`wrote ${out} (${signRequest.length} b)`);

  // Confirm both /hashcheck flows with the same engine the page runs.
  const rBundle = await checkOriginalInArtifact(original, bundle, extractEmbeddedFileMap);
  const rSign = await checkOriginalInArtifact(original, signRequest, extractEmbeddedFileMap);
  console.log('/hashcheck vs signed-bundle    :', rBundle.kind, rBundle.guarantee, 'match=' + rBundle.match);
  console.log('/hashcheck vs sign-request     :', rSign.kind, rSign.guarantee, 'match=' + rSign.match);
}

main().catch((err) => {
  console.error('build-acme-anvil-waiver-sign-request failed:', err);
  process.exit(1);
});
