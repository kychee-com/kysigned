/**
 * Classical DKIM verification — integration test (F-6.2 / AC-17).
 *
 * Exercises the REAL mailauth crypto path fully offline: we generate an RSA keypair,
 * DKIM-sign a message with mailauth's own signer, and verify it back through an
 * injected resolver that serves the matching public key — no DNS, no network. This
 * proves `verifyDkim` maps mailauth's output into the policy's descriptors correctly
 * and that a genuinely-signed forward is ACCEPTED end-to-end (verifyDkim → policy).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { dkimSign } from 'mailauth';
import { verifyDkim, hasBodyLengthTag, type DkimResolver } from './dkimVerify.js';
import { evaluateDkimPolicy } from './dkimPolicy.js';

let privateKey = '';
let txtRecord = '';

before(() => {
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKey = kp.privateKey;
  const der = kp.publicKey
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  txtRecord = `v=DKIM1; k=rsa; p=${der}`;
});

function rawMessage(from = 'Alice <alice@example.com>'): string {
  return [
    `From: ${from}`,
    'To: reply-to-sign@kysigned.com',
    'Subject: Fwd: Please sign [ksgn-abc]',
    'Date: Fri, 13 Jun 2026 10:00:00 +0000',
    'Message-ID: <m@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=us-ascii',
    '',
    'I sign this document',
    '',
  ].join('\r\n');
}

async function sign(raw: string, signingDomain: string, expires?: Date): Promise<string> {
  const res = await dkimSign(raw, {
    canonicalization: 'relaxed/relaxed',
    signTime: new Date('2026-06-13T10:00:00Z'),
    ...(expires ? { expires } : {}),
    signatureData: [{ signingDomain, selector: 'test', privateKey, algorithm: 'rsa-sha256' }],
  });
  return res.signatures + raw;
}

/** Resolver serving `txtRecord` only at the named keys; ENOTFOUND otherwise. */
function resolverFor(keyNames: string[]): DkimResolver {
  return async (name, rrtype) => {
    if (String(rrtype).toLowerCase() === 'txt' && keyNames.includes(name)) {
      return [[txtRecord]];
    }
    const err = new Error('ENOTFOUND') as Error & { code?: string };
    err.code = 'ENOTFOUND';
    throw err;
  };
}

describe('verifyDkim — classical DKIM verification (F-6.2)', () => {
  it('verifies a genuinely-signed, From-aligned message → pass + accepted by policy', async () => {
    const signed = await sign(rawMessage(), 'example.com');
    const outcome = await verifyDkim(signed, { resolver: resolverFor(['test._domainkey.example.com']) });

    assert.equal(outcome.fromDomain, 'example.com');
    assert.equal(outcome.signatures.length, 1);
    assert.equal(outcome.signatures[0].result, 'pass');
    assert.equal(outcome.signatures[0].signingDomain, 'example.com');
    assert.equal(outcome.signatures[0].alignedDomain, 'example.com');
    assert.equal(outcome.signatures[0].algorithm, 'rsa-sha256');
    assert.equal(outcome.anyBodyLengthTag, false);

    const verdict = evaluateDkimPolicy(outcome);
    assert.equal(verdict.ok, true);
  });

  it('rejects a message whose body was altered after signing → fail / invalid_signature', async () => {
    const signed = await sign(rawMessage(), 'example.com');
    const tampered = signed.replace('I sign this document', 'I sign this document (edited)');
    const outcome = await verifyDkim(tampered, { resolver: resolverFor(['test._domainkey.example.com']) });

    assert.equal(outcome.signatures[0].result, 'fail');
    assert.equal(evaluateDkimPolicy(outcome).ok, false);
    const v = evaluateDkimPolicy(outcome);
    if (!v.ok) assert.equal(v.reason, 'invalid_signature');
  });

  it('reports missing_key when the selector key is absent from DNS', async () => {
    const signed = await sign(rawMessage(), 'example.com');
    const outcome = await verifyDkim(signed, { resolver: resolverFor([]) }); // no keys served
    const v = evaluateDkimPolicy(outcome);
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, 'missing_key');
  });

  it('rejects a valid signature whose d= is not aligned with From → misaligned', async () => {
    // Signed by other.com (key published there), but From is @example.com.
    const signed = await sign(rawMessage('Alice <alice@example.com>'), 'other.com');
    const outcome = await verifyDkim(signed, { resolver: resolverFor(['test._domainkey.other.com']) });

    assert.equal(outcome.signatures[0].result, 'pass');
    assert.equal(outcome.signatures[0].alignedDomain, null);
    const v = evaluateDkimPolicy(outcome);
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, 'misaligned');
  });

  it('detects an l= body-length tag in the raw headers (policy → body_length_tag)', async () => {
    const withL =
      'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com; s=test; ' +
      'l=200; h=from:to:subject; bh=abc; b=deadbeef\r\n' +
      rawMessage();
    assert.equal(hasBodyLengthTag(withL), true);
    const outcome = await verifyDkim(withL, { resolver: resolverFor([]) });
    assert.equal(outcome.anyBodyLengthTag, true);
    const v = evaluateDkimPolicy(outcome);
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, 'body_length_tag');
  });

  it('hasBodyLengthTag is false for a clean signed message', async () => {
    const signed = await sign(rawMessage(), 'example.com');
    assert.equal(hasBodyLengthTag(signed), false);
  });

  it('an x=-expired signature is neutral live but passes when verifyAt pins the clock in-window', async () => {
    // Gmail-style short expiry: signed 2026-06-13, x= a week later — long lapsed at test time.
    const signed = await sign(rawMessage(), 'example.com', new Date('2026-06-20T10:00:00Z'));
    const resolver = resolverFor(['test._domainkey.example.com']);

    // Wall clock (production mode): the crypto verifies but mailauth downgrades the
    // lapsed signature to neutral → policy missing_key. Freshness stays enforced live.
    const live = await verifyDkim(signed, { resolver });
    assert.equal(live.signatures[0].result, 'neutral');
    const liveVerdict = evaluateDkimPolicy(live);
    assert.equal(liveVerdict.ok, false);
    if (!liveVerdict.ok) assert.equal(liveVerdict.reason, 'missing_key');

    // Replay mode: pin the verification clock inside the t=..x= window (how the frozen
    // client-email corpus replays archived forwards) → the same bytes verify.
    const pinned = await verifyDkim(signed, { resolver, verifyAt: new Date('2026-06-14T00:00:00Z') });
    assert.equal(pinned.signatures[0].result, 'pass');
    assert.equal(evaluateDkimPolicy(pinned).ok, true);
  });
});
