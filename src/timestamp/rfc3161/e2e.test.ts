/**
 * RFC 3161 end-to-end (offline) — F-11 / AC-24 (+ AC-19 second provider via the CLI).
 *
 * The CLI stamps & verifies through the rfc3161 provider against the real freeTSA
 * token fixture. The live freeTSA round-trip lives in `e2e.live.ts`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRfc3161Provider } from './provider.js';
import { runCli } from '../cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const respFixture = new Uint8Array(readFileSync(join(here, 'fixtures', 'freetsa-resp.der')));
const fixtureHashHex = readFileSync(join(here, 'fixtures', 'hash.hex'), 'utf8').trim();

describe('RFC 3161 end-to-end (offline) (AC-24)', () => {
  it('CLI stamps & verifies via the rfc3161 provider (AC-19 second provider)', async () => {
    const provider = createRfc3161Provider({ fetchFn: async () => new Response(respFixture, { status: 200 }) });
    const deps = { providers: { rfc3161: provider }, defaultProvider: 'rfc3161', version: '1.0.0' };
    const s = await runCli(['--provider', 'rfc3161', 'stamp', fixtureHashHex], deps);
    assert.equal(s.code, 0, s.err);
    const v = await runCli(['--provider', 'rfc3161', 'verify', s.out.trim(), fixtureHashHex], deps);
    assert.equal(v.code, 0, v.err);
    assert.match(v.out, /"ok":true/);
  });
});
