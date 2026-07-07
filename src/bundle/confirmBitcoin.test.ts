/**
 * confirmOtsAnchor — the explicit online Bitcoin confirmation (F-10.6 / AC-99).
 *
 * Drives the offline-first web flow's "Confirm on Bitcoin" action: given a
 * signer's embedded `.ots` + its `.eml` hash, best-effort UPGRADE the proof via
 * the OTS calendar, then VERIFY it against a Bitcoin block header. Returns
 * `confirmed` (with block height + time) or stays `pending` — never throws, and
 * never anything that could fail the bundle (it's additive).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { confirmOtsAnchor } from './confirmBitcoin.js';
import { serializeDetached, type DetachedTimestamp } from '../timestamp/ots/detached.js';
import { serializeTimestamp } from '../timestamp/ots/timestamp.js';
import { Writer } from '../timestamp/ots/serialization.js';
import type { HeaderSource } from '../timestamp/ots/header.js';

const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const reverse = (b: Uint8Array) => Uint8Array.from([...b].reverse());
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

const hash = sha256(Uint8Array.from([9, 9, 9]));
const nonce = Uint8Array.from(Array.from({ length: 16 }, (_, i) => i + 3));
const appended = Uint8Array.from([...hash, ...nonce]);
const leaf = sha256(appended);

const child = (kind: 'bitcoin' | 'pending') =>
  kind === 'bitcoin'
    ? { msg: leaf, branches: [{ type: 'attestation' as const, attestation: { kind: 'bitcoin' as const, height: 750000 } }] }
    : { msg: leaf, branches: [{ type: 'attestation' as const, attestation: { kind: 'pending' as const, uri: 'https://cal' } }] };

const proofWith = (kind: 'bitcoin' | 'pending'): DetachedTimestamp => ({
  hashOp: 'sha256',
  digest: hash,
  timestamp: {
    msg: hash,
    branches: [
      { type: 'op', op: { kind: 'append', arg: nonce }, child: { msg: appended, branches: [{ type: 'op', op: { kind: 'sha256' }, child: child(kind) }] } },
    ],
  },
});

const completeBytes = serializeDetached(proofWith('bitcoin'));
const pendingBytes = serializeDetached(proofWith('pending'));

function fakeHeader(merkleInternal: Uint8Array): HeaderSource {
  return { async getBlockHeader(height) { return { height, merkleRoot: toHex(reverse(merkleInternal)), timeSec: 1_700_000_000, blockHash: 'feedface' }; } };
}

// A calendar that "confirms" the leaf with a Bitcoin attestation (drives upgrade).
const confirmBytes = (() => {
  const w = new Writer();
  serializeTimestamp({ msg: new Uint8Array(), branches: [{ type: 'attestation', attestation: { kind: 'bitcoin', height: 750000 } }] }, w);
  return w.getBytes();
})();
const confirmingCal = (() => (async () => ({ ok: true, arrayBuffer: async () => confirmBytes.slice().buffer })) as unknown as typeof fetch)();
const idleCal = (() => (async () => ({ ok: false })) as unknown as typeof fetch)();

describe('confirmOtsAnchor — online Bitcoin confirmation (F-10.6 / AC-99)', () => {
  it('a complete (Bitcoin-attested) proof → confirmed with block height + time', async () => {
    const a = await confirmOtsAnchor(completeBytes, hash, { headerSource: fakeHeader(leaf), fetchFn: idleCal });
    assert.equal(a.status, 'confirmed');
    assert.equal(a.blockHeight, 750000);
    assert.equal(a.timeSec, 1_700_000_000);
  });

  it('a pending proof the calendar now confirms → upgraded to confirmed', async () => {
    const a = await confirmOtsAnchor(pendingBytes, hash, { headerSource: fakeHeader(leaf), fetchFn: confirmingCal });
    assert.equal(a.status, 'confirmed');
    assert.equal(a.blockHeight, 750000);
  });

  it('a pending proof the calendar has not confirmed → stays pending', async () => {
    const a = await confirmOtsAnchor(pendingBytes, hash, { headerSource: fakeHeader(leaf), fetchFn: idleCal });
    assert.equal(a.status, 'pending');
  });

  it('garbage bytes → pending (never throws)', async () => {
    const a = await confirmOtsAnchor(Uint8Array.from([1, 2, 3]), hash, { headerSource: fakeHeader(leaf), fetchFn: idleCal });
    assert.equal(a.status, 'pending');
  });
});
