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
    readAllowanceAddress: async () => '0x0000000000000000000000000000000000000AaA',
    allowancePath: async () => 'C:/fake/.config/run402/allowance.json',
    fetchFn: challengeFetch(),
    readBalanceAtomic: async () => 550_000n,
    paidFetchFactory: async () => null,
    ...overrides,
  };
}

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

const PAID_201 = {
  envelope_id: 'env-x1',
  status: 'active',
  document_hash: 'abc',
  status_url: 'https://wallet-contract.test/status/env-x1',
  verify_url: 'https://wallet-contract.test/verify',
  signing_links: [{ email: 'signer@example.com' }],
  payment: {
    payment_id: 'pay_1',
    network: 'eip155:8453',
    amount_usd_micros: 250000,
    asset: '0x8335',
    pay_to: '0x8d67',
    settlement_reference: '0xtx',
    settled_at: '2026-07-10T00:00:00Z',
  },
  tracking: { status_url_auth: 'creator', creator_email: 'agent@example.com', note: 'sign in via magic link' },
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

describe('wallet_status — AC-145 over the tool surface, NO auth env', () => {
  it('funded wallet → readiness JSON (address, terms, balance, coverage), no auth required', async () => {
    assert.equal(process.env.KYSIGNED_AUTHORIZATION, undefined, 'precondition: no auth env');
    setWalletSeamsForTests(seams());
    const r = await call('wallet_status');
    assert.ok(!r.isError, r.content[0]!.text);
    const s = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    assert.equal(s['configured'], true);
    assert.equal(s['address'], '0x0000000000000000000000000000000000000AaA');
    assert.equal(s['network'], 'eip155:8453');
    assert.equal(s['balance_atomic'], '550000');
    assert.equal(s['price_atomic'], '250000');
    assert.equal(s['sufficient'], true);
    assert.equal(s['envelopes_affordable'], 2);
  });

  it('no wallet configured → a NON-error status with the run402-init hint', async () => {
    setWalletSeamsForTests(seams({ readAllowanceAddress: async () => null }));
    const r = await call('wallet_status');
    assert.ok(!r.isError, 'not-configured is a status report, not a tool error');
    const s = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    assert.equal(s['configured'], false);
    assert.match(String(s['hint']), /run402 init/);
  });

  it('underfunded wallet → sufficient:false with the fund hint (address+network+asset+minimum)', async () => {
    setWalletSeamsForTests(seams({ readBalanceAtomic: async () => 10_000n }));
    const r = await call('wallet_status');
    const s = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    assert.equal(s['sufficient'], false);
    assert.match(String(s['fund_hint']), /0x0000000000000000000000000000000000000AaA/);
    assert.match(String(s['fund_hint']), /eip155:8453/);
  });

  it('an unpriced route (fork with x402 not wired) → isError with the actionable message', async () => {
    setWalletSeamsForTests(seams({ fetchFn: challengeFetch(404) }));
    const r = await call('wallet_status');
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /^Error: /);
    assert.match(r.content[0]!.text, /not wired|no wallet-payable|x402/i);
  });

  it('custody: no wallet_status output can carry key material (AC-146)', async () => {
    for (const s of [seams(), seams({ readAllowanceAddress: async () => null })]) {
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
          envelope: { envelope_id: 'env-prev', status_url: 'https://wallet-contract.test/status/env-prev' },
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
    assert.equal(flow.factory(), 0, 'a replayed intent must never construct the paid fetch');
    assert.equal(flow.paidCalls.length, 0);
    assert.ok(!flow.unpaidCalls.some((u) => u.endsWith('/v1/x402/envelope')), 'no challenge probe either');
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

  it('an underfunded wallet fails BEFORE any payment attempt with the fund guidance (AC-145)', async () => {
    const flow = createFlowSeams({ balance: 10_000n });
    setWalletSeamsForTests(flow.s);
    const r = await call('create_envelope_x402', { ...CREATE_ARGS });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /0x0000000000000000000000000000000000000AaA/);
    assert.match(r.content[0]!.text, /eip155:8453/);
    assert.match(r.content[0]!.text, /250000/);
    assert.equal(flow.factory(), 0);
    assert.equal(flow.paidCalls.length, 0);
  });

  it('no wallet configured → the run402-init guidance, nothing fetched, nothing paid', async () => {
    const flow = createFlowSeams({});
    setWalletSeamsForTests({ ...flow.s, readAllowanceAddress: async () => null });
    const r = await call('create_envelope_x402', { ...CREATE_ARGS });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /run402 init/);
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
      assert.doesNotMatch(r.content[0]!.text, /[0-9a-fA-F]{64}/);
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
