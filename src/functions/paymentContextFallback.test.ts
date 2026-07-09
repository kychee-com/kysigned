/**
 * paymentContextFallback tests — F-30.2 (46.8 live finding): the deployed
 * runtime's injected `@run402/functions` can predate `getRoutedPaymentContext`
 * (the platform bundles its own version at deploy time). The fallback parses
 * the platform-owned `x-run402-payment-*` headers with the SAME strict
 * validation as the platform helper, so a settled payment is never dropped on
 * a runtime that lacks the helper (which turned a REAL settled $0.25 into a
 * 503 on 2026-07-09).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePaymentContextFromHeaders } from './paymentContextFallback.js';

const VALID: Record<string, string> = {
  'x-run402-payment-scheme': 'x402',
  'x-run402-payment-id': 'txp_27985e19',
  'x-run402-payment-amount-usd-micros': '250000',
  'x-run402-payment-network': 'eip155:8453',
  'x-run402-payment-pay-to': '0x8d671cd12ecf69e0b049a6b55c5b318097b4bc35',
  'x-run402-payment-settled-at': '2026-07-09T05:49:32.349Z',
  'x-run402-payment-payer': '0x0c29f1e749c8cce0d96af6ade3d44741175c970c',
  'x-run402-payment-asset': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'x-run402-payment-transaction': '0x0bb36ce4',
};

function headers(over: Record<string, string | null> = {}): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries({ ...VALID, ...over })) {
    if (v !== null) h.set(k, v);
  }
  return h;
}

describe('parsePaymentContextFromHeaders — strict platform-header fallback (F-30.2)', () => {
  it('parses a full settled context, all fields mapped', () => {
    const c = parsePaymentContextFromHeaders(headers());
    assert.deepEqual(c, {
      scheme: 'x402',
      paymentId: 'txp_27985e19',
      amountUsdMicros: 250_000,
      payer: '0x0c29f1e749c8cce0d96af6ade3d44741175c970c',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0x8d671cd12ecf69e0b049a6b55c5b318097b4bc35',
      transaction: '0x0bb36ce4',
      settledAt: '2026-07-09T05:49:32.349Z',
    });
  });

  it('optional fields absent → null (payer, asset, transaction)', () => {
    const c = parsePaymentContextFromHeaders(
      headers({ 'x-run402-payment-payer': null, 'x-run402-payment-asset': null, 'x-run402-payment-transaction': null }),
    );
    assert.equal(c?.payer, null);
    assert.equal(c?.asset, null);
    assert.equal(c?.transaction, null);
    assert.equal(c?.paymentId, 'txp_27985e19');
  });

  it('wrong or missing scheme → null', () => {
    assert.equal(parsePaymentContextFromHeaders(headers({ 'x-run402-payment-scheme': 'mpp' })), null);
    assert.equal(parsePaymentContextFromHeaders(headers({ 'x-run402-payment-scheme': null })), null);
  });

  it('any missing required field → null (id, amount, network, payTo, settledAt)', () => {
    for (const k of [
      'x-run402-payment-id',
      'x-run402-payment-amount-usd-micros',
      'x-run402-payment-network',
      'x-run402-payment-pay-to',
      'x-run402-payment-settled-at',
    ]) {
      assert.equal(parsePaymentContextFromHeaders(headers({ [k]: null })), null, `missing ${k}`);
      assert.equal(parsePaymentContextFromHeaders(headers({ [k]: '  ' })), null, `blank ${k}`);
    }
  });

  it('non-integer / non-positive / unsafe amounts → null', () => {
    for (const bad of ['0', '-5', '2.5', 'abc', '9007199254740993']) {
      assert.equal(
        parsePaymentContextFromHeaders(headers({ 'x-run402-payment-amount-usd-micros': bad })),
        null,
        `amount ${bad}`,
      );
    }
  });

  it('no payment headers at all → null (unpriced route)', () => {
    assert.equal(parsePaymentContextFromHeaders(new Headers()), null);
  });
});
