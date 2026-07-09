/**
 * wallet tests — F-30.5 (spec 0.40.0, #132): the MCP wallet foundation.
 *
 * The x402 challenge fixture is the VERBATIM `Payment-Required` header
 * captured from the live route (POST https://kysigned.com/v1/x402/envelope,
 * 2026-07-10) — prod wire shape, not an idealized fixture. Unit tests inject
 * seams (allowance reader, fetch, balance reader): no keystore, no network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchChallengeTerms,
  getWalletStatus,
  X402RouteError,
  type WalletSeams,
} from './wallet.js';

// Verbatim from the live gateway (decodes to x402Version 2, accepts[0] =
// exact / eip155:8453 / amount "250000" / Base USDC / payTo = ops wallet,
// extra { name: "USD Coin", amount_usd_micros: 250000 }).
const CAPTURED_PAYMENT_REQUIRED =
  'eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9reXNpZ25lZC5jb20vdjEveDQwMi9lbnZlbG9wZSIsImRlc2NyaXB0aW9uIjoiVGVuYW50IHByaWNlZCByb3V0ZWQgZnVuY3Rpb24gcmVxdWVzdCIsIm1pbWVUeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LCJhY2NlcHRzIjpbeyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MyIsImFtb3VudCI6IjI1MDAwMCIsImFzc2V0IjoiMHg4MzM1ODlmQ0Q2ZURiNkUwOGY0YzdDMzJENGY3MWI1NGJkQTAyOTEzIiwicGF5VG8iOiIweDhkNjcxY2QxMmVjZjY5ZTBiMDQ5YTZiNTVjNWIzMTgwOTdiNGJjMzUiLCJtYXhUaW1lb3V0U2Vjb25kcyI6MzAwLCJleHRyYSI6eyJuYW1lIjoiVVNEIENvaW4iLCJ2ZXJzaW9uIjoiMiIsInJ1bjQwMl9wYXltZW50X2tpbmQiOiJ0ZW5hbnRfcm91dGUiLCJyb3V0ZV9wcmljaW5nX25ldHdvcmsiOiJtYWlubmV0IiwiYW1vdW50X3VzZF9taWNyb3MiOjI1MDAwMCwicGF5X3RvIjoib3JnX2RlZmF1bHRfcGF5b3V0In19XX0=';

const GATEWAY_402_BODY = JSON.stringify({
  error: 'Request failed',
  code: 'PAYMENT_REQUIRED',
  category: 'billing',
  source: 'gateway',
});

function challenge402(header: string | null = CAPTURED_PAYMENT_REQUIRED): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (header !== null) headers['Payment-Required'] = header;
  return new Response(GATEWAY_402_BODY, { status: 402, headers });
}

function fetchReturning(res: Response): typeof fetch {
  return (async () => res) as typeof fetch;
}

const ENDPOINT = 'https://kysigned.com';

describe('fetchChallengeTerms — DD-31 price/terms discovery from the unpaid 402', () => {
  it('parses the captured prod challenge header into terms', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const f: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return challenge402();
    };
    const terms = await fetchChallengeTerms(ENDPOINT, f);
    assert.equal(calls[0]!.url, 'https://kysigned.com/v1/x402/envelope');
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(terms.network, 'eip155:8453');
    assert.equal(terms.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    assert.equal(terms.amountAtomic, '250000');
    assert.equal(terms.amountUsdMicros, 250_000);
    assert.equal(terms.payTo, '0x8d671cd12ecf69e0b049a6b55c5b318097b4bc35');
    assert.equal(terms.assetName, 'USD Coin');
  });

  it('a non-402 response → X402RouteError kind=not_priced (fork-inert route)', async () => {
    const f = fetchReturning(new Response('{"error":"not found"}', { status: 404 }));
    await assert.rejects(
      () => fetchChallengeTerms(ENDPOINT, f),
      (e: unknown) => e instanceof X402RouteError && e.kind === 'not_priced',
    );
  });

  it('a 402 with no Payment-Required header → bad_challenge', async () => {
    await assert.rejects(
      () => fetchChallengeTerms(ENDPOINT, fetchReturning(challenge402(null))),
      (e: unknown) => e instanceof X402RouteError && e.kind === 'bad_challenge',
    );
  });

  it('a 402 with garbage base64 → bad_challenge', async () => {
    await assert.rejects(
      () => fetchChallengeTerms(ENDPOINT, fetchReturning(challenge402('!!!not-base64!!!'))),
      (e: unknown) => e instanceof X402RouteError && e.kind === 'bad_challenge',
    );
  });

  it('a 402 whose challenge has no accepts entries → bad_challenge', async () => {
    const empty = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [] }), 'utf8').toString('base64');
    await assert.rejects(
      () => fetchChallengeTerms(ENDPOINT, fetchReturning(challenge402(empty))),
      (e: unknown) => e instanceof X402RouteError && e.kind === 'bad_challenge',
    );
  });
});

function seams(overrides: Partial<WalletSeams> = {}): WalletSeams {
  return {
    readAllowanceAddress: async () => '0x0000000000000000000000000000000000000AaA',
    allowancePath: async () => 'C:/fake/home/.config/run402/allowance.json',
    fetchFn: fetchReturning(challenge402()),
    readBalanceAtomic: async () => 300_000n,
    ...overrides,
  };
}

describe('getWalletStatus — AC-145 readiness facts', () => {
  it('no allowance configured → configured:false with the path + a run402-init hint', async () => {
    const s = await getWalletStatus(ENDPOINT, seams({ readAllowanceAddress: async () => null }));
    assert.equal(s.configured, false);
    if (!s.configured) {
      assert.equal(s.allowance_path, 'C:/fake/home/.config/run402/allowance.json');
      assert.match(s.hint, /run402 init/);
    }
  });

  it('funded wallet → sufficient, envelopes_affordable, and the challenge terms', async () => {
    const s = await getWalletStatus(ENDPOINT, seams({ readBalanceAtomic: async () => 550_000n }));
    assert.equal(s.configured, true);
    if (s.configured) {
      assert.equal(s.address, '0x0000000000000000000000000000000000000AaA');
      assert.equal(s.network, 'eip155:8453');
      assert.equal(s.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
      assert.equal(s.asset_name, 'USD Coin');
      assert.equal(s.balance_atomic, '550000');
      assert.equal(s.price_atomic, '250000');
      assert.equal(s.price_usd_micros, 250_000);
      assert.equal(s.sufficient, true);
      assert.equal(s.envelopes_affordable, 2);
      assert.equal(s.fund_hint, undefined);
    }
  });

  it('underfunded wallet → sufficient:false + a fund hint naming address, network, asset, minimum', async () => {
    const s = await getWalletStatus(ENDPOINT, seams({ readBalanceAtomic: async () => 100_000n }));
    assert.equal(s.configured, true);
    if (s.configured) {
      assert.equal(s.sufficient, false);
      assert.equal(s.envelopes_affordable, 0);
      assert.ok(s.fund_hint);
      assert.match(s.fund_hint!, /0x0000000000000000000000000000000000000AaA/);
      assert.match(s.fund_hint!, /eip155:8453/);
      assert.match(s.fund_hint!, /USD Coin|USDC/);
      assert.match(s.fund_hint!, /250000|0\.25/);
    }
  });

  it('custody: no wallet-status result can carry key material (AC-146)', async () => {
    for (const bal of [0n, 300_000n]) {
      const s = await getWalletStatus(ENDPOINT, seams({ readBalanceAtomic: async () => bal }));
      const text = JSON.stringify(s);
      assert.doesNotMatch(text, /privateKey|private_key/i);
      // an EVM private key is 64 hex chars; the only hex allowed is the 40-char address
      assert.doesNotMatch(text, /[0-9a-fA-F]{64}/);
    }
  });
});
