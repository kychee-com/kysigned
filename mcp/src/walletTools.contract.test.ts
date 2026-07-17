/**
 * Wallet-tool contract suite — F-30.5 (spec 0.40.0, #132): the wallet pair
 * works with NO KYSIGNED_AUTHORIZATION at all (payment IS the auth on the
 * x402 rail), so this file — unlike contract.test.ts — never sets the auth
 * env. Wallet seams are injected via the exported test hook; the wallet
 * behavior itself is unit-pinned in wallet.test.ts.
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.KYSIGNED_ENDPOINT = 'https://wallet-contract.test';
delete process.env.KYSIGNED_AUTHORIZATION;

const { server, setWalletSeamsForTests } = await import('./server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
import type { WalletSeams } from './wallet.js';

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'wallet-contract-suite', version: '0.0.0' });
await client.connect(clientTransport);
after(() => Promise.allSettled([client.close(), server.close()]));
after(() => setWalletSeamsForTests(undefined));

const CHALLENGE_HEADER = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '250000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x8d671cd12ecf69e0b049a6b55c5b318097b4bc35',
        extra: { name: 'USD Coin', amount_usd_micros: 250000 },
      },
    ],
  }),
  'utf8',
).toString('base64');

function challengeFetch(status = 402): typeof fetch {
  return (async () =>
    new Response('{"code":"PAYMENT_REQUIRED"}', {
      status,
      headers: status === 402 ? { 'Payment-Required': CHALLENGE_HEADER } : {},
    })) as typeof fetch;
}

function seams(overrides: Partial<WalletSeams> = {}): WalletSeams {
  return {
    payerPresence: async () => ({
      configured: true,
      sourceKind: 'default_allowance',
      allowancePath: 'C:/fake/.config/run402/allowance.json',
    }),
    payerAddress: async () => '0x0000000000000000000000000000000000000AaA',
    fetchFn: challengeFetch(),
    readBalanceAtomic: async () => 550_000n,
    paidFetchFactory: async () => null,
    ...overrides,
  };
}

const NOT_CONFIGURED: Partial<WalletSeams> = {
  payerPresence: async () => ({
    configured: false,
    sourceKind: 'default_allowance',
    allowancePath: 'C:/fake/.config/run402/allowance.json',
  }),
};

/**
 * Route-aware unpaid fetch + recorded paid fetch for the create flow:
 * `/v1/envelope/preflight` → `preflight`, unpaid `/v1/x402/envelope` → the
 * 402 challenge; the paid fetch records its calls and replays `paid`.
 */
function createFlowSeams(opts: {
  preflight?: { status: number; body: unknown };
  paid?: { status: number; body: unknown };
  balance?: bigint;
  paidUnavailable?: boolean;
}) {
  const unpaidCalls: string[] = [];
  const preflightBodies: Array<Record<string, unknown>> = [];
  const paidCalls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  let factoryCalls = 0;
  const fetchFn: typeof fetch = async (url, init) => {
    const u = String(url);
    unpaidCalls.push(u);
    if (u.endsWith('/v1/envelope/preflight')) {
      preflightBodies.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
      const p = opts.preflight ?? { status: 200, body: { ok: true } };
      return new Response(JSON.stringify(p.body), { status: p.status, headers: { 'content-type': 'application/json' } });
    }
    if (u.endsWith('/v1/x402/envelope')) return challengeFetch()(url, init);
    return new Response('{}', { status: 500 });
  };
  const paidFetch: typeof fetch = async (url, init) => {
    const headers = { ...((init?.headers as Record<string, string>) ?? {}) };
    paidCalls.push({ url: String(url), headers, body: init?.body ? JSON.parse(String(init.body)) : {} });
    const p = opts.paid ?? { status: 201, body: {} };
    return new Response(JSON.stringify(p.body), { status: p.status, headers: { 'content-type': 'application/json' } });
  };
  const s = seams({
    fetchFn,
    readBalanceAtomic: async () => opts.balance ?? 550_000n,
    paidFetchFactory: async () => {
      factoryCalls += 1;
      return opts.paidUnavailable ? null : paidFetch;
    },
  });
  return { s, unpaidCalls, preflightBodies, paidCalls, factory: () => factoryCalls };
}

