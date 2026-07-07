/**
 * 2F.AUTH4(k) audit-grep gate test — v0.22.0 / DD-72.
 *
 * The session cookie migration retires the localStorage Bearer-token model.
 * After the migration, the BUILT SPA bundle MUST NOT contain the legacy
 * localStorage keys `kysigned_token` or `kysigned_refresh_token` — neither
 * as a literal string nor a `localStorage.setItem('kysigned_token'`-style
 * call site. The cookie is HttpOnly and managed by the server; no JS path
 * should touch those names.
 *
 * Skipped when the frontend bundle isn't built (CI builds first; local devs
 * may run unit tests without rebuilding).
 *
 * Run: `node --test --import tsx test/no-localstorage-tokens.test.ts`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..', 'frontend', 'dist');

function* walk(dir: string): Iterable<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

describe('audit-grep — built SPA bundle has no legacy auth-token strings', () => {
  it('frontend/dist/ does not contain "kysigned_token" or "kysigned_refresh_token"', () => {
    if (!existsSync(DIST)) {
      // Allow local test runs without a fresh build. CI builds first.
      console.log(`SKIP: ${DIST} does not exist — run \`npm run build\` in frontend/ first.`);
      return;
    }
    const hits: Array<{ file: string; needle: string }> = [];
    for (const file of walk(DIST)) {
      if (!file.endsWith('.js') && !file.endsWith('.mjs') && !file.endsWith('.html') && !file.endsWith('.map')) continue;
      const content = readFileSync(file, 'utf8');
      for (const needle of ['kysigned_token', 'kysigned_refresh_token']) {
        if (content.includes(needle)) hits.push({ file, needle });
      }
    }
    assert.deepEqual(
      hits,
      [],
      `Found legacy auth-token strings in built SPA bundle:\n${hits
        .map((h) => `  ${h.file} contains "${h.needle}"`)
        .join('\n')}\n\nThe v0.22.0 cookie migration retired localStorage tokens; the cookie is HttpOnly.`,
    );
  });
});
