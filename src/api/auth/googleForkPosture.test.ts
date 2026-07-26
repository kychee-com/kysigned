/**
 * googleForkPosture.test.ts — F-41.7 (AC-253), the zero-config fork sweep.
 *
 * The whole Google capability leans on the PLATFORM's OAuth client: kysigned
 * ships no client id, no client secret, and no Google config key, and no
 * production source may hardcode Google's endpoints (every google URL the
 * browser visits comes from run402's `authorization_url`). This sweep makes
 * that a structural property: a future change that embeds any of it fails
 * here, in both the backend and the SPA source.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const BACKEND_SRC = join(import.meta.dirname, '..', '..');
const FRONTEND_SRC = join(import.meta.dirname, '..', '..', '..', 'frontend', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(p) && !/\.test\.(ts|tsx|mjs)$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const files = [...walk(BACKEND_SRC), ...walk(FRONTEND_SRC)];

describe('F-41.7 — the platform client is never embedded (AC-253)', () => {
  it('no Google OAuth client id, secret, or Google config key anywhere in production source', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (/\.apps\.googleusercontent\.com/.test(text)) offenders.push(`${relative(BACKEND_SRC, f)}: embedded client id`);
      if (/GOOGLE_APP_CLIENT|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GOOGLE_OAUTH/.test(text))
        offenders.push(`${relative(BACKEND_SRC, f)}: google client env key`);
      if (/KYSIGNED_GOOGLE/.test(text)) offenders.push(`${relative(BACKEND_SRC, f)}: kysigned google config key`);
    }
    assert.deepEqual(offenders, [], 'the fork needs ZERO Google configuration — the platform supplies the client');
  });

  it('no production source hardcodes Google endpoints — the ceremony URL always comes from the platform', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      // Strip comments so documentation references do not count as wiring.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (/accounts\.google\.com|oauth2\.googleapis\.com|googleapis\.com\/oauth/.test(code)) {
        offenders.push(relative(BACKEND_SRC, f));
      }
    }
    assert.deepEqual(offenders, [], 'google URLs are the platform\'s to mint (authorization_url), never ours');
  });
});
