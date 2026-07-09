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
    ...overrides,
  };
}

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
