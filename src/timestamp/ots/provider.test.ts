import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createOtsProvider } from './provider.js';
import { serializeTimestamp } from './timestamp.js';
import { Writer } from './serialization.js';
import type { HeaderSource } from './header.js';

const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const reverse = (b: Uint8Array) => Uint8Array.from([...b].reverse());
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const hash = sha256(Uint8Array.from([3, 1, 4, 1, 5]));
const nonce = Uint8Array.from(Array.from({ length: 16 }, (_, i) => i + 7));
const leaf = sha256(Uint8Array.from([...hash, ...nonce]));

function pendingTree(): Uint8Array {
  const w = new Writer();
  serializeTimestamp(
    { msg: new Uint8Array(), branches: [{ type: 'attestation', attestation: { kind: 'pending', uri: 'https://cal.example.org' } }] },
    w,
  );
  return w.getBytes();
}
function bitcoinTree(): Uint8Array {
  const w = new Writer();
  serializeTimestamp(
    { msg: new Uint8Array(), branches: [{ type: 'attestation', attestation: { kind: 'bitcoin', height: 750000 } }] },
    w,
  );
  return w.getBytes();
}

/** Handles both /digest (stamp → pending) and /timestamp/ (upgrade → bitcoin). */
const lifecycleFetch: typeof fetch = async (url) => {
  const u = String(url);
  if (u.includes('/digest')) return new Response(pendingTree(), { status: 200 });
  if (u.includes('/timestamp/')) return new Response(bitcoinTree(), { status: 200 });
  return new Response('?', { status: 404 });
};

const headerSource: HeaderSource = {
  async getBlockHeader(height) {
    return { height, merkleRoot: hex(reverse(leaf)), timeSec: 1700123456, blockHash: 'cafe' };
  },
};

describe('OTS provider (AC-5 full lifecycle, AC-23 configurable)', () => {
  const provider = createOtsProvider({
    calendars: ['https://cal.example.org'],
    fetchFn: lifecycleFetch,
    randomBytes: () => nonce,
    headerSource,
  });

  it('stamp returns a pending OTS proof (id=ots), no opentimestamps dep', async () => {
    const proof = await provider.stamp(hash);
    assert.equal(proof.provider, 'ots');
    assert.equal(proof.status, 'pending');
    assert.ok(proof.data.length > 0);
  });

  it('a pending proof does not verify (no Bitcoin anchor yet)', async () => {
    const proof = await provider.stamp(hash);
    assert.equal((await provider.verify(proof, hash)).ok, false);
  });

  it('upgrade advances pending → complete, then it verifies against the chain', async () => {
    const pending = await provider.stamp(hash);
    const complete = await provider.upgrade!(pending);
    assert.equal(complete.status, 'complete');
    const res = await provider.verify(complete, hash);
    assert.equal(res.ok, true);
    assert.equal(res.timeSec, 1700123456);
    assert.match(res.anchor, /750000/);
  });

  it('a complete proof fails to verify against the wrong hash', async () => {
    const complete = await provider.upgrade!(await provider.stamp(hash));
    assert.equal((await provider.verify(complete, sha256(Uint8Array.from([0])))).ok, false);
  });

  it('stamp rejects a non-32-byte hash', async () => {
    await assert.rejects(() => provider.stamp(new Uint8Array(16)));
  });
});
