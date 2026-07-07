/**
 * DIFFERENTIAL test — verifyDkimWeb (WebCrypto) MUST agree with mailauth (the
 * mainstream Node verifier) on a valid message across canonicalization modes and
 * on every tamper. A divergence fails the build, which is what lets a hand-written
 * RFC-6376 canonicalizer sit on the trust boundary: it is provably equivalent to
 * the vetted tool, with the platform's WebCrypto doing the actual RSA/SHA-256.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { dkimSign } from 'mailauth';
import { verifyDkimWeb } from './dkimVerifyWeb.js';
import { verifyDkim, type DkimResolver } from '../api/signing/dkimVerify.js';
import { evaluateDkimPolicy } from '../api/signing/dkimPolicy.js';

let privateKey = '';
let txtRecord = '';

before(() => {
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKey = kp.privateKey;
  txtRecord = `v=DKIM1; k=rsa; p=${kp.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')}`;
});

const lookup = (domain: string, selector: string) =>
  domain === 'example.com' && selector === 'test' ? txtRecord : null;

function resolver(record: string | null = txtRecord): DkimResolver {
  return async (name, rrtype) => {
    if (record && String(rrtype).toLowerCase() === 'txt' && name === 'test._domainkey.example.com') {
      return [[record]];
    }
    const e = new Error('ENOTFOUND') as Error & { code?: string };
    e.code = 'ENOTFOUND';
    throw e;
  };
}

/** The mainstream oracle: mailauth verify → our policy → ok? */
async function oracleOk(raw: string, res: DkimResolver = resolver()): Promise<boolean> {
  return evaluateDkimPolicy(await verifyDkim(raw, { resolver: res })).ok;
}

function buildMsg(opts: { from?: string; subject?: string; body?: string } = {}): string {
  return [
    `From: ${opts.from ?? 'Alice <alice@example.com>'}`,
    'To: bob@acme.com',
    `Subject: ${opts.subject ?? 'Hello there'}`,
    'Date: Sat, 14 Jun 2026 10:00:00 +0000',
    'Message-ID: <m@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=us-ascii',
    '',
    opts.body ?? 'Line one with   spaces  \r\nLine two\r\n\r\n',
  ].join('\r\n');
}

async function sign(raw: string, canon: string, domain = 'example.com'): Promise<string> {
  const res = await dkimSign(raw, {
    canonicalization: canon,
    signTime: new Date('2026-06-14T10:00:00Z'),
    signatureData: [{ signingDomain: domain, selector: 'test', privateKey, algorithm: 'rsa-sha256' }],
  });
  return res.signatures + raw;
}

describe('verifyDkimWeb — agrees with mailauth on a VALID message (all canon modes)', () => {
  for (const canon of ['relaxed/relaxed', 'relaxed/simple', 'simple/relaxed', 'simple/simple']) {
    it(`c=${canon}: both PROVEN`, async () => {
      const signed = await sign(buildMsg(), canon);
      const web = await verifyDkimWeb(signed, lookup);
      assert.equal(web.ok, true, `web verifier should pass for ${canon}`);
      assert.equal(web.signingDomain, 'example.com');
      assert.equal(await oracleOk(signed), true, `mailauth should pass for ${canon}`);
    });
  }
});

describe('verifyDkimWeb — agrees with mailauth on every TAMPER', () => {
  it('a flipped body byte → both FAIL', async () => {
    const signed = await sign(buildMsg(), 'relaxed/relaxed');
    const tampered = signed.replace('Line two', 'Line TWO');
    assert.equal((await verifyDkimWeb(tampered, lookup)).ok, false);
    assert.equal(await oracleOk(tampered), false);
  });

  it('a flipped signed header (Subject) → both FAIL', async () => {
    const signed = await sign(buildMsg({ subject: 'Original subject' }), 'relaxed/relaxed');
    const tampered = signed.replace('Original subject', 'Evil subject');
    assert.equal((await verifyDkimWeb(tampered, lookup)).ok, false);
    assert.equal(await oracleOk(tampered), false);
  });

  it('the wrong public key → both FAIL', async () => {
    const signed = await sign(buildMsg(), 'relaxed/relaxed');
    const wrong = 'v=DKIM1; k=rsa; p=MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAKtampered';
    assert.equal((await verifyDkimWeb(signed, () => wrong)).ok, false);
    assert.equal(await oracleOk(signed, resolver(wrong)), false);
  });

  it('a missing key → both FAIL', async () => {
    const signed = await sign(buildMsg(), 'relaxed/relaxed');
    assert.equal((await verifyDkimWeb(signed, () => null)).ok, false);
    assert.equal(await oracleOk(signed, resolver(null)), false);
  });

  it('From not aligned with d= → both FAIL (misaligned)', async () => {
    // Signed by example.com but From a different, non-subdomain domain.
    const signed = await sign(buildMsg({ from: 'mallory@evil.com' }), 'relaxed/relaxed');
    const web = await verifyDkimWeb(signed, lookup);
    assert.equal(web.ok, false);
    assert.equal(web.reason, 'misaligned');
    assert.equal(await oracleOk(signed), false);
  });

  it('no DKIM-Signature at all → both FAIL', async () => {
    const unsigned = buildMsg();
    assert.equal((await verifyDkimWeb(unsigned, lookup)).ok, false);
    assert.equal(await oracleOk(unsigned), false);
  });
});

describe('verifyDkimWeb — multi-signature (real SES adds a second d=amazonses.com sig)', () => {
  it('aligned sig + trailing non-aligned sig whose key is absent → both PASS via the aligned sig', async () => {
    // Reproduces the production bundle: SES signs outbound mail with BOTH the
    // sending-domain key (From-aligned) AND its own d=amazonses.com key, whose
    // record is NOT in keys.json. Sign the non-aligned one FIRST so it lands LAST
    // in header order — the slot a single-signature web verifier latches onto,
    // yielding a spurious missing_key while the aligned signature is right there.
    const nonAligned = await sign(buildMsg(), 'relaxed/relaxed', 'amazonses.com');
    const twoSig = await sign(nonAligned, 'relaxed/relaxed', 'example.com');
    const web = await verifyDkimWeb(twoSig, lookup);
    assert.equal(web.ok, true, 'web must verify via the aligned example.com signature');
    assert.equal(web.signingDomain, 'example.com');
    assert.equal(await oracleOk(twoSig), true, 'mailauth oracle agrees');
  });
});