const CREATE_ARGS = {
  creator_email: 'agent@example.com',
  document_name: 'Paid NDA',
  pdf_base64: 'JVBERi0xLjc=',
  signers: [{ email: 'signer@example.com', name: 'S' }],
};

// #155 — a realistic one-time webhook secret: whs_ + 64 hex (webhookSignature.ts).
const CALLBACK_SECRET = 'whs_' + 'ab12'.repeat(16);

// The envelope-result part of a paid 201 — the FULL documented create-201 body
// (src/api/envelopeResultFields.ts), which #155 requires to survive the MCP
// projection on the first success exactly as on a spending-intent replay.
const ENVELOPE_201 = {
  envelope_id: 'env-x1',
  status: 'active',
  document_hash: 'abc',
  status_url: 'https://wallet-contract.test/status/env-x1',
  verify_url: 'https://wallet-contract.test/verify',
  signing_links: [{ email: 'signer@example.com' }],
  spam_notice: 'If signers do not receive the email, ask them to check their spam folder.',
  delivery: { delivered: 1, undeliverable: [], failed: [] },
  callback_secret: CALLBACK_SECRET,
  suggestion: { has_existing_signatures: false, signed_count: 0, total_count: 1, missing_signers: [] },
  // F-30.7 — the envelope-observer handle rides the create result (and the
  // stored replay body) on both rails.
  tracking: { token: 'ktt_' + 'T'.repeat(43), poll: 'GET https://wallet-contract.test/v1/envelope/env-x1' },
};

const PAID_201 = {
  ...ENVELOPE_201,
  payment: {
    payment_id: 'pay_1',
    network: 'eip155:8453',
    amount_usd_micros: 250000,
    asset: '0x8335',
    pay_to: '0x8d67',
    settlement_reference: '0xtx',
    settled_at: '2026-07-10T00:00:00Z',
  },
  tracking: {
    token: 'ktt_' + 'T'.repeat(43),
    poll: 'GET https://wallet-contract.test/v1/envelope/env-x1',
    status_url_auth: 'creator_or_tracking_token',
    creator_email: 'agent@example.com',
    note: 'poll with the tracking token; sign in via magic link for the dashboard',
  },
};

beforeEach(() => setWalletSeamsForTests(undefined));

type ToolCall = { content: Array<{ type: string; text: string }>; isError?: boolean };
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolCall> {
  return (await client.callTool({ name, arguments: args })) as ToolCall;
}

describe('wallet_status registration', () => {
  it('is registered read-only, and its description declares the no-key wallet path', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'wallet_status');
    assert.ok(t, 'wallet_status not registered');
    assert.equal(t!.annotations?.readOnlyHint, true);
    assert.match(String(t!.description), /never.*spend|read-only/i);
    assert.match(String(t!.description), /KYSIGNED_AUTHORIZATION|no API key/i);
  });
});

