/**
 * RFC 3161 LIVE check — F-11 (real network; run on demand, never in the offline suite).
 * RFC 3161 is synchronous, so a real freeTSA stamp fully verifies in one run.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRfc3161Provider } from './provider.js';

describe('RFC 3161 live', () => {
  it('real freeTSA stamps & verifies a random hash end-to-end', async () => {
    const hash = new Uint8Array(randomBytes(32));
    const p = createRfc3161Provider();
    const proof = await p.stamp(hash);
    assert.equal(proof.status, 'complete');
    const res = await p.verify(proof, hash);
    assert.equal(res.ok, true);
    assert.ok(res.timeSec > 1_600_000_000);
  });
});
