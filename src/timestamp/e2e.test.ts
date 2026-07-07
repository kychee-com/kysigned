/**
 * End-to-end (offline): stamp & validate a random 32-byte hash — F-11 / AC-24.
 *
 * The fake provider round-trips a random hash deterministically, and the OTS
 * provider runs its full stamp → upgrade → verify lifecycle on a random hash
 * against calendar + block-header fixtures. The live counterparts live in
 * `*.live.ts` (run on demand) so this suite stays offline with no skips.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createFakeProvider } from './fake.js';
import { createOtsProvider } from './ots/provider.js';
import { Writer } from './ots/serialization.js';
import { serializeTimestamp } from './ots/timestamp.js';
import type { HeaderSource } from './ots/header.js';

const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const reverse = (b: Uint8Array) => Uint8Array.from([...b].reverse());
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function tree(att: { kind: 'pending'; uri: string } | { kind: 'bitcoin'; height: number }): Uint8Array {
  const w = new Writer();
  serializeTimestamp({ msg: new Uint8Array(), branches: [{ type: 'attestation', attestation: att }] }, w);
  return w.getBytes();
}

describe('end-to-end (offline): stamp & validate a random hash (AC-24)', () => {
  it('fake provider round-trips a random 32-byte hash', async () => {
    const hash = new Uint8Array(randomBytes(32));
    const p = createFakeProvider({ timeSec: 1700000000 });
    const res = await p.verify(await p.stamp(hash), hash);
    assert.equal(res.ok, true);
    assert.equal(res.timeSec, 1700000000);
  });

  it('OTS stamp → upgrade → verify on a random hash (fixtures)', async () => {
    const hash = new Uint8Array(randomBytes(32));
    const nonce = new Uint8Array(16).fill(42);
    const leaf = sha256(Uint8Array.from([...hash, ...nonce]));

    const lifecycleFetch: typeof fetch = async (url) => {
      const u = String(url);
      if (u.includes('/digest')) return new Response(tree({ kind: 'pending', uri: 'https://cal.example.org' }), { status: 200 });
      if (u.includes('/timestamp/')) return new Response(tree({ kind: 'bitcoin', height: 760000 }), { status: 200 });
      return new Response('?', { status: 404 });
    };
    const headerSource: HeaderSource = {
      async getBlockHeader(height) {
        return { height, merkleRoot: hex(reverse(leaf)), timeSec: 1699999999, blockHash: 'beef' };
      },
    };

    const ots = createOtsProvider({ calendars: ['https://cal.example.org'], fetchFn: lifecycleFetch, randomBytes: () => nonce, headerSource });
    const pending = await ots.stamp(hash);
    assert.equal(pending.status, 'pending');
    assert.equal((await ots.verify(pending, hash)).ok, false);

    const complete = await ots.upgrade!(pending);
    assert.equal(complete.status, 'complete');
    const res = await ots.verify(complete, hash);
    assert.equal(res.ok, true);
    assert.equal(res.timeSec, 1699999999);
    assert.match(res.anchor, /760000/);
  });
});
