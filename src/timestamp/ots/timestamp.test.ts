import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  serializeTimestamp,
  deserializeTimestamp,
  collectAttestations,
  type Timestamp,
} from './timestamp.js';
import { Reader, Writer } from './serialization.js';

const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const concat = (a: Uint8Array, b: Uint8Array) => {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
};
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const digest = sha256(Uint8Array.from([1, 2, 3]));
const nonce = Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd]);
const appended = concat(digest, nonce);
const leafMsg = sha256(appended);

// root: [ pending(uri), append(nonce) -> sha256 -> bitcoin(800000) ]
const tree: Timestamp = {
  msg: digest,
  branches: [
    { type: 'attestation', attestation: { kind: 'pending', uri: 'https://a.pool.opentimestamps.org' } },
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
              msg: leafMsg,
              branches: [{ type: 'attestation', attestation: { kind: 'bitcoin', height: 800000 } }],
            },
          },
        ],
      },
    },
  ],
};

function serialize(ts: Timestamp): Uint8Array {
  const w = new Writer();
  serializeTimestamp(ts, w);
  return w.getBytes();
}

describe('OTS timestamp tree', () => {
  it('serialize → parse → serialize is byte-for-byte stable', () => {
    const bytesA = serialize(tree);
    const parsed = deserializeTimestamp(new Reader(bytesA), digest);
    assert.deepEqual(serialize(parsed), bytesA);
  });

  it('parse recomputes node messages by applying the ops', () => {
    const parsed = deserializeTimestamp(new Reader(serialize(tree)), digest);
    const atts = collectAttestations(parsed);
    const pending = atts.find((a) => a.attestation.kind === 'pending');
    const bitcoin = atts.find((a) => a.attestation.kind === 'bitcoin');
    assert.ok(pending?.attestation.kind === 'pending' && pending.attestation.uri.includes('opentimestamps'));
    assert.ok(bitcoin?.attestation.kind === 'bitcoin' && bitcoin.attestation.height === 800000);
    // the bitcoin commitment is the message at the attestation node = sha256(digest ++ nonce)
    assert.equal(hex(bitcoin!.msg), hex(leafMsg));
  });

  it('uses a 0xff marker when a node has more than one branch', () => {
    // root has 2 branches → the stream starts with 0xff
    assert.equal(serialize(tree)[0], 0xff);
  });
});
