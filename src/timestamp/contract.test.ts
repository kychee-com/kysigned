import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyWith,
  type TimestampProvider,
  type TimestampProof,
  type VerifyResult,
} from './contract.js';

function stub(id: string, result: VerifyResult): TimestampProvider {
  return {
    id,
    async stamp(): Promise<TimestampProof> {
      return { provider: id, version: 1, status: 'complete', data: '' };
    },
    async verify(): Promise<VerifyResult> {
      return result;
    },
  };
}

const HASH = new Uint8Array(32);

describe('TimestampProvider contract', () => {
  it('verifyWith routes a proof to the provider whose id matches proof.provider', async () => {
    const providers = [
      stub('ots', { ok: false, timeSec: 0, anchor: 'btc' }),
      stub('rfc3161', { ok: true, timeSec: 1718000000, anchor: 'freeTSA' }),
    ];
    const proof: TimestampProof = { provider: 'rfc3161', version: 1, status: 'complete', data: '' };
    const res = await verifyWith(providers, proof, HASH);
    assert.deepEqual(res, { ok: true, timeSec: 1718000000, anchor: 'freeTSA' });
  });

  it('verifyWith returns ok:false for an unknown provider', async () => {
    const providers = [stub('ots', { ok: true, timeSec: 1, anchor: 'btc' })];
    const proof: TimestampProof = { provider: 'nope', version: 1, status: 'complete', data: '' };
    const res = await verifyWith(providers, proof, HASH);
    assert.deepEqual(res, { ok: false, timeSec: 0, anchor: '' });
  });

  it('providers are interchangeable behind the TimestampProvider type', async () => {
    const providers: TimestampProvider[] = [
      stub('a', { ok: true, timeSec: 10, anchor: 'x' }),
      stub('b', { ok: true, timeSec: 20, anchor: 'y' }),
    ];
    for (const p of providers) {
      const proof = await p.stamp(HASH);
      const res = await p.verify(proof, HASH);
      assert.equal(typeof res.ok, 'boolean');
      assert.equal(typeof res.timeSec, 'number');
      assert.equal(typeof res.anchor, 'string');
    }
  });
});
