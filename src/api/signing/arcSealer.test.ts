/**
 * verifiedFirstArcSealer — F-45.1 "Microsoft 365, unsigned" (spec 0.73.0, AC-279; DD-71).
 *
 * Offline ARC rig: real mailauth seals (`sealMessage`) made with generated keys, served
 * by an injected resolver under the sealer's own name (e.g.
 * `arcselector10001._domainkey.microsoft.com`), so a chain verifies exactly as it would
 * against a live key. Only the key is a stand-in; the sealing and the verification are
 * the real library code the inbound path runs.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { sealMessage, type ARCSealOptions } from 'mailauth';
import { verifyDkim, type DkimResolver } from './dkimVerify.js';
import { verifiedFirstArcSealer } from './arcSealer.js';

const MS_KEY = 'arcselector10001._domainkey.microsoft.com';
const GOOGLE_KEY = 'arc-20240605._domainkey.google.com';
const RELAY_KEY = 'arc._domainkey.relay.example.net';

type KeyPair = { privateKey: string; txt: string };
function keyPair(modulusLength = 2048): KeyPair {
  const kp = generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const der = kp.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return { privateKey: kp.privateKey, txt: `v=DKIM1; k=rsa; p=${der}` };
}

let microsoft: KeyPair;
let google: KeyPair;
let relay: KeyPair;
let impostor: KeyPair;
before(() => {
  microsoft = keyPair();
  google = keyPair();
  relay = keyPair();
  impostor = keyPair();
});

/** Serves exactly the given TXT records (names matched case-insensitively), else ENOTFOUND. */
function resolverServing(records: Record<string, string>): DkimResolver {
  return async (name, rrtype) => {
    const txt = records[String(name).toLowerCase()];
    if (String(rrtype).toLowerCase() === 'txt' && txt) return [[txt]];
    const e = new Error('ENOTFOUND') as Error & { code?: string };
    e.code = 'ENOTFOUND';
    throw e;
  };
}

/** An unsigned forward: no DKIM-Signature at all (Microsoft's documented no-DKIM shape). */
function unsignedForward(): string {
  return [
    'From: Dana Cohen <dana.cohen@northwind.example>',
    'To: forward-to-sign@kysigned.com',
    'Subject: FW: Signature requested: "acme" [ksgn-18267982ca7645dca294e86039a6343d]',
    'Date: Wed, 23 Sep 2026 09:41:07 +0000',
    'Message-ID: <fwd-arc@northwind.example>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=us-ascii',
    '',
    'I sign this document',
    '',
    '________________________________',
    'From: kysigned <forward-to-sign@kysigned.com>',
    '',
  ].join('\r\n');
}

/** Prepend the next ARC set, sealed by `signingDomain`, the way a sending hop does. */
async function seal(raw: string, key: KeyPair, signingDomain: string, selector: string, cv: 'none' | 'pass' = 'none'): Promise<string> {
  // mailauth's createSeal reads `cv` and `authResults`, which its typings leave out.
  const opts: ARCSealOptions & { cv: string; authResults: string } = {
    signingDomain,
    selector,
    privateKey: key.privateKey,
    cv,
    authResults: `mx.${signingDomain.toLowerCase()} 1; spf=none; dmarc=none; dkim=none; arc=${cv}`,
    signTime: new Date('2026-09-23T09:41:08Z'),
  };
  return (await sealMessage(raw, opts)).toString('utf8') + raw;
}

async function firstSealer(raw: string, resolver: DkimResolver): Promise<string | null> {
  const outcome = await verifyDkim(raw, { resolver });
  return verifiedFirstArcSealer(outcome.arc, { resolver });
}

