/**
 * Error-code taxonomy contract — F-30.3 (AC-137).
 *
 * EVERY `/v1` error response carries a stable machine-readable `code` from the
 * documented taxonomy, alongside the human `error` message. This meta-test
 * scans the API source so a NEW error site without a code fails the suite —
 * the taxonomy can't rot.
 *
 * Taxonomy (category prefixes, mapping 1:1 onto the F-12.1 status contract):
 *   auth_*         → 401/403 authentication + key-scope cases
 *   csrf_*         → 403 CSRF
 *   payment_*      → 402 credit gate
 *   validation_*   → 400 malformed/rejected input
 *   state_*        → 409 lifecycle conflicts (sealed, already-signed, …)
 *   not_found      → 404
 *   rate_size_*    → 413/400 size + rate guards
 *   idempotency_*  → 409/400 Idempotency-Key semantics
 *   internal_*     → 5xx (unexpected)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The /v1 handler surface: everything in src/api (recursively) + the function entry. */
function surfaceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.testpool.ts')) {
        files.push(p);
      }
    }
  };
  walk(here); // src/api (this test lives in src/api)
  files.push(join(here, '..', 'functions', 'api.ts'));
  return files;
}

const CODE_RE = /code:\s*'([a-z0-9_]+)'/;
const ALLOWED_PREFIX = /^(auth_|csrf_|payment_|validation_|state_|not_found$|rate_size_|idempotency_|internal_)/;

describe('error-code taxonomy (F-30.3 / AC-137)', () => {
  it('every error-object literal on the /v1 surface carries a taxonomy code', () => {
    const offenders: string[] = [];
    for (const file of surfaceFiles()) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        // An error response literal: `{ error: …` — the object must also carry
        // `code:` on the same literal (same line or the line block below).
        if (/\{\s*error:/.test(line) && !/error:\s*[a-z]+ instanceof/i.test(line)) {
          const block = lines.slice(i, i + 4).join('\n'); // small literals span ≤4 lines here
          if (!/code:\s*'/.test(block)) {
            offenders.push(`${file.replace(/^.*src/, 'src')}:${i + 1} ${line.trim().slice(0, 90)}`);
          }
        }
      });
    }
    assert.deepEqual(offenders, [], `error responses missing a taxonomy code:\n${offenders.join('\n')}`);
  });

  it('every code used belongs to the documented taxonomy', () => {
    const bad: string[] = [];
    for (const file of surfaceFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(new RegExp(CODE_RE.source, 'g'))) {
        if (!ALLOWED_PREFIX.test(m[1]!)) bad.push(`${file.replace(/^.*src/, 'src')} → ${m[1]}`);
      }
    }
    assert.deepEqual(bad, [], `codes outside the taxonomy:\n${bad.join('\n')}`);
  });
});
