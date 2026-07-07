import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serializeAttestation, parseAttestation, type Attestation } from './attestation.js';
import { Reader, Writer } from './serialization.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function roundtrip(att: Attestation): { bytes: Uint8Array; parsed: Attestation } {
  const w = new Writer();
  serializeAttestation(att, w);
  const bytes = w.getBytes();
  const parsed = parseAttestation(new Reader(bytes));
  return { bytes, parsed };
}

function reserialize(att: Attestation): Uint8Array {
  const w = new Writer();
  serializeAttestation(att, w);
  return w.getBytes();
}

describe('OTS attestations', () => {
  it('pending attestation round-trips and starts with the pending tag', () => {
    const att: Attestation = { kind: 'pending', uri: 'https://alice.btc.calendar.opentimestamps.org' };
    const { bytes, parsed } = roundtrip(att);
    assert.deepEqual(parsed, att);
    assert.equal(hex(bytes.subarray(0, 8)), '83dfe30d2ef90c8e');
    assert.deepEqual(reserialize(parsed), bytes); // byte-for-byte
  });

  it('bitcoin block-header attestation round-trips and starts with the bitcoin tag', () => {
    const att: Attestation = { kind: 'bitcoin', height: 800000 };
    const { bytes, parsed } = roundtrip(att);
    assert.deepEqual(parsed, att);
    assert.equal(hex(bytes.subarray(0, 8)), '0588960d73d71901');
    assert.deepEqual(reserialize(parsed), bytes);
  });

  it('an unknown attestation tag is preserved byte-for-byte', () => {
    const att: Attestation = {
      kind: 'unknown',
      tag: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
      payload: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
    };
    const { bytes, parsed } = roundtrip(att);
    assert.deepEqual(parsed, att);
    assert.deepEqual(reserialize(parsed), bytes);
  });
});
