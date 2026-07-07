/**
 * Browser-safety guard for the OTS verify path — F-10.6 / AC-99.
 *
 * The /verify SPA confirms the Bitcoin anchor client-side with NO Node Buffer
 * (vite ships no Buffer polyfill). This builds the `.ots` bytes while Buffer
 * exists, then DELETES `globalThis.Buffer` and asserts the same parse + verify
 * pipeline (parseDetached → verifyOts) still returns the correct verdict — a
 * COMPLETE (Bitcoin-attested) proof confirms with the block time/height, a
 * PENDING proof does not. Mirrors the RFC-3161 `.tsr` browser-safety guard.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyOts } from './verify.js';
import { serializeDetached, parseDetached, type DetachedTimestamp } from './detached.js';
import type { HeaderSource } from './header.js';
import { upgradeTimestamp } from './calendar.js';
import { collectAttestations, serializeTimestamp, type Timestamp } from './timestamp.js';
import { Writer } from './serialization.js';

const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const reverse = (b: Uint8Array) => Uint8Array.from([...b].reverse());
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

const hash = sha256(Uint8Array.from([9, 9, 9]));
const nonce = Uint8Array.from(Array.from({ length: 16 }, (_, i) => i + 3));
const appended = Uint8Array.from([...hash, ...nonce]);
const leaf = sha256(appended); // the value committed to the block's merkle root

// hash --append(nonce)--> --sha256--> leaf --[bitcoin(height 750000)]
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

const pendingProof: DetachedTimestamp = {
  hashOp: 'sha256',
  digest: hash,
  timestamp: { msg: hash, branches: [{ type: 'attestation', attestation: { kind: 'pending', uri: 'https://cal' } }] },
};

/** A block whose merkle root (internal LE) equals `merkleInternal`; explorers show it reversed. */
function fakeHeaderSource(merkleInternal: Uint8Array, timeSec = 1700000000): HeaderSource {
  return {
    async getBlockHeader(height) {
      return { height, merkleRoot: toHex(reverse(merkleInternal)), timeSec, blockHash: 'feedface' };
    },
  };
}

// Serialize the `.ots` bytes WHILE Buffer still exists (the bundle carries these).
const completeBytes = serializeDetached(completeProof);
const pendingBytes = serializeDetached(pendingProof);

describe('OTS verify is browser-safe (no Node Buffer) — F-10.6 / AC-99', () => {
  it('parse + verifyOts run with globalThis.Buffer deleted', async () => {
    const savedBuffer = globalThis.Buffer;
    let completeRes: Awaited<ReturnType<typeof verifyOts>>;
    let pendingRes: Awaited<ReturnType<typeof verifyOts>>;
    try {
      // @ts-expect-error simulate the browser global scope (no Node Buffer)
      delete globalThis.Buffer;
      completeRes = await verifyOts(parseDetached(completeBytes), hash, { headerSource: fakeHeaderSource(leaf) });
      pendingRes = await verifyOts(parseDetached(pendingBytes), hash, { headerSource: fakeHeaderSource(leaf) });
    } finally {
      globalThis.Buffer = savedBuffer;
    }
    assert.equal(completeRes.ok, true, 'complete proof must verify without Node Buffer');
    assert.equal(completeRes.timeSec, 1700000000, 'time comes from the block header');
    assert.match(completeRes.anchor, /750000/, 'anchor names the Bitcoin block height');
    assert.equal(pendingRes.ok, false, 'a pending (not-yet-anchored) proof is not confirmed');
  });
});

// A pending timestamp tree + a fake calendar that confirms with a Bitcoin attestation.
const pendingTs: Timestamp = {
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
            child: { msg: leaf, branches: [{ type: 'attestation', attestation: { kind: 'pending', uri: 'https://cal' } }] },
          },
        ],
      },
    },
  ],
};

// Build the confirming-response bytes BEFORE Buffer is deleted, and return a minimal
// Response-like object: a real Node `Response` body itself needs Buffer (undici),
// which would mask what we're actually testing — that the OTS upgrade CODE is
// Buffer-free. A real browser's native fetch/Response have no such dependency.
const confirmBytes = (() => {
  const w = new Writer();
  serializeTimestamp(
    { msg: new Uint8Array(), branches: [{ type: 'attestation', attestation: { kind: 'bitcoin', height: 800001 } }] },
    w,
  );
  return w.getBytes();
})();
const confirmingCalendar = (): typeof fetch =>
  (async () => ({ ok: true, arrayBuffer: async () => confirmBytes.slice().buffer })) as unknown as typeof fetch;

describe('OTS calendar upgrade is browser-safe (no Node Buffer) — F-10.6 / AC-99', () => {
  it('upgrades a pending proof with globalThis.Buffer deleted', async () => {
    const savedBuffer = globalThis.Buffer;
    let res: Awaited<ReturnType<typeof upgradeTimestamp>>;
    try {
      // @ts-expect-error simulate the browser global scope (no Node Buffer)
      delete globalThis.Buffer;
      res = await upgradeTimestamp(pendingTs, { fetchFn: confirmingCalendar() });
    } finally {
      globalThis.Buffer = savedBuffer;
    }
    assert.equal(res.upgraded, true, 'upgrade must work without Node Buffer');
    const bitcoin = collectAttestations(res.timestamp).filter((a) => a.attestation.kind === 'bitcoin');
    assert.equal(bitcoin.length, 1, 'the upgraded proof now carries a Bitcoin attestation');
  });
});
