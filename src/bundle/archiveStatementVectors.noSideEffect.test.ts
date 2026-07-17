/**
 * #156 — importing the vector generator must NOT write the tracked fixture.
 *
 * `archiveStatementVectors.test.ts` imports `buildVectors` from
 * `scripts/gen-archive-statement-vectors.mjs`. If that module writes
 * `docs/test-assets/archive-statement-vectors.json` at top level (it re-signs
 * the randomized ES256/unknown-key vectors), then EVERY `npm test` run dirties
 * the working tree — a shipped-migration-class hazard for the /publish
 * clean-tree gate. The write must be gated behind a run-as-main guard, so only
 * an explicit `node scripts/gen-archive-statement-vectors.mjs` regenerates.
 *
 * This test does NOT statically import the generator (that would trigger the
 * very side effect under test at module load); it snapshots the committed file,
 * imports the generator in a FRESH subprocess, and asserts the bytes are
 * unchanged.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const GEN_URL = new URL('../../scripts/gen-archive-statement-vectors.mjs', import.meta.url);
const VECTORS = fileURLToPath(new URL('../../docs/test-assets/archive-statement-vectors.json', import.meta.url));

describe('#156 — the generator has no import-time write side effect', () => {
  it('importing gen-archive-statement-vectors.mjs leaves the committed fixture byte-identical', () => {
    const before = readFileSync(VECTORS, 'utf8');
    // Fresh process: `node -e import(...)` has no argv[1] script, so a correctly
    // guarded generator will NOT run its write branch. An UNGUARDED top-level
    // write would re-sign the randomized vectors and change the bytes → fail.
    execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(GEN_URL.href)})`], {
      stdio: 'ignore',
    });
    const after = readFileSync(VECTORS, 'utf8');
    assert.equal(after, before, 'importing the generator must not rewrite docs/test-assets/archive-statement-vectors.json');
  });
});