describe('wallet_status — AC-145/AC-170/AC-172 over the tool surface, NO auth env', () => {
  it('funded wallet → readiness JSON (provenance, address, terms, balance, coverage), no auth required', async () => {
    assert.equal(process.env.KYSIGNED_AUTHORIZATION, undefined, 'precondition: no auth env');
    setWalletSeamsForTests(seams());
    const r = await call('wallet_status');
    assert.ok(!r.isError, r.content[0]!.text);
    const s = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    assert.equal(s['configured'], true);
    assert.equal(s['payer_source'], 'default_allowance', 'AC-170: safe payer provenance in the status');
    assert.equal(s['address'], '0x0000000000000000000000000000000000000AaA');
    assert.equal(s['network'], 'eip155:8453');
    assert.equal(s['balance_status'], 'known');
    assert.equal(s['balance_atomic'], '550000');
    assert.equal(s['price_atomic'], '250000');
    assert.equal(s['sufficient'], true);
    assert.equal(s['envelopes_affordable'], 2);
  });

  it('no wallet configured → a NON-error status with the run402-init hint', async () => {
    setWalletSeamsForTests(seams(NOT_CONFIGURED));
    const r = await call('wallet_status');
    assert.ok(!r.isError, 'not-configured is a status report, not a tool error');
    const s = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    assert.equal(s['configured'], false);
    assert.match(String(s['hint']), /run402 init/);
  });

  it('underfunded wallet → fund hint + the structured QR-ready fund_wallet action (AC-172)', async () => {
    setWalletSeamsForTests(seams({ readBalanceAtomic: async () => 197_456n }));
    const r = await call('wallet_status');
    const s = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    assert.equal(s['sufficient'], false);
    assert.match(String(s['fund_hint']), /0x0000000000000000000000000000000000000AaA/);
    assert.match(String(s['fund_hint']), /eip155:8453/);
    const actions = s['next_actions'] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(actions) && actions.length === 1, 'exactly one structured funding action');
    const a = actions[0]!;
    assert.equal(a['type'], 'fund_wallet');
    assert.equal(a['network'], 'eip155:8453');
    assert.equal(a['token_symbol'], 'USDC');
    assert.equal(a['token_decimals'], 6);
    assert.equal(a['shortfall_atomic'], '52544');
    assert.equal(a['shortfall_decimal'], '0.052544');
    assert.equal(
      a['payment_uri'],
      'ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453/transfer?address=0x0000000000000000000000000000000000000AaA&uint256=52544',
    );
    assert.match(String(a['instruction']), /USDC.*Base mainnet|Base mainnet.*USDC/);
  });

  it('AC-171: every RPC provider down → balance_status unknown (structured, retryable), NEVER insufficient', async () => {
    const { BalanceUnknownError } = await import('./wallet.js');
    setWalletSeamsForTests(
      seams({
        readBalanceAtomic: async () => {
          throw new BalanceUnknownError('eip155:8453', [
            { provider: 'mainnet.base.org', error: 'TimeoutError' },
            { provider: 'base-rpc.publicnode.com', error: 'HttpRequestError' },
            { provider: '1rpc.io', error: 'HttpRequestError' },
          ]);
        },
      }),
    );
    const r = await call('wallet_status');
    assert.ok(!r.isError, 'balance-unknown is a structured status report for the read-only probe');
    const s = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    assert.equal(s['configured'], true);
    assert.equal(s['balance_status'], 'unknown');
    const be = s['balance_error'] as Record<string, unknown>;
    assert.equal(be['code'], 'balance_unknown_provider_exhausted');
    assert.equal(be['retryable'], true);
    assert.equal(be['mutation_state'], 'not_started');
    assert.ok(!('balance_atomic' in s), 'no fabricated zero balance');
    assert.ok(!('sufficient' in s), 'unknown is never reported as (in)sufficient');
  });

  it('AC-170: a conflicting explicit payer config fails CLOSED with the stable code', async () => {
    const { PayerConfigError } = await import('./wallet.js');
    setWalletSeamsForTests(
      seams({
        payerPresence: async () => {
          throw new PayerConfigError('payer_source_conflict', 'Both an explicit allowance path and an injected payment signer are configured.', [
            { type: 'fix_config', why: 'remove one source' },
          ]);
        },
      }),
    );
    const r = await call('wallet_status');
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /^Error: /);
    assert.match(r.content[0]!.text, /payer_source_conflict/);
    assert.match(r.content[0]!.text, /next_actions/);
  });

  it('an unpriced route (fork with x402 not wired) → isError with the actionable message', async () => {
    setWalletSeamsForTests(seams({ fetchFn: challengeFetch(404) }));
    const r = await call('wallet_status');
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /^Error: /);
    assert.match(r.content[0]!.text, /not wired|no wallet-payable|x402/i);
  });

  it('custody: no wallet_status output can carry key material (AC-146)', async () => {
    for (const s of [seams(), seams(NOT_CONFIGURED)]) {
      setWalletSeamsForTests(s);
      const r = await call('wallet_status');
      assert.doesNotMatch(r.content[0]!.text, /privateKey|private_key/i);
      assert.doesNotMatch(r.content[0]!.text, /[0-9a-fA-F]{64}/);
    }
  });
});

