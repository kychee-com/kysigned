import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { upgradeTimestamp } from './calendar.js';
import { collectAttestations, serializeTimestamp, type Timestamp } from './timestamp.js';
import { Writer } from './serialization.js';

const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const digest = sha256(Uint8Array.from([5, 5]));
const nonce = Uint8Array.from(Array.from({ length: 16 }, (_, i) => i));
const appended = Uint8Array.from([...digest, ...nonce]);
const leaf = sha256(appended);

const pendingProof: Timestamp = {
  msg: digest,
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
              branches: [{ type: 'attestation', attestation: { kind: 'pending', uri: 'https://cal.example.org' } }],
            },
          },
        ],
      },
    },
  ],
};

function fakeUpgrade(opts: { confirm: boolean; urls?: string[] }): typeof fetch {
  return async (url) => {
    opts.urls?.push(String(url));
    if (!opts.confirm) return new Response('not found', { status: 404 });
    const w = new Writer();
    serializeTimestamp(
      { msg: new Uint8Array(), branches: [{ type: 'attestation', attestation: { kind: 'bitcoin', height: 800001 } }] },
      w,
    );
    return new Response(w.getBytes(), { status: 200 });
  };
}

describe('OTS upgrade (AC-8)', () => {
  it('upgrades a pending proof to Bitcoin-anchored once the calendar confirms', async () => {
    const { timestamp, upgraded } = await upgradeTimestamp(pendingProof, { fetchFn: fakeUpgrade({ confirm: true }) });
    assert.equal(upgraded, true);
    const bitcoin = collectAttestations(timestamp).filter((a) => a.attestation.kind === 'bitcoin');
    assert.equal(bitcoin.length, 1);
  });

  it('is a no-op while the calendar has not confirmed (stays pending)', async () => {
    const { timestamp, upgraded } = await upgradeTimestamp(pendingProof, { fetchFn: fakeUpgrade({ confirm: false }) });
    assert.equal(upgraded, false);
    const pendings = collectAttestations(timestamp).filter((a) => a.attestation.kind === 'pending');
    assert.equal(pendings.length, 1);
  });

  it('GETs <calendar>/timestamp/<commitment-hex>', async () => {
    const urls: string[] = [];
    await upgradeTimestamp(pendingProof, { fetchFn: fakeUpgrade({ confirm: false, urls }) });
    assert.ok(urls[0].includes('/timestamp/'), urls[0]);
    assert.ok(urls[0].includes(hex(leaf)), urls[0]);
  });
});
