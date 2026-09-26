#!/usr/bin/env node
/**
 * The tarball smoke for the `kysigned` package (plan 83.4, F-47.1): pack exactly
 * what npm would publish, install it into a fresh directory outside the repo, and
 * run it the way a user does. publish-kysigned.yml runs it before every publish;
 * run it by hand before a manual one.
 *
 *   node smoke.mjs [expected-version]     (default: this package.json's version)
 *
 * Checks: the package holds only dist/, README.md, LICENSE and package.json;
 * `npx kysigned --version` prints the expected version; `verify --offline` exits 0
 * on the genuine fixture and 1 on a tampered one; `--json` is a kysigned.verdict.v1
 * document for the expected version; the library entry imports and verifies.
 * Success ends `SMOKE PASS kysigned@<version>`; any failure exits 1.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(CLI, '..', 'docs', 'test-assets');
const GENUINE = 'acme-anvil-waiver-signed-bundle.pdf';
const TAMPERED = 'sample-bundle-tampered-doc.pdf';
const PACKAGE_FILES = ['LICENSE', 'README.md', 'dist/index.js', 'dist/index.js.LEGAL.txt', 'dist/kysigned.mjs', 'package.json'];
const WIN = process.platform === 'win32';
// Run the installed bin and never fetch one. Not `npx --no kysigned`: npx reads the
// word after an unknown flag as that flag's value, so `--no` would swallow the
// package name and hand `--version` to npm itself (npm bin/npx-cli.js).
const NPX = ['--yes=false'];

const pkg = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8'));
const expected = process.argv[2] ?? pkg.version;

class SmokeFailure extends Error {}

function run(cmd, args, cwd) {
  // npm and npx are .cmd shims on Windows, which start only through a shell.
  const r = spawnSync(cmd, WIN ? args.map((a) => `"${a}"`) : args, { cwd, encoding: 'utf8', shell: WIN });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function check(ok, what, detail = '') {
  if (!ok) throw new SmokeFailure(`${what}${detail ? `\n${detail}` : ''}`);
  console.log(`ok   ${what}`);
}

function filesUnder(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name), root) : [relative(root, join(dir, e.name)).split('\\').join('/')],
  );
}

const work = mkdtempSync(join(tmpdir(), 'kysigned-smoke-'));
try {
  // prepack builds dist/ first, so the tarball always carries a fresh build.
  const packed = run('npm', ['pack', '--pack-destination', work], CLI);
  const tarball = join(work, `${pkg.name}-${pkg.version}.tgz`);
  check(packed.code === 0, `npm pack wrote ${pkg.name}-${pkg.version}.tgz`, packed.err);

  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'kysigned-smoke-app', private: true }));
  const installed = run('npm', ['install', '--no-audit', '--no-fund', tarball], app);
  check(installed.code === 0, 'the tarball installs into a fresh directory', installed.err);

  const shipped = filesUnder(join(app, 'node_modules', pkg.name)).sort();
  check(JSON.stringify(shipped) === JSON.stringify(PACKAGE_FILES), 'the package holds only dist/, README.md, LICENSE and package.json', shipped.join('\n'));

  const version = run('npx', [...NPX, 'kysigned', '--version'], app);
  check(version.code === 0 && version.out.trim() === expected, `npx kysigned --version prints ${expected}`, `exit ${version.code}: ${version.out}${version.err}`);

  for (const f of [GENUINE, TAMPERED]) copyFileSync(join(ASSETS, f), join(app, f));

  const genuine = run('npx', [...NPX, 'kysigned', 'verify', '--offline', GENUINE], app);
  check(genuine.code === 0 && /VERIFIED/.test(genuine.out), 'verify --offline on the genuine bundle exits 0, verified', `exit ${genuine.code}: ${genuine.out}${genuine.err}`);

  const tampered = run('npx', [...NPX, 'kysigned', 'verify', '--offline', TAMPERED], app);
  check(tampered.code === 1 && /FAILED/.test(tampered.out), 'verify --offline on a tampered bundle exits 1, FAILED', `exit ${tampered.code}: ${tampered.out}${tampered.err}`);

  const json = run('npx', [...NPX, 'kysigned', 'verify', '--offline', '--json', GENUINE], app);
  let doc = {};
  try {
    doc = JSON.parse(json.out);
  } catch {
    /* reported by the check below */
  }
  check(
    json.code === 0 && doc.schema === 'kysigned.verdict.v1' && doc.kysigned === expected && doc.offline === true && /^[0-9a-f]{64}$/.test(doc.originalDocSha256 ?? ''),
    `verify --json prints a kysigned.verdict.v1 document for ${expected}`,
    `exit ${json.code}: ${json.out.slice(0, 400)}${json.err}`,
  );

  writeFileSync(
    join(app, 'library.mjs'),
    [
      "import { readFileSync } from 'node:fs';",
      "import { VERSION, verifyBundleBytes } from 'kysigned';",
      `const r = await verifyBundleBytes(new Uint8Array(readFileSync(${JSON.stringify(GENUINE)})), { offline: true });`,
      'console.log(JSON.stringify({ VERSION, exitCode: r.exitCode, schema: r.json.schema }));',
    ].join('\n'),
  );
  const library = run('node', ['library.mjs'], app);
  let lib = {};
  try {
    lib = JSON.parse(library.out);
  } catch {
    /* reported by the check below */
  }
  check(
    library.code === 0 && lib.VERSION === expected && lib.exitCode === 0 && lib.schema === 'kysigned.verdict.v1',
    "the library entry imports as 'kysigned' and verifies",
    `exit ${library.code}: ${library.out}${library.err}`,
  );

  console.log(`SMOKE PASS kysigned@${expected}`);
} catch (e) {
  console.error(`SMOKE FAIL: ${e instanceof SmokeFailure ? e.message : e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