describe('create_envelope_x402 — AC-144/AC-145 over the tool surface, NO auth env', () => {
  it('is registered non-read-only with creator_email REQUIRED and a spend-declaring description', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'create_envelope_x402');
    assert.ok(t, 'create_envelope_x402 not registered');
    assert.equal(t!.annotations?.readOnlyHint, false);
    const schema = t!.inputSchema as { required?: string[] };
    assert.ok(schema.required?.includes('creator_email'), 'creator_email must be required');
    assert.ok(schema.required?.includes('document_name'));
    assert.ok(schema.required?.includes('signers'));
    assert.match(String(t!.description), /pays|spends/i);
  });

  it('happy path: preflight → readiness → paid create; result carries the projection + receipt + tracking + the generated spending-intent key', async () => {
    const flow = createFlowSeams({ paid: { status: 201, body: PAID_201 } });
    setWalletSeamsForTests(flow.s);
    const r = await call('create_envelope_x402', { ...CREATE_ARGS });
    assert.ok(!r.isError, r.content[0]!.text);
    const out = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    assert.equal(out['envelope_id'], 'env-x1');
    assert.deepEqual(out['payment'], PAID_201.payment);
    assert.deepEqual(out['tracking'], PAID_201.tracking);
    // #155 — the documented envelope-result fields survive the FIRST success
    // (previously only the replay returned them).
    assert.deepEqual(out['delivery'], ENVELOPE_201.delivery, 'delivery outcome on the first success');
    assert.equal(out['spam_notice'], ENVELOPE_201.spam_notice);
    assert.equal(out['callback_secret'], CALLBACK_SECRET, 'the one-time secret is returned on the FIRST success');
    assert.deepEqual(out['suggestion'], ENVELOPE_201.suggestion);
    const intent = String(out['spending_intent_key']);
    assert.ok(intent.length >= 8, 'a generated spending-intent key is returned');
    // the paid call carried exactly that key + the full body incl. creator_email
    assert.equal(flow.paidCalls.length, 1);
    assert.equal(flow.paidCalls[0]!.headers['Idempotency-Key'], intent);
    assert.equal(flow.paidCalls[0]!.body['creator_email'], 'agent@example.com');
    // preflight ran BEFORE the paid call, against the preflight route
    assert.ok(flow.unpaidCalls.some((u) => u.endsWith('/v1/envelope/preflight')));
  });

  it('honors a caller-supplied idempotency_key verbatim (AC-144 retry control) and sends it to preflight', async () => {
    const flow = createFlowSeams({ paid: { status: 201, body: PAID_201 } });
    setWalletSeamsForTests(flow.s);
    const r = await call('create_envelope_x402', { ...CREATE_ARGS, idempotency_key: 'agent-intent-7' });
    const out = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    assert.equal(out['spending_intent_key'], 'agent-intent-7');
    assert.equal(flow.paidCalls[0]!.headers['Idempotency-Key'], 'agent-intent-7');
    // the preflight body carried the intent key → the server ran the AC-144 replay lookup
    assert.equal(flow.preflightBodies[0]!['idempotency_key'], 'agent-intent-7');
  });

  it('AC-144 retry: preflight already_created → the stored envelope comes back replayed, NOTHING is paid', async () => {
    const flow = createFlowSeams({
      preflight: {
        status: 200,
        body: {
          ok: true,
          already_created: true,
          envelope: { ...ENVELOPE_201, envelope_id: 'env-prev', internal_flag: 'MUST_NOT_PASS' },
        },
      },
    });
    setWalletSeamsForTests(flow.s);
    const r = await call('create_envelope_x402', { ...CREATE_ARGS, idempotency_key: 'agent-intent-7' });
    assert.ok(!r.isError, r.content[0]!.text);
    const out = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    assert.equal(out['replayed'], true);
    assert.equal(out['envelope_id'], 'env-prev');
    assert.equal(out['spending_intent_key'], 'agent-intent-7');
    // #155 — the replay goes through the SAME projection: documented fields
    // survive, undocumented stored fields are dropped.
    assert.deepEqual(out['delivery'], ENVELOPE_201.delivery);
    assert.equal(out['callback_secret'], CALLBACK_SECRET);
    assert.ok(!('internal_flag' in out), 'undocumented stored fields must not pass through the replay');
    assert.equal(flow.factory(), 0, 'a replayed intent must never construct the paid fetch');
    assert.equal(flow.paidCalls.length, 0);
    assert.ok(!flow.unpaidCalls.some((u) => u.endsWith('/v1/x402/envelope')), 'no challenge probe either');
  });

  it('#155 — undocumented fields in the paid 201 are dropped (deny-by-default projection)', async () => {
    const flow = createFlowSeams({
      paid: {
        status: 201,
        body: { ...PAID_201, internal_flag: 'MUST_NOT_PASS', payment_authorization: 'MUST_NOT_PASS' },
      },
    });
    setWalletSeamsForTests(flow.s);
    const r = await call('create_envelope_x402', { ...CREATE_ARGS });
    assert.ok(!r.isError, r.content[0]!.text);
    const out = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    assert.ok(!('internal_flag' in out));
    assert.ok(!('payment_authorization' in out));
    assert.equal(out['callback_secret'], CALLBACK_SECRET, 'documented fields still pass');
  });

  it('#155 — first success and replay expose the SAME envelope-result fields (payment/tracking are first-call extras; replayed/note are replay metadata)', async () => {
    const first = createFlowSeams({ paid: { status: 201, body: PAID_201 } });
    setWalletSeamsForTests(first.s);
    const r1 = await call('create_envelope_x402', { ...CREATE_ARGS, idempotency_key: 'parity-1' });
    assert.ok(!r1.isError, r1.content[0]!.text);
    const out1 = JSON.parse(r1.content[0]!.text) as Record<string, unknown>;

    const replay = createFlowSeams({
      preflight: { status: 200, body: { ok: true, already_created: true, envelope: ENVELOPE_201 } },
    });
    setWalletSeamsForTests(replay.s);
    const r2 = await call('create_envelope_x402', { ...CREATE_ARGS, idempotency_key: 'parity-1' });
    assert.ok(!r2.isError, r2.content[0]!.text);
    const out2 = JSON.parse(r2.content[0]!.text) as Record<string, unknown>;

    // F-30.7: `tracking` is an envelope-result field now (present on BOTH the
    // first call and the replay); only `payment` stays a first-call extra.
    const envKeys1 = Object.keys(out1).filter((k) => !['payment', 'spending_intent_key'].includes(k)).sort();
    const envKeys2 = Object.keys(out2).filter((k) => !['replayed', 'note', 'spending_intent_key'].includes(k)).sort();
    assert.deepEqual(envKeys1, envKeys2, 'first-call and replay envelope-result schemas must match');
  });

  it('a preflight validation failure surfaces the coded error and NEVER attempts payment (AC-144 ordering)', async () => {
    const flow = createFlowSeams({
      preflight: { status: 400, body: { error: 'plus-alias signer', code: 'validation_plus_alias' } },
    });
    setWalletSeamsForTests(flow.s);
    const r = await call('create_envelope_x402', { ...CREATE_ARGS });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /validation_plus_alias/);
    assert.equal(flow.factory(), 0, 'paid fetch must never be constructed');
    assert.equal(flow.paidCalls.length, 0);
    assert.ok(!flow.unpaidCalls.some((u) => u.endsWith('/v1/x402/envelope')), 'challenge probe skipped too');
  });

  it('an underfunded wallet fails BEFORE any payment attempt with fund guidance + the structured action (AC-145/AC-172)', async () => {
    const flow = createFlowSeams({ balance: 10_000n });
    setWalletSeamsForTests(flow.s);
    const r = await call('create_envelope_x402', { ...CREATE_ARGS, idempotency_key: 'fund-me-1' });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /0x0000000000000000000000000000000000000AaA/);
    assert.match(r.content[0]!.text, /eip155:8453/);
    assert.match(r.content[0]!.text, /250000/);
    const body = JSON.parse(r.content[0]!.text.replace(/^Error: /, '')) as Record<string, unknown>;
    assert.equal(body['code'], 'insufficient_funds');
    assert.equal(body['mutation_state'], 'not_started');
    const actions = body['next_actions'] as Array<Record<string, unknown>>;
    assert.equal(actions[0]!['type'], 'fund_wallet');
    assert.equal(actions[0]!['shortfall_atomic'], '240000');
    assert.match(String(actions[0]!['payment_uri']), /^ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453\/transfer\?address=0x0000000000000000000000000000000000000AaA&uint256=240000$/);
    assert.match(String((actions[0]!['retry'] as Record<string, unknown>)['note']), /fund-me-1/, 'retry names the SAME spending-intent key');
    assert.equal(flow.factory(), 0);
    assert.equal(flow.paidCalls.length, 0);
  });

  it('AC-171: all RPC providers down at the readiness gate → structured balance-unknown, NOTHING paid, never insufficient', async () => {
    const { BalanceUnknownError } = await import('./wallet.js');
    const flow = createFlowSeams({});
    setWalletSeamsForTests({
      ...flow.s,
      readBalanceAtomic: async () => {
        throw new BalanceUnknownError('eip155:8453', [
          { provider: 'mainnet.base.org', error: 'TimeoutError' },
          { provider: 'base-rpc.publicnode.com', error: 'HttpRequestError' },
        ]);
      },
    });
    const r = await call('create_envelope_x402', { ...CREATE_ARGS });
    assert.equal(r.isError, true);
    const body = JSON.parse(r.content[0]!.text.replace(/^Error: /, '')) as Record<string, unknown>;
    assert.equal(body['code'], 'balance_unknown_provider_exhausted');
    assert.equal(body['retryable'], true);
    assert.equal(body['safe_to_retry'], true);
    assert.equal(body['mutation_state'], 'not_started');
    assert.match(String(body['message']), /no payment was dispatched/i);
    assert.notEqual(body['code'], 'insufficient_funds', 'provider exhaustion is NEVER the insufficient-funds code');
    assert.ok(!('next_actions' in body && JSON.stringify(body['next_actions']).includes('fund_wallet')), 'no funding action for an UNKNOWN balance');
    assert.equal(flow.factory(), 0, 'the paid stack is never constructed on an unknown balance');
    assert.equal(flow.paidCalls.length, 0);
  });

  it('no wallet configured → the run402-init guidance, nothing fetched, nothing paid', async () => {
    const flow = createFlowSeams({});
    setWalletSeamsForTests({ ...flow.s, ...NOT_CONFIGURED });
    const r = await call('create_envelope_x402', { ...CREATE_ARGS });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /run402 init/);
    assert.match(r.content[0]!.text, /KYSIGNED_RUN402_ALLOWANCE_PATH/, 'names the explicit-source escape hatch');
    assert.equal(flow.unpaidCalls.length, 0);
    assert.equal(flow.paidCalls.length, 0);
  });

  it('a banked-credit outcome passes through machine-readably (payment_banked, credit_email, next_actions)', async () => {
    const flow = createFlowSeams({
      paid: {
        status: 400,
        body: {
          error: 'plus-alias signer',
          code: 'validation_plus_alias',
          payment_banked: true,
          credit_email: 'agent@example.com',
          payment: PAID_201.payment,
          next_actions: [{ type: 'use_banked_credit', why: 'the payment was banked' }],
        },
      },
    });
    setWalletSeamsForTests(flow.s);
    const r = await call('create_envelope_x402', { ...CREATE_ARGS });
    assert.equal(r.isError, true);
    const body = JSON.parse(r.content[0]!.text.replace(/^Error: /, '')) as Record<string, unknown>;
    assert.equal(body['payment_banked'], true);
    assert.equal(body['credit_email'], 'agent@example.com');
    assert.ok(Array.isArray(body['next_actions']));
  });

  it('a gateway insufficient-funds settle failure passes through machine-readably (payment_insufficient_funds + fund_wallet)', async () => {
    const flow = createFlowSeams({
      paid: {
        status: 402,
        body: {
          error: 'Wallet has insufficient USDC on Base mainnet for this priced route.',
          code: 'payment_insufficient_funds',
          next_actions: [
            { type: 'fund_wallet', network: 'eip155:8453', asset: 'USDC', minimum_amount_usd_micros: 250000 },
          ],
        },
      },
    });
    setWalletSeamsForTests(flow.s);
    const r = await call('create_envelope_x402', { ...CREATE_ARGS });
    assert.equal(r.isError, true);
    const body = JSON.parse(r.content[0]!.text.replace(/^Error: /, '')) as Record<string, unknown>;
    assert.equal(body['code'], 'payment_insufficient_funds');
    const actions = body['next_actions'] as Array<{ type: string }>;
    assert.equal(actions[0]!.type, 'fund_wallet');
  });

  it('payment stack unavailable (factory null) → actionable error, no unpaid fallback for the paid call', async () => {
    const flow = createFlowSeams({ paidUnavailable: true });
    setWalletSeamsForTests(flow.s);
    const r = await call('create_envelope_x402', { ...CREATE_ARGS });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /payment stack|cannot pay|unavailable/i);
    assert.equal(flow.paidCalls.length, 0);
  });

  it('exactly one PDF source is enforced locally', async () => {
    const flow = createFlowSeams({});
    setWalletSeamsForTests(flow.s);
    const r = await call('create_envelope_x402', {
      ...CREATE_ARGS,
      pdf_url: 'https://example.com/doc.pdf',
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /exactly one of pdf_base64 or pdf_url/);
    assert.equal(flow.unpaidCalls.length, 0);
  });

  it('custody: no create output can carry key material (AC-146)', async () => {
    for (const flow of [
      createFlowSeams({ paid: { status: 201, body: PAID_201 } }),
      createFlowSeams({ balance: 0n }),
      createFlowSeams({ paidUnavailable: true }),
    ]) {
      setWalletSeamsForTests(flow.s);
      const r = await call('create_envelope_x402', { ...CREATE_ARGS });
      assert.doesNotMatch(r.content[0]!.text, /privateKey|private_key/i);
      // #155: the documented one-time webhook secret is whs_ + 64 hex BY DESIGN
      // (webhookSignature.ts) — whitelist exactly that shape; a BARE 64-hex run
      // (a raw EVM key) anywhere in the output stays banned.
      assert.doesNotMatch(r.content[0]!.text, /(?<!whs_)[0-9a-fA-F]{64}/);
    }
  });
});

