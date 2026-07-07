import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { serializeDetached, parseDetached, OTS_MAGIC, type DetachedTimestamp } from './detached.js';
import type { Timestamp } from './timestamp.js';

const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const digest = sha256(Uint8Array.from([7, 7, 7]));
const tree: Timestamp = {
  msg: digest,
  branches: [
    { type: 'attestation', attestation: { kind: 'pending', uri: 'https://b.pool.opentimestamps.org' } },
  ],
};
const detached: DetachedTimestamp = { hashOp: 'sha256', digest, timestamp: tree };

describe('OTS detached file (.ots)', () => {
  it('serialize → parse → serialize is byte-for-byte stable', () => {
    const a = serializeDetached(detached);
    const parsed = parseDetached(a);
    assert.deepEqual(serializeDetached(parsed), a);
    assert.equal(hex(parsed.digest), hex(digest));
    assert.equal(parsed.hashOp, 'sha256');
  });

  it('begins with the documented header magic + version 1 + sha256 op tag', () => {
    const a = serializeDetached(detached);
    assert.deepEqual(a.subarray(0, OTS_MAGIC.length), OTS_MAGIC);
    assert.equal(a[OTS_MAGIC.length], 0x01); // major version
    assert.equal(a[OTS_MAGIC.length + 1], 0x08); // sha256 file-hash op
  });

  it('rejects a non-OTS buffer (bad magic)', () => {
    assert.throws(() => parseDetached(new Uint8Array(40)), /not an OpenTimestamps/i);
  });

  it('rejects an unknown file-hash op tag', () => {
    const bad = serializeDetached(detached).slice();
    bad[OTS_MAGIC.length + 1] = 0x99;
    assert.throws(() => parseDetached(bad), /unknown.*hash op/i);
  });

  it('rejects a truncated stream', () => {
    const a = serializeDetached(detached);
    assert.throws(() => parseDetached(a.subarray(0, a.length - 3)), /end of OTS stream|trailing/i);
  });
});
