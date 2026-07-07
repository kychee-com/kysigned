/**
 * OTS LIVE checks — F-11 (real network; run on demand, never in the offline suite).
 *
 *   node --test --import tsx "src/timestamp/**\/*.live.ts"
 *
 * Proves our own client against the real services with NO reference tool:
 *   1. real OTS calendars accept a stamp of a random hash;
 *   2. the verification MATH checks a commitment against a REAL Bitcoin block.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createOtsProvider } from './ots/provider.js';
import { createExplorerHeaderSource } from './ots/header.js';
import { verifyOts } from './ots/verify.js';
import { collectAttestations } from './ots/timestamp.js';
import { parseDetached, type DetachedTimestamp } from './ots/detached.js';

const reverse = (b: Uint8Array) => Uint8Array.from([...b].reverse());
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('OTS live', () => {
  it('real OTS calendars accept a stamp of a random hash', async () => {
    const hash = new Uint8Array(randomBytes(32));
    const proof = await createOtsProvider().stamp(hash);
    assert.equal(proof.status, 'pending');
    const detached = parseDetached(Uint8Array.from(Buffer.from(proof.data, 'base64')));
    assert.equal(hex(detached.digest), hex(hash));
    const pendings = collectAttestations(detached.timestamp).filter((a) => a.attestation.kind === 'pending');
    assert.ok(pendings.length >= 1, 'expected ≥1 real pending calendar attestation');
  });

  it('the verify MATH checks a commitment against a REAL Bitcoin block', async () => {
    const headerSource = createExplorerHeaderSource();
    const height = 800000;
    const header = await headerSource.getBlockHeader(height);
    // A proof asserting "<block 800000's merkle root> is committed to block 800000".
    // Our verify must fetch the real block, match the merkle root, and read its real time.
    const commitment = reverse(fromHex(header.merkleRoot));
    const proof: DetachedTimestamp = {
      hashOp: 'sha256',
      digest: commitment,
      timestamp: { msg: commitment, branches: [{ type: 'attestation', attestation: { kind: 'bitcoin', height } }] },
    };
    const res = await verifyOts(proof, commitment, { headerSource });
    assert.equal(res.ok, true);
    assert.equal(res.timeSec, header.timeSec); // the real block header time
    assert.match(res.anchor, /800000/);
  });
});
