/**
 * webhookSignature tests — F-30.3 (AC-138).
 *
 * Stripe-style scheme: `X-Kysigned-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<body>")>`.
 * The verify recipe is what receivers implement (documented at 44.8): recompute
 * the HMAC over `t + "." + rawBody` with the envelope's callback_secret, compare
 * constant-time, and reject stale timestamps (replay defense).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mintWebhookSecret,
  signWebhookPayload,
  buildSignatureHeader,
  verifyWebhookSignature,
} from './webhookSignature.js';

const BODY = '{"type":"envelope.completed","envelope_id":"env-1"}';

describe('webhookSignature (F-30.3 / AC-138)', () => {
  it('mintWebhookSecret returns unique whs_-prefixed high-entropy secrets', () => {
    const a = mintWebhookSecret();
    const b = mintWebhookSecret();
    assert.ok(a.startsWith('whs_'));
    assert.ok(a.length >= 4 + 43, 'at least 256 bits of encoded entropy');
    assert.notEqual(a, b);
  });

  it('sign + header + verify round-trip', () => {
    const secret = mintWebhookSecret();
    const header = buildSignatureHeader(secret, BODY, 1_700_000_000);
    assert.match(header, /^t=1700000000,v1=[0-9a-f]{64}$/);
    assert.equal(
      verifyWebhookSignature(secret, header, BODY, { nowSeconds: 1_700_000_010 }),
      true,
    );
  });

  it('signature is deterministic over (secret, timestamp, body)', () => {
    const s = 'whs_' + 'a'.repeat(64);
    assert.equal(signWebhookPayload(s, 1, BODY), signWebhookPayload(s, 1, BODY));
    assert.notEqual(signWebhookPayload(s, 1, BODY), signWebhookPayload(s, 2, BODY));
  });

  it('rejects a tampered body, a wrong secret, and a malformed header', () => {
    const secret = mintWebhookSecret();
    const header = buildSignatureHeader(secret, BODY, 1_700_000_000);
    const now = { nowSeconds: 1_700_000_010 };
    assert.equal(verifyWebhookSignature(secret, header, BODY + ' ', now), false, 'tampered body');
    assert.equal(verifyWebhookSignature(mintWebhookSecret(), header, BODY, now), false, 'wrong secret');
    assert.equal(verifyWebhookSignature(secret, 'v1=abc', BODY, now), false, 'malformed header');
    assert.equal(verifyWebhookSignature(secret, '', BODY, now), false, 'empty header');
  });

  it('rejects a stale timestamp beyond tolerance (replay defense) and accepts inside it', () => {
    const secret = mintWebhookSecret();
    const header = buildSignatureHeader(secret, BODY, 1_700_000_000);
    assert.equal(
      verifyWebhookSignature(secret, header, BODY, { nowSeconds: 1_700_000_000 + 301, toleranceSeconds: 300 }),
      false,
      'beyond tolerance',
    );
    assert.equal(
      verifyWebhookSignature(secret, header, BODY, { nowSeconds: 1_700_000_000 + 299, toleranceSeconds: 300 }),
      true,
      'inside tolerance',
    );
  });
});
