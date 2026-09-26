// The published `kysigned` package (plan 83.1, F-47.1, AC-298/AC-299): the BUILT
// bundle, run as a child process the way `npx kysigned` runs it, against the
// repository's bundle fixtures. Offline, so every verdict is deterministic; each
// must equal the repository CLI's (the canonical core, F-10.10 parity).
// Needs the root build (`npm run build` at the repository root) for the repo CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = join(HERE, '..');
const ROOT = join(CLI_DIR, '..');
const BIN = join(CLI_DIR, 'dist', 'kysigned.mjs');
const LIB = join(CLI_DIR, 'dist', 'index.js');
const REPO_CLI = join(ROOT, 'bin', 'verify-bundle.mjs');
const ASSETS = join(ROOT, 'docs', 'test-assets');
const PKG = JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf8'));

const GENUINE = 'acme-anvil-waiver-signed-bundle.pdf';
const FIXTURES = [
  GENUINE,
  'sample-bundle-forged-key.pdf', // offline integrity holds; the key archive catches it online
  'sample-bundle-l-tag.pdf',
  'sample-bundle-tampered-cover-substitution.pdf',
  'sample-bundle-tampered-doc.pdf',
  'sample-bundle-tampered-eml.pdf',
  'sample-bundle-tampered-rendered-page.pdf', // the embedded evidence is intact: the true verdict (AC-28 (e))
  'sample-bundle-tampered-signer-email.pdf',
  'sample-bundle-tampered-timestamp.pdf',
];
const MUST_FAIL = [
  'sample-bundle-l-tag.pdf',
  'sample-bundle-tampered-cover-substitution.pdf',
  'sample-bundle-tampered-doc.pdf',
  'sample-bundle-tampered-eml.pdf',
  'sample-bundle-tampered-signer-email.pdf',
  'sample-bundle-tampered-timestamp.pdf',
];

function run(file, args) {
  const r = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', cwd: CLI_DIR });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const kysigned = (...args) => run(BIN, args);

test('the build exists (npm test builds it) and the repository CLI is built for the parity checks', () => {
  assert.ok(existsSync(BIN), `${BIN} missing: run npm run build in cli/`);
  assert.ok(existsSync(join(ROOT, 'dist', 'bundle', 'verifyCli.js')), 'the repository is not built: run npm run build at its root');
});

test('--version prints the package version; --help prints the usage; both exit 0', () => {
  const v = kysigned('--version');
  assert.equal(v.code, 0);
  assert.equal(v.out.trim(), PKG.version);
  const h = kysigned('--help');
  assert.equal(h.code, 0);
  assert.match(h.out, /kysigned verify \[--offline\] \[--json\] <bundle\.pdf>/);
});

test('usage and read errors exit 2 with a message on stderr', () => {
  for (const args of [[], ['verify'], ['verify', '--offline'], ['frobnicate'], ['verify', '--bogus', 'x.pdf'], ['verify', 'a.pdf', 'b.pdf']]) {
    const r = kysigned(...args);
    assert.equal(r.code, 2, `kysigned ${args.join(' ')}`);
    assert.ok(r.err.trim().length > 0, `kysigned ${args.join(' ')} explains itself`);
  }
  const missing = kysigned('verify', '--offline', join(ASSETS, 'no-such-bundle.pdf'));
  assert.equal(missing.code, 2);
  assert.match(missing.err, /cannot read/);
});

test('the genuine bundle verifies (exit 0, its tier); every tampered one fails (exit 1)', () => {
  const ok = kysigned('verify', '--offline', join(ASSETS, GENUINE));
  assert.equal(ok.code, 0);
  assert.match(ok.out, /Signer 1: INTEGRITY VERIFIED/);
  for (const f of MUST_FAIL) {
    const r = kysigned('verify', '--offline', join(ASSETS, f));
    assert.equal(r.code, 1, f);
    assert.match(r.out, /FAILED/, f);
  }
});

test('parity: the same report and exit code as the repository CLI, for every fixture (F-10.10)', () => {
  for (const f of FIXTURES) {
    const pkg = kysigned('verify', '--offline', join(ASSETS, f));
    const repo = run(REPO_CLI, ['--offline', join(ASSETS, f)]);
    assert.equal(pkg.code, repo.code, `${f}: exit code`);
    assert.equal(pkg.out, repo.out, `${f}: report`);
  }
});

test('--json prints one document with the tiers, dimensions, checks and document hash, and the same exit code', async () => {
  const { runVerifyCli } = await import(pathToFileURL(join(ROOT, 'dist', 'bundle', 'verifyCli.js')).href);
  for (const f of FIXTURES) {
    const r = kysigned('verify', '--offline', '--json', join(ASSETS, f));
    const text = kysigned('verify', '--offline', join(ASSETS, f));
    assert.equal(r.code, text.code, `${f}: the same exit code as the text output`);
    const doc = JSON.parse(r.out);
    assert.equal(doc.schema, 'kysigned.verdict.v1', f);
    assert.equal(doc.kysigned, PKG.version, f);
    assert.equal(doc.offline, true, f);
    const { verdict } = await runVerifyCli(new Uint8Array(readFileSync(join(ASSETS, f))), { offline: true });
    assert.equal(doc.tier, verdict.tier, `${f}: bundle tier`);
    assert.equal(doc.originalDocSha256, verdict.originalDocSha256, `${f}: original-document SHA-256`);
    assert.equal(doc.signers.length, verdict.signers.length, f);
    doc.signers.forEach((s, i) => {
      assert.equal(s.tier, verdict.signers[i].tier, `${f}: signer ${i + 1} tier`);
      assert.deepEqual(s.assurance, verdict.signers[i].assurance, `${f}: signer ${i + 1} dimension states`);
      assert.deepEqual(s.checks, verdict.signers[i].checks, `${f}: signer ${i + 1} checks`);
    });
  }
});

test('the library entry returns the exit code, report, verdict and JSON document', async () => {
  const { verifyBundleBytes, VERDICT_SCHEMA } = await import(pathToFileURL(LIB).href);
  assert.equal(VERDICT_SCHEMA, 'kysigned.verdict.v1');
  const good = await verifyBundleBytes(new Uint8Array(readFileSync(join(ASSETS, GENUINE))), { offline: true });
  assert.equal(good.exitCode, 0);
  assert.match(good.report, /Signer 1: INTEGRITY VERIFIED/);
  assert.equal(good.json.tier, good.verdict.tier);
  assert.equal(good.json.schema, VERDICT_SCHEMA);
  const bad = await verifyBundleBytes(new Uint8Array(readFileSync(join(ASSETS, 'sample-bundle-tampered-doc.pdf'))), { offline: true });
  assert.equal(bad.exitCode, 1);
  assert.equal(bad.json.tier, 'FAILED');
});
