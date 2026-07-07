/**
 * verification-tools/self-test.mjs (F-26 / AC-114) — runs the INDEPENDENT verifier
 * over every committed fixture and asserts the expected verdict. Exit 0 if all pass;
 * exit 1 (naming the offending fixture/check) otherwise. This is the toolkit's proof
 * that it actually reproduces the canonical verdict — not merely that it is present.
 *
 * Run:  node --import tsx scripts/verification-tools/self-test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyBundleIndependently } from './verify-independent.mjs';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'test-assets');
const load = (n) => new Uint8Array(readFileSync(join(ASSETS, n)));

// Expected verdict per committed fixture (mirrors docs/test-assets/README.md). For a
// FAILED case, `broken` is a check at least one signer must report false.
const CASES = [
  { file: 'sample-bundle.pdf', proven: true },
  { file: 'sample-bundle-tampered-doc.pdf', proven: false, broken: 'attachment' },
  { file: 'sample-bundle-tampered-eml.pdf', proven: false, broken: 'dkim' },
  { file: 'sample-bundle-tampered-timestamp.pdf', proven: false, broken: 'timestamp' },
  { file: 'sample-bundle-tampered-signer-email.pdf', proven: false, broken: 'dkim' },
  { file: 'sample-bundle-tampered-rendered-page.pdf', proven: true },
  { file: 'sample-bundle-tampered-cover-substitution.pdf', proven: false, broken: 'attachment' },
  { file: 'sample-bundle-l-tag.pdf', proven: false, broken: 'dkim' },
];

let failures = 0;
for (const c of CASES) {
  let v;
  try {
    v = await verifyBundleIndependently(load(c.file));
  } catch (e) {
    console.error(`FAIL ${c.file}: threw ${e.message}`);
    failures++;
    continue;
  }
  if (v.proven !== c.proven) {
    console.error(`FAIL ${c.file}: expected proven=${c.proven}, got ${v.proven} (reasons: ${JSON.stringify(v.signers.map((s) => s.reasons))})`);
    failures++;
    continue;
  }
  if (c.broken && !v.signers.some((s) => s.checks[c.broken] === false)) {
    console.error(`FAIL ${c.file}: expected a signer with ${c.broken}=false`);
    failures++;
    continue;
  }
  console.log(`ok   ${c.file} — proven=${v.proven}${c.broken ? ` (${c.broken} broken, as expected)` : ''}`);
}

if (failures) {
  console.error(`\n${failures} fixture(s) FAILED the self-test.`);
  process.exit(1);
}
console.log(`\nAll ${CASES.length} fixtures verified as expected — the independent toolkit reproduces the canonical verdict.`);
