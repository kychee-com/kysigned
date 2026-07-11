/**
 * F-018 (AC-27) regression — the browser verify engine must be FULLY available OFFLINE.
 *
 * Root cause of the Cycle-17 red-team FAIL: `verifyWeb.ts` did `await import('../timestamp/…')`
 * inside the default timestamp-verification path. Vite splits a dynamic import into its own
 * chunk (`provider-*.js`); if the user opens /verify online and then goes offline BEFORE the
 * first verification, that chunk was never fetched, the dynamic import 404s, the timestamp
 * check throws, and a genuinely-valid bundle renders FAILED — the verifier fails CLOSED,
 * breaking the core "works with no internet" claim (AC-27).
 *
 * The offline-critical verify dependencies must be STATICALLY imported so they ship inside the
 * verify chunk and are present the moment /verify is reachable. This guard fails if any
 * offline-path module reintroduces a dynamic import of the timestamp layer.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('verifyWeb offline-safety (F-018 / AC-27)', () => {
  it('the browser verify engine does NOT dynamic-import the timestamp layer (would 404 offline → fail closed)', () => {
    const src = read('./verifyWeb.ts');
    // Any `import( '../timestamp/… )` (with optional whitespace/await) is a lazily-loaded
    // chunk that is unavailable offline. The RFC 3161 provider + contract MUST be static.
    const dynamicTimestampImport = /import\s*\(\s*['"]\.\.\/timestamp\//.test(src);
    assert.equal(
      dynamicTimestampImport,
      false,
      'verifyWeb.ts must STATICALLY import the timestamp provider/contract so /verify verifies offline',
    );
  });
});