// ── 49.5 — spend disclosure a host can gate on + schema-level custody (AC-146) ─
describe('spend disclosure + custody hard lines (AC-146)', () => {
  it('create_envelope_x402 is annotated so hosts can demand confirmation: destructiveHint (irreversible real-money spend) + wallet-paid title', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'create_envelope_x402')!;
    assert.equal(t.annotations?.readOnlyHint, false);
    assert.equal(t.annotations?.destructiveHint, true, 'paying real funds is gate-worthy — hosts confirm destructive tools');
    assert.match(String(t.annotations?.title), /wallet-paid/i);
    assert.match(String(t.description), /SPENDS REAL FUNDS/);
    assert.match(String(t.description), /never a tool argument|never appears in output/i);
  });

  it('wallet_status stays read-only and never gate-worthy', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'wallet_status')!;
    assert.equal(t.annotations?.readOnlyHint, true);
    assert.notEqual(t.annotations?.destructiveHint, true);
  });

  it('no wallet-tool schema accepts key material anywhere (the only *key* input is the spending-intent idempotency_key)', async () => {
    const { tools } = await client.listTools();
    const names: string[] = [];
    const walk = (schema: unknown, path: string): void => {
      if (!schema || typeof schema !== 'object') return;
      const props = (schema as { properties?: Record<string, unknown> }).properties;
      if (props) {
        for (const [name, sub] of Object.entries(props)) {
          names.push(name);
          walk(sub, `${path}.${name}`);
        }
      }
      const items = (schema as { items?: unknown }).items;
      if (items) walk(items, `${path}[]`);
    };
    for (const toolName of ['wallet_status', 'create_envelope_x402']) {
      walk(tools.find((x) => x.name === toolName)!.inputSchema, toolName);
    }
    for (const n of names) {
      assert.doesNotMatch(n, /private|secret|mnemonic|seed|wallet_key/i, `suspicious schema property: ${n}`);
      if (/key/i.test(n)) assert.equal(n, 'idempotency_key', `unexpected key-like property: ${n}`);
    }
  });
});

