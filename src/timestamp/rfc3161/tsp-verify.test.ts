import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractToken, parseToken, verifyToken } from './tsp.js';

const here = dirname(fileURLToPath(import.meta.url));
const resp = new Uint8Array(readFileSync(join(here, 'fixtures', 'freetsa-resp.der')));
const hash = Uint8Array.from(Buffer.from(readFileSync(join(here, 'fixtures', 'hash.hex'), 'utf8').trim(), 'hex'));
const token = extractToken(resp);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('RFC 3161 token parse + verify against a real freeTSA fixture (AC-16)', () => {
  it('extracts + parses the token: imprint matches the hash, genTime present', () => {
    const info = parseToken(token);
    assert.equal(info.hashAlgoOid, '2.16.840.1.101.3.4.2.1');
    assert.equal(hex(info.messageImprint), hex(hash));
    assert.ok(info.genTimeSec > 1_600_000_000, 'genTime after 2020');
    assert.ok(info.tsaName.length > 0);
  });

  it('verifies the token signature + imprint → ok with genTime', async () => {
    const res = await verifyToken(token, hash);
    assert.equal(res.ok, true, 'token should verify');
    assert.ok(res.genTimeSec > 1_600_000_000);
    assert.ok(res.tsaName.length > 0);
  });

  it('fails for the wrong hash', async () => {
    const wrong = Uint8Array.from(hash);
    wrong[0] ^= 0xff;
    assert.equal((await verifyToken(token, wrong)).ok, false);
  });

  it('fails for a tampered token', async () => {
    const bad = Uint8Array.from(token);
    bad[bad.length - 5] ^= 0xff;
    assert.equal((await verifyToken(bad, hash)).ok, false);
  });
});
