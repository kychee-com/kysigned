import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stampWithCalendars } from './calendar.js';
import { collectAttestations, serializeTimestamp } from './timestamp.js';
import { Writer } from './serialization.js';

const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const digest = sha256(Uint8Array.from([4, 2]));
const fixedNonce = Uint8Array.from(Array.from({ length: 16 }, (_, i) => i + 1));

/** A fake calendar: records the submitted body and returns a pending-attestation tree. */
function fakeCalendars(opts: { fail?: string[]; seen?: Uint8Array[] } = {}) {
  const fetchFn: typeof fetch = async (url, init) => {
    const u = String(url);
    if (opts.fail?.some((f) => u.includes(f))) return new Response('down', { status: 500 });
    if (init?.body && opts.seen) opts.seen.push(new Uint8Array(init.body as ArrayBuffer));
    const host = new URL(u).host;
    const w = new Writer();
    serializeTimestamp(
      { msg: new Uint8Array(), branches: [{ type: 'attestation', attestation: { kind: 'pending', uri: `https://${host}` } }] },
      w,
    );
    return new Response(w.getBytes(), { status: 200 });
  };
  return fetchFn;
}

const CALS = ['https://a.example.org', 'https://b.example.org'];

describe('OTS calendar stamping (AC-6, AC-7)', () => {
  it('submits sha256(digest‖nonce) to ≥2 calendars and returns a pending proof', async () => {
    const seen: Uint8Array[] = [];
    const ts = await stampWithCalendars(digest, CALS, { fetchFn: fakeCalendars({ seen }), randomBytes: () => fixedNonce });
    // both calendars were hit with the nonce-appended leaf
    const leaf = sha256(Uint8Array.from([...digest, ...fixedNonce]));
    assert.equal(seen.length, 2);
    for (const body of seen) assert.equal(hex(body), hex(leaf));
    // proof carries a pending attestation per calendar
    const pendings = collectAttestations(ts).filter((a) => a.attestation.kind === 'pending');
    assert.equal(pendings.length, 2);
  });

  it('tolerates partial failure — succeeds if ≥1 calendar responds (AC-7)', async () => {
    const ts = await stampWithCalendars(digest, CALS, {
      fetchFn: fakeCalendars({ fail: ['b.example.org'] }),
      randomBytes: () => fixedNonce,
    });
    const pendings = collectAttestations(ts).filter((a) => a.attestation.kind === 'pending');
    assert.equal(pendings.length, 1);
  });

  it('fails only when ALL calendars are unreachable', async () => {
    await assert.rejects(
      () =>
        stampWithCalendars(digest, CALS, {
          fetchFn: fakeCalendars({ fail: ['a.example.org', 'b.example.org'] }),
          randomBytes: () => fixedNonce,
        }),
      /all calendars/i,
    );
  });

  it('rejects a non-32-byte digest before any network call', async () => {
    let called = false;
    await assert.rejects(() =>
      stampWithCalendars(new Uint8Array(10), CALS, {
        fetchFn: (async () => {
          called = true;
          return new Response('', { status: 200 });
        }) as typeof fetch,
      }),
    );
    assert.equal(called, false);
  });
});