// ── F-30.7 (#154) — no-key status polling with the tracking token ────────────
describe('check_envelope_status + tracking_token — NO auth env (F-30.7 / AC-173)', () => {
  it('polls the envelope with the tracking token as the Authorization — no KYSIGNED_AUTHORIZATION, no local-auth failure', async () => {
    const TRACKING = 'ktt_' + 'T'.repeat(43);
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), auth: ((init?.headers as Record<string, string>) ?? {})['Authorization'] });
      return new Response(
        JSON.stringify({ id: 'env-x1', status: 'active', signers: [{ email: 'signer@example.com', status: 'pending', delivery_status: 'pending' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      assert.equal(process.env.KYSIGNED_AUTHORIZATION, undefined, 'precondition: no auth env');
      const r = await call('check_envelope_status', { envelope_id: 'env-x1', tracking_token: TRACKING });
      assert.ok(!r.isError, r.content[0]!.text);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, 'https://wallet-contract.test/v1/envelope/env-x1');
      assert.equal(calls[0]!.auth, TRACKING, 'the token IS the Authorization — verbatim');
      const body = JSON.parse(r.content[0]!.text) as { signers: Array<{ email: string }> };
      assert.equal(body.signers[0]!.email, 'signer@example.com', 'full roster passes through verbatim');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
