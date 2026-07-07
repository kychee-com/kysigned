/**
 * Regression: scripts/*.mjs "run when executed directly" guards must fire on
 * EVERY platform.
 *
 * The old idiom — import.meta.url === `file:///${process.argv[1].replace(/\\/g,'/')}`
 * — matches only Windows paths. On posix, argv[1] starts with '/', producing
 * file:////four/slashes vs the real file:///three/slashes, so the guard is
 * false and the script SILENTLY NO-OPS with exit 0. That made CI's
 * `npm run test:all` a fake green (0 tests, 0.4s — run 28851223432) and made
 * `node scripts/deploy.mjs` a silent no-op for any forker on Linux/macOS.
 *
 * These tests spawn the scripts exactly as a user/CI does and assert the main
 * body actually ran, on whatever OS the suite runs on. (Lives in src/ because
 * the unit-suite glob is src/**\/*.test.ts.)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');

describe('script entrypoint guards run cross-platform', () => {
  it('test-all.mjs executes its suite loop when invoked directly', () => {
    // Stub cwd whose `npm run test` is instant, so we exercise the runner's
    // real invocation path without recursing into the actual unit suite.
    const stub = mkdtempSync(join(tmpdir(), 'kysigned-testall-'));
    try {
      writeFileSync(join(stub, 'package.json'), JSON.stringify({
        name: 'stub', version: '0.0.0',
        scripts: { test: "node -e \"console.log('UNIT-RAN')\"" },
      }));
      const out = execFileSync(process.execPath, [join(repoRoot, 'scripts', 'test-all.mjs')], {
        cwd: stub, encoding: 'utf8', env: { ...process.env, BASE_URL: '' },
      });
      // Pre-fix on posix: empty output, exit 0 (the silent-no-op bug).
      assert.match(out, /Running unit suite/, 'runner main body never executed');
      assert.match(out, /UNIT-RAN/, 'unit suite command was not invoked');
      assert.match(out, /All suites passed/);
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });

  it('deploy.mjs --dry-run executes its main body when invoked directly', () => {
    // --dry-run bundles + assembles the release spec and applies NOTHING
    // (no network, no project). Pre-fix on posix: silent no-op, exit 0.
    const out = execFileSync(process.execPath, [join(repoRoot, 'scripts', 'deploy.mjs'), '--dry-run'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 120_000,
    });
    assert.match(out, /DRY RUN/, 'deploy main body never executed');
  });
});
