import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyOts } from './verify.js';
import type { DetachedTimestamp } from './detached.js';
import type { HeaderSource } from './header.js';

const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const reverse = (b: Uint8Array) => Uint8Array.from([...b].reverse());
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const hash = sha256(Uint8Array.from([9, 9, 9]));
const nonce = Uint8Array.from(Array.from({ length: 16 }, (_, i) => i + 3));
const appended = Uint8Array.from([...hash, ...nonce]);
const leaf = sha256(appended); // the value committed to the block's merkle root

// complete proof: hash --append(nonce)--> --sha256--> leaf --[bitcoin(height 750000)]
const completeProof: DetachedTimestamp = {
  hashOp: 'sha256',
  digest: hash,
  timestamp: {
    msg: hash,
    branches: [
      {
        type: 'op',
        op: { kind: 'append', arg: nonce },
        child: {
          msg: appended,
          branches: [
            {
              type: 'op',
              op: { kind: 'sha256' },
              child: {
                msg: leaf,
                branches: [{ type: 'attestation', attestation: { kind: 'bitcoin', height: 750000 } }],
              },
            },
          ],
        },
      },
    ],
  },
};

/** A block whose merkle root (internal LE) equals `merkleInternal`; explorers show it reversed. */
function fakeHeaderSource(merkleInternal: Uint8Array, timeSec = 1700000000): HeaderSource {
  return {
    async getBlockHeader(height) {
      return { height, merkleRoot: hex(reverse(merkleInternal)), timeSec, blockHash: 'feedface' };
    },
  };
}

describe('OTS verify against the chain (AC-10, AC-11)', () => {
  it('verifies a complete proof and returns the block time + anchor', async () => {
    const res = await verifyOts(completeProof, hash, { headerSource: fakeHeaderSource(leaf) });
    assert.equal(res.ok, true);
    assert.equal(res.timeSec, 1700000000);
    assert.match(res.anchor, /750000/);
  });

  it('fails for the wrong hash', async () => {
    const res = await verifyOts(completeProof, sha256(Uint8Array.from([0])), { headerSource: fakeHeaderSource(leaf) });
    assert.equal(res.ok, false);
  });

  it('fails when the commitment does not match the block merkle root (tamper)', async () => {
    const wrongRoot = sha256(Uint8Array.from([1, 2, 3]));
    const res = await verifyOts(completeProof, hash, { headerSource: fakeHeaderSource(wrongRoot) });
    assert.equal(res.ok, false);
  });

  it('fails for a pending-only proof (no Bitcoin anchor)', async () => {
    const pending: DetachedTimestamp = {
      hashOp: 'sha256',
      digest: hash,
      timestamp: { msg: hash, branches: [{ type: 'attestation', attestation: { kind: 'pending', uri: 'https://cal' } }] },
    };
    const res = await verifyOts(pending, hash, { headerSource: fakeHeaderSource(leaf) });
    assert.equal(res.ok, false);
  });

  it('re-derives the commitment from the hash, so a mutated op arg fails', async () => {
    // Same shape but a different nonce → the derived leaf no longer equals the block root.
    // (Stored msg fields are deliberately left as the originals; verify must ignore them.)
    const tampered: DetachedTimestamp = {
      hashOp: 'sha256',
      digest: hash,
      timestamp: {
        msg: hash,
        branches: [
          {
            type: 'op',
            op: { kind: 'append', arg: Uint8Array.from(Array(16).fill(99)) },
            child: {
              msg: appended,
              branches: [
                {
                  type: 'op',
                  op: { kind: 'sha256' },
                  child: { msg: leaf, branches: [{ type: 'attestation', attestation: { kind: 'bitcoin', height: 750000 } }] },
                },
              ],
            },
          },
        ],
      },
    };
    const res = await verifyOts(tampered, hash, { headerSource: fakeHeaderSource(leaf) });
    assert.equal(res.ok, false);
  });
});
