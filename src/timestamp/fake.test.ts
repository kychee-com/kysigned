import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeProvider } from './fake.js';

const h1 = new Uint8Array(32).fill(1);
const h2 = new Uint8Array(32).fill(2);

describe('fake provider (AC-4 — deterministic, offline, swappable)', () => {
  it('stamp → verify round-trips deterministically with no network', async () => {
    const p = createFakeProvider({ timeSec: 1718000000 });
    const proof = await p.stamp(h1);
    assert.equal(proof.provider, 'fake');
    assert.equal(proof.status, 'complete');
    const res = await p.verify(proof, h1);
    assert.deepEqual(res, { ok: true, timeSec: 1718000000, anchor: 'fake' });
  });

  it('verify fails when the hash differs from the stamped one', async () => {
    const p = createFakeProvider();
    const proof = await p.stamp(h1);
    const res = await p.verify(proof, h2);
    assert.equal(res.ok, false);
  });

  it('stamp rejects a non-32-byte hash (synchronously, no network)', async () => {
    const p = createFakeProvider();
    await assert.rejects(() => p.stamp(new Uint8Array(31)));
  });

  it('two stamps of the same hash are byte-identical (deterministic)', async () => {
    const p = createFakeProvider({ timeSec: 123 });
    assert.deepEqual(await p.stamp(h1), await p.stamp(h1));
  });
});
