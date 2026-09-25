/**
 * x402Challenge (82.1, F-46.1/F-46.2): the priced route's own unpaid 402
 * challenge, decoded in full (the web paid tool hands the whole
 * PaymentRequired to the caller) and as the terms the local wallet tools use.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchChallenge, fetchChallengeTerms, X402RouteError, X402_CREATE_PATH } from './x402Challenge.js';
import * as wallet from './wallet.js';

// The same verbatim live-gateway header wallet.test.ts pins (x402Version 2,
// accepts[0] = exact / eip155:8453 / "250000" / Base USDC / the ops wallet).
const CAPTURED_PAYMENT_REQUIRED =
  'eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9reXNpZ25lZC5jb20vdjEveDQwMi9lbnZlbG9wZSIsImRlc2NyaXB0aW9uIjoiVGVuYW50IHByaWNlZCByb3V0ZWQgZnVuY3Rpb24gcmVxdWVzdCIsIm1pbWVUeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LCJhY2NlcHRzIjpbeyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MyIsImFtb3VudCI6IjI1MDAwMCIsImFzc2V0IjoiMHg4MzM1ODlmQ0Q2ZURiNkUwOGY0YzdDMzJENGY3MWI1NGJkQTAyOTEzIiwicGF5VG8iOiIweDhkNjcxY2QxMmVjZjY5ZTBiMDQ5YTZiNTVjNWIzMTgwOTdiNGJjMzUiLCJtYXhUaW1lb3V0U2Vjb25kcyI6MzAwLCJleHRyYSI6eyJuYW1lIjoiVVNEIENvaW4iLCJ2ZXJzaW9uIjoiMiIsInJ1bjQwMl9wYXltZW50X2tpbmQiOiJ0ZW5hbnRfcm91dGUiLCJyb3V0ZV9wcmljaW5nX25ldHdvcmsiOiJtYWlubmV0IiwiYW1vdW50X3VzZF9taWNyb3MiOjI1MDAwMCwicGF5X3RvIjoib3JnX2RlZmF1bHRfcGF5b3V0In19XX0=';

const ENDPOINT = 'https://kysigned.com';

function challenge402(header: string | null = CAPTURED_PAYMENT_REQUIRED): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (header !== null) headers['Payment-Required'] = header;
  return new Response('{"code":"PAYMENT_REQUIRED"}', { status: 402, headers });
}

function recording(res: Response): { fn: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return res;
  }) as typeof fetch;
  return { fn, calls };
}

describe('fetchChallenge — the route challenge in full (82.1)', () => {
  it('decodes the whole PaymentRequired object and the terms from one unpaid POST', async () => {
    const { fn, calls } = recording(challenge402());
    const { paymentRequired, terms } = await fetchChallenge(ENDPOINT, fn);
    assert.equal(paymentRequired.x402Version, 2);
    assert.equal(paymentRequired.resource?.url, 'https://kysigned.com/v1/x402/envelope');
    assert.equal(paymentRequired.accepts.length, 1);
    assert.equal(paymentRequired.accepts[0]!.amount, '250000');
    assert.equal(paymentRequired.accepts[0]!.maxTimeoutSeconds, 300);
    assert.deepEqual(terms, {
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amountAtomic: '250000',
      payTo: '0x8d671cd12ecf69e0b049a6b55c5b318097b4bc35',
      assetName: 'USD Coin',
      amountUsdMicros: 250000,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `${ENDPOINT}${X402_CREATE_PATH}`);
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.equal(calls[0]!.init?.body, '{}');
  });

  it('a non-402 answer is not_priced (an instance with no priced route)', async () => {
    const { fn } = recording(new Response('{"code":"payment_x402_not_enabled"}', { status: 404 }));
    await assert.rejects(() => fetchChallenge(ENDPOINT, fn), (e: unknown) => e instanceof X402RouteError && e.kind === 'not_priced');
  });

  it('a 402 without a parseable challenge is bad_challenge', async () => {
    for (const header of [null, '!!!not-base64!!!', Buffer.from(JSON.stringify({ x402Version: 2, accepts: [] })).toString('base64')]) {
      const { fn } = recording(challenge402(header));
      await assert.rejects(() => fetchChallenge(ENDPOINT, fn), (e: unknown) => e instanceof X402RouteError && e.kind === 'bad_challenge');
    }
  });
});

describe('x402Challenge stays light and is the one probe (82.1)', () => {
  it('imports no wallet, viem or run402 SDK code (the web bundle must not pull the wallet stack)', () => {
    const src = readFileSync(new URL('./x402Challenge.ts', import.meta.url), 'utf8');
    for (const heavy of ["from './wallet", "from 'viem", "from '@run402/sdk", "from '@x402/fetch", "from '@x402/evm"]) {
      assert.ok(!src.includes(heavy), `x402Challenge.ts must not import ${heavy}`);
    }
  });

  it('wallet.ts re-exports the same probe, error class and path (no second implementation)', () => {
    assert.equal(wallet.fetchChallengeTerms, fetchChallengeTerms);
    assert.equal(wallet.X402RouteError, X402RouteError);
    assert.equal(wallet.X402_CREATE_PATH, X402_CREATE_PATH);
  });
});
