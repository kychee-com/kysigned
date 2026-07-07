import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRfc3161Provider } from './provider.js';
import { parseTimeStampReq } from './tsp.js';
import { createOtsProvider } from '../ots/provider.js';

const here = dirname(fileURLToPath(import.meta.url));
const respFixture = new Uint8Array(readFileSync(join(here, 'fixtures', 'freetsa-resp.der')));
const fixtureHash = Uint8Array.from(Buffer.from(readFileSync(join(here, 'fixtures', 'hash.hex'), 'utf8').trim(), 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function fakeTsa(capture?: Uint8Array[]): typeof fetch {
  return async (_url, init) => {
    if (init?.body && capture) capture.push(new Uint8Array(init.body as ArrayBuffer));
    return new Response(respFixture, { status: 200 });
  };
}

describe('RFC 3161 provider (AC-15 stamp, AC-16 verify, AC-17 trust label)', () => {
  it('stamp builds a request for the hash and returns a complete token proof', async () => {
    const cap: Uint8Array[] = [];
    const p = createRfc3161Provider({ tsaUrl: 'https://tsa.example/tsr', fetchFn: fakeTsa(cap) });
    const proof = await p.stamp(fixtureHash);
    assert.equal(proof.provider, 'rfc3161');
    assert.equal(proof.status, 'complete');
    assert.ok(proof.data.length > 0);
    assert.equal(hex(parseTimeStampReq(cap[0]).hashedMessage), hex(fixtureHash));
  });

  it('verify validates the token + imprint → ok with TSA genTime', async () => {
    const p = createRfc3161Provider({ fetchFn: fakeTsa() });
    const res = await p.verify(await p.stamp(fixtureHash), fixtureHash);
    assert.equal(res.ok, true);
    assert.ok(res.timeSec > 1_600_000_000);
    assert.match(res.anchor, /rfc3161/);
  });

  it('verify fails for the wrong hash', async () => {
    const p = createRfc3161Provider({ fetchFn: fakeTsa() });
    const proof = await p.stamp(fixtureHash);
    const wrong = Uint8Array.from(fixtureHash);
    wrong[0] ^= 0xff;
    assert.equal((await p.verify(proof, wrong)).ok, false);
  });

  it('verify runs with NO Node Buffer — verifyBundleWeb verifies the .tsr in the browser where `Buffer` is undefined (Barry QA: a Buffer base64-decode silently failed → "no valid timestamp proof")', async () => {
    const p = createRfc3161Provider({ fetchFn: fakeTsa() });
    const proof = await p.stamp(fixtureHash); // build the proof while Buffer still exists
    const savedBuffer = globalThis.Buffer;
    let ok = false;
    try {
      // @ts-expect-error simulate the browser global scope (no Node Buffer)
      delete globalThis.Buffer;
      ok = (await p.verify(proof, fixtureHash)).ok;
    } finally {
      globalThis.Buffer = savedBuffer;
    }
    assert.equal(ok, true, 'RFC 3161 token must verify without Node Buffer (the in-browser verify path)');
  });

  it('labels its trust model as a trusted third party, distinct from OTS', () => {
    assert.equal(createRfc3161Provider().trustModel, 'trusted-third-party');
    assert.notEqual(createRfc3161Provider().trustModel, createOtsProvider().trustModel);
  });

  it('stamp rejects a non-32-byte hash', async () => {
    await assert.rejects(() => createRfc3161Provider({ fetchFn: fakeTsa() }).stamp(new Uint8Array(8)));
  });
});