describe('verifiedFirstArcSealer — who sealed an unsigned forward first (F-45.1, DD-71)', () => {
  it('verifyDkim hands on the ARC chain it already parsed', async () => {
    const sealed = await seal(unsignedForward(), microsoft, 'microsoft.com', 'arcselector10001');
    const outcome = await verifyDkim(sealed, { resolver: resolverServing({ [MS_KEY]: microsoft.txt }) });
    const chain = outcome.arc?.chain;
    assert.ok(Array.isArray(chain), 'the parsed chain is exposed');
    assert.equal(chain.length, 1);
  });

  it('a verifying Microsoft seal → microsoft.com', async () => {
    const sealed = await seal(unsignedForward(), microsoft, 'microsoft.com', 'arcselector10001');
    assert.equal(await firstSealer(sealed, resolverServing({ [MS_KEY]: microsoft.txt })), 'microsoft.com');
  });

  it('names whoever sealed it: a Google seal → google.com', async () => {
    const sealed = await seal(unsignedForward(), google, 'google.com', 'arc-20240605');
    assert.equal(await firstSealer(sealed, resolverServing({ [GOOGLE_KEY]: google.txt })), 'google.com');
  });

  it('a gateway sealing after Microsoft keeps Microsoft as the first sealer', async () => {
    const once = await seal(unsignedForward(), microsoft, 'microsoft.com', 'arcselector10001');
    const twice = await seal(once, relay, 'relay.example.net', 'arc', 'pass');
    const resolver = resolverServing({ [MS_KEY]: microsoft.txt, [RELAY_KEY]: relay.txt });
    assert.equal(await firstSealer(twice, resolver), 'microsoft.com');
  });

  it('a Microsoft hop that is NOT the first does not make the origin Microsoft', async () => {
    const once = await seal(unsignedForward(), google, 'google.com', 'arc-20240605');
    const twice = await seal(once, microsoft, 'microsoft.com', 'arcselector10001', 'pass');
    const resolver = resolverServing({ [GOOGLE_KEY]: google.txt, [MS_KEY]: microsoft.txt });
    assert.equal(await firstSealer(twice, resolver), 'google.com');
  });

  it('lowercases the sealing domain', async () => {
    const sealed = await seal(unsignedForward(), microsoft, 'Microsoft.COM', 'arcselector10001');
    assert.equal(await firstSealer(sealed, resolverServing({ [MS_KEY]: microsoft.txt })), 'microsoft.com');
  });

  it('a body edited after sealing → null', async () => {
    const sealed = await seal(unsignedForward(), microsoft, 'microsoft.com', 'arcselector10001');
    const edited = sealed.replace('From: kysigned <forward-to-sign@kysigned.com>', 'From: someone else');
    assert.notEqual(edited, sealed);
    assert.equal(await firstSealer(edited, resolverServing({ [MS_KEY]: microsoft.txt })), null);
  });

  it("a seal made with any other key under Microsoft's name → null (what the live service sees)", async () => {
    const forged = await seal(unsignedForward(), impostor, 'microsoft.com', 'arcselector10001');
    assert.equal(await firstSealer(forged, resolverServing({ [MS_KEY]: microsoft.txt })), null);
  });

  it('the seal key missing from DNS → null', async () => {
    const sealed = await seal(unsignedForward(), microsoft, 'microsoft.com', 'arcselector10001');
    assert.equal(await firstSealer(sealed, resolverServing({})), null);
  });

  it('no ARC chain → null', async () => {
    assert.equal(await firstSealer(unsignedForward(), resolverServing({ [MS_KEY]: microsoft.txt })), null);
  });

  it('an undersized seal key → null, never a throw', async () => {
    const weak = keyPair(512);
    const sealed = await seal(unsignedForward(), weak, 'microsoft.com', 'arcselector10001');
    assert.equal(await firstSealer(sealed, resolverServing({ [MS_KEY]: weak.txt })), null);
  });

  it('no ARC data at all → null, never a throw', async () => {
    assert.equal(await verifiedFirstArcSealer(undefined), null);
    assert.equal(await verifiedFirstArcSealer({ chain: false }), null);
  });
});
