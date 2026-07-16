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
  readBalanceResilient,
  resolvePayerSourceKind,
  atomicToDecimal,
  erc681TransferUri,
  buildFundWalletAction,
  defaultWalletSeams,
  BalanceUnknownError,
  PayerConfigError,
  X402RouteError,
  type ChallengeTerms,
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

const ADDRESS = '0x0000000000000000000000000000000000000AaA';

function seams(overrides: Partial<WalletSeams> = {}): WalletSeams {
  return {
    payerPresence: async () => ({
      configured: true,
      sourceKind: 'default_allowance',
      allowancePath: 'C:/fake/home/.config/run402/allowance.json',
    }),
    payerAddress: async () => ADDRESS,
    fetchFn: fetchReturning(challenge402()),
    readBalanceAtomic: async () => 300_000n,
    paidFetchFactory: async () => null,
    ...overrides,
  };
}

describe('getWalletStatus — AC-145/AC-170 readiness facts + provenance', () => {
  it('no payer configured → configured:false with the path, source kind, and a run402-init hint', async () => {
    const s = await getWalletStatus(
      ENDPOINT,
      seams({
        payerPresence: async () => ({
          configured: false,
          sourceKind: 'default_allowance',
          allowancePath: 'C:/fake/home/.config/run402/allowance.json',
        }),
      }),
    );
    assert.equal(s.configured, false);
    if (!s.configured) {
      assert.equal(s.allowance_path, 'C:/fake/home/.config/run402/allowance.json');
      assert.equal(s.payer_source, 'default_allowance');
      assert.match(s.hint, /run402 init/);
      assert.match(s.hint, /KYSIGNED_RUN402_ALLOWANCE_PATH/);
    }
  });

  it('funded wallet → sufficient, envelopes_affordable, provenance, and the challenge terms', async () => {
    const s = await getWalletStatus(ENDPOINT, seams({ readBalanceAtomic: async () => 550_000n }));
    assert.equal(s.configured, true);
    if (s.configured && s.balance_status === 'known') {
      assert.equal(s.payer_source, 'default_allowance');
      assert.equal(s.address, ADDRESS);
      assert.equal(s.network, 'eip155:8453');
      assert.equal(s.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
      assert.equal(s.asset_name, 'USD Coin');
      assert.equal(s.balance_atomic, '550000');
      assert.equal(s.price_atomic, '250000');
      assert.equal(s.price_usd_micros, 250_000);
      assert.equal(s.sufficient, true);
      assert.equal(s.envelopes_affordable, 2);
      assert.equal(s.fund_hint, undefined);
      assert.equal(s.next_actions, undefined);
    } else {
      assert.fail('expected a known-balance configured status');
    }
  });

  it('underfunded wallet → fund hint + the structured QR-ready fund_wallet action (AC-172)', async () => {
    // The live 2026-07-15 shape: 0.197456 USDC against a 0.25 USDC price.
    const s = await getWalletStatus(ENDPOINT, seams({ readBalanceAtomic: async () => 197_456n }));
    assert.equal(s.configured, true);
    if (s.configured && s.balance_status === 'known') {
      assert.equal(s.sufficient, false);
      assert.equal(s.envelopes_affordable, 0);
      assert.ok(s.fund_hint);
      assert.match(s.fund_hint!, /0x0000000000000000000000000000000000000AaA/);
      assert.match(s.fund_hint!, /eip155:8453/);
      assert.match(s.fund_hint!, /USD Coin|USDC/);
      assert.match(s.fund_hint!, /250000|0\.25/);
      const action = s.next_actions?.[0];
      assert.ok(action, 'structured fund_wallet action present');
      assert.equal(action!.type, 'fund_wallet');
      assert.equal(action!.address, ADDRESS);
      assert.equal(action!.network, 'eip155:8453');
      assert.equal(action!.network_label, 'Base mainnet');
      assert.equal(action!.token_contract, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
      assert.equal(action!.token_symbol, 'USDC');
      assert.equal(action!.token_decimals, 6);
      assert.equal(action!.balance_atomic, '197456');
      assert.equal(action!.price_atomic, '250000');
      assert.equal(action!.shortfall_atomic, '52544');
      assert.equal(action!.balance_decimal, '0.197456');
      assert.equal(action!.price_decimal, '0.25');
      assert.equal(action!.shortfall_decimal, '0.052544');
      assert.equal(
        action!.payment_uri,
        `ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453/transfer?address=${ADDRESS}&uint256=52544`,
      );
      assert.match(action!.instruction, /USDC/);
      assert.match(action!.instruction, /Base mainnet/);
      assert.equal(action!.retry.tool, 'wallet_status');
    } else {
      assert.fail('expected a known-balance configured status');
    }
  });

  it('AC-171: provider exhaustion → balance_status unknown with the structured error, never zero/insufficient', async () => {
    const s = await getWalletStatus(
      ENDPOINT,
      seams({
        readBalanceAtomic: async () => {
          throw new BalanceUnknownError('eip155:8453', [
            { provider: 'mainnet.base.org', error: 'TimeoutError' },
            { provider: 'base-rpc.publicnode.com', error: 'HttpRequestError' },
          ]);
        },
      }),
    );
    assert.equal(s.configured, true);
    if (s.configured && s.balance_status === 'unknown') {
      assert.equal(s.balance_error.code, 'balance_unknown_provider_exhausted');
      assert.equal(s.balance_error.retryable, true);
      assert.equal(s.balance_error.safe_to_retry, true);
      assert.equal(s.balance_error.mutation_state, 'not_started');
      assert.equal(s.balance_error.providers.length, 2);
      const text = JSON.stringify(s);
      assert.doesNotMatch(text, /"balance_atomic"/, 'no balance number is fabricated');
      assert.ok(!('sufficient' in s), 'unknown is NEVER reported as (in)sufficient');
      assert.notEqual(s.balance_error.code, 'insufficient_funds');
    } else {
      assert.fail('expected an unknown-balance configured status');
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

describe('readBalanceResilient — AC-171 bounded retry + independent-provider failover', () => {
  const Q = { network: 'eip155:8453', asset: '0xToken', address: ADDRESS };
  const noSleep = async () => {};

  it('a transient primary failure fails over and returns the balance from a later provider', async () => {
    const tried: string[] = [];
    const balance = await readBalanceResilient(Q, {
      rpcs: ['https://down.example', 'https://up.example'],
      attemptsPerProvider: 2,
      sleep: noSleep,
      clientFor: async (url) => ({
        readContract: async () => {
          tried.push(url);
          if (url.includes('down')) throw new Error('ECONNREFUSED');
          return 550_000n;
        },
      }),
    });
    assert.equal(balance, 550_000n);
    assert.deepEqual(tried, ['https://down.example', 'https://down.example', 'https://up.example']);
  });

  it('a flaky provider succeeds on the bounded retry without failover', async () => {
    let calls = 0;
    const balance = await readBalanceResilient(Q, {
      rpcs: ['https://flaky.example', 'https://never.example'],
      attemptsPerProvider: 2,
      sleep: noSleep,
      clientFor: async (url) => ({
        readContract: async () => {
          if (url.includes('never')) assert.fail('failover should not be reached');
          calls += 1;
          if (calls === 1) throw new Error('timeout');
          return 1n;
        },
      }),
    });
    assert.equal(balance, 1n);
    assert.equal(calls, 2);
  });

  it('ALL providers exhausted → BalanceUnknownError with sanitized diagnostics (never a zero balance)', async () => {
    await assert.rejects(
      () =>
        readBalanceResilient(Q, {
          rpcs: ['https://a.example/rpc?key=SECRET', 'https://b.example'],
          attemptsPerProvider: 1,
          sleep: noSleep,
          clientFor: async () => ({
            readContract: async () => {
              throw new Error('boom');
            },
          }),
        }),
      (e: unknown) => {
        assert.ok(e instanceof BalanceUnknownError);
        assert.equal(e.code, 'balance_unknown_provider_exhausted');
        assert.equal(e.retryable, true);
        assert.equal(e.safe_to_retry, true);
        assert.equal(e.mutation_state, 'not_started');
        assert.equal(e.providers.length, 2);
        assert.equal(e.providers[0]!.provider, 'a.example', 'host only — no path, no query, no keys');
        assert.doesNotMatch(JSON.stringify(e.providers), /SECRET/);
        assert.match(e.message, /UNKNOWN/);
        assert.match(e.message, /no payment was dispatched/i);
        return true;
      },
    );
  });

  it('a successful read of a LOW balance returns normally — low is not an error (AC-171 distinction)', async () => {
    const balance = await readBalanceResilient(Q, {
      rpcs: ['https://up.example'],
      sleep: noSleep,
      clientFor: async () => ({ readContract: async () => 0n }),
    });
    assert.equal(balance, 0n);
  });

  it('no providers known for the network → the actionable KYSIGNED_RPC_URL error', async () => {
    await assert.rejects(
      () => readBalanceResilient({ ...Q, network: 'eip155:999' }, { sleep: noSleep }),
      (e: unknown) => e instanceof X402RouteError && /KYSIGNED_RPC_URL/.test(e.message),
    );
  });
});

describe('payer sources — AC-170 exactly-once resolution, fail closed', () => {
  it('explicit allowance path + injected signer → payer_source_conflict (fail closed)', () => {
    assert.throws(
      () =>
        resolvePayerSourceKind({
          allowancePath: 'C:/explicit/allowance.json',
          paymentSigner: { getSigner: async () => null },
        }),
      (e: unknown) => e instanceof PayerConfigError && e.code === 'payer_source_conflict',
    );
  });

  it('precedence: explicit path > signer > default allowance', () => {
    assert.equal(resolvePayerSourceKind({ allowancePath: 'C:/x.json' }), 'allowance_path');
    assert.equal(resolvePayerSourceKind({ paymentSigner: { getSigner: async () => null } }), 'payment_signer');
    assert.equal(resolvePayerSourceKind({}), 'default_allowance');
  });

  it('defaultWalletSeams with an explicit UNREADABLE allowance path fails closed — no ambient fallback', async () => {
    const s = defaultWalletSeams({ allowancePath: 'C:/definitely/not/a/real/allowance-96f3.json' });
    await assert.rejects(
      () => s.payerPresence(),
      (e: unknown) => {
        assert.ok(e instanceof PayerConfigError);
        assert.equal(e.code, 'payer_source_unavailable');
        assert.match(e.message, /Refusing to fall back/);
        return true;
      },
    );
  });

  it('an injected opaque signer is presence-configured and resolves the payer address per network', async () => {
    const s = defaultWalletSeams({
      paymentSigner: {
        getSigner: async ({ network }) =>
          network === 'eip155:8453' ? { address: '0x1111111111111111111111111111111111111111' } : null,
      },
    });
    const presence = await s.payerPresence();
    assert.equal(presence.configured, true);
    assert.equal(presence.sourceKind, 'payment_signer');
    assert.equal(await s.payerAddress('eip155:8453'), '0x1111111111111111111111111111111111111111');
    assert.equal(await s.payerAddress('eip155:84532'), null, 'no signer for that network → null');
  });
});

describe('funding actions — AC-172 exact math + standards-based URI', () => {
  it('atomicToDecimal is exact BigInt math (no floating point)', () => {
    assert.equal(atomicToDecimal(52_544n, 6), '0.052544');
    assert.equal(atomicToDecimal(250_000n, 6), '0.25');
    assert.equal(atomicToDecimal(0n, 6), '0');
    assert.equal(atomicToDecimal(1n, 6), '0.000001');
    assert.equal(atomicToDecimal(1_234_567_891_234n, 6), '1234567.891234');
    assert.equal(atomicToDecimal(1_000_000n, 6), '1');
  });

  it('erc681TransferUri produces the ERC-681 token-transfer form and parses back', () => {
    const uri = erc681TransferUri('0xToken', 'eip155:8453', '0xDest', 52_544n);
    assert.equal(uri, 'ethereum:0xToken@8453/transfer?address=0xDest&uint256=52544');
    // Parse-back test: scheme, target, chain id, function, params.
    const m = uri.match(/^ethereum:([^@]+)@(\d+)\/transfer\?address=([^&]+)&uint256=(\d+)$/);
    assert.ok(m, 'URI parses');
    assert.deepEqual(m!.slice(1), ['0xToken', '8453', '0xDest', '52544']);
  });

  it('buildFundWalletAction requests EXACTLY the shortfall and never includes key material', () => {
    const terms: ChallengeTerms = {
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      assetName: 'USD Coin',
      amountAtomic: '250000',
      amountUsdMicros: 250_000,
      payTo: '0x8d67',
    };
    const action = buildFundWalletAction({
      terms,
      address: ADDRESS,
      balance: 197_456n,
      retry: { tool: 'wallet_status', note: 're-check' },
    });
    assert.equal(action.shortfall_atomic, '52544');
    assert.match(action.payment_uri, /uint256=52544$/);
    assert.doesNotMatch(JSON.stringify(action), /privateKey|private_key/i);
    assert.doesNotMatch(JSON.stringify(action), /[0-9a-fA-F]{64}/);
  });

  it('an unknown token still yields a correct atomic-only action (decimals only affect display)', () => {
    const terms: ChallengeTerms = {
      network: 'eip155:999',
      asset: '0xUnknownToken',
      amountAtomic: '100',
      payTo: '0xdead',
    };
    const action = buildFundWalletAction({
      terms,
      address: '0xDest',
      balance: 40n,
      retry: { tool: 'wallet_status', note: 're-check' },
    });
    assert.equal(action.shortfall_atomic, '60');
    assert.equal(action.balance_decimal, undefined, 'no fabricated decimals for unknown tokens');
    assert.equal(action.payment_uri, 'ethereum:0xUnknownToken@999/transfer?address=0xDest&uint256=60');
  });
});
