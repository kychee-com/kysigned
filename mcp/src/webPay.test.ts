/**
 * The web endpoint's paid create over the x402 MCP transport (82.3, F-46.2,
 * DD-74, DD-76). A fake kysigned API stands in for the free preflight and the
 * always-priced route (which, like the real platform, decodes the payment
 * header and settles before creating). The interop case drives the handler
 * with the reference @x402/mcp client and a real EVM signer on a throwaway
 * key: the payment is genuinely signed, offline, and nothing touches a chain.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { wrapMCPClientWithPayment } from '@x402/mcp';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { toClientEvmSigner } from '@x402/evm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { handleMcpRequest, type WebMcpDeps } from './webServer.js';
import { deriveIntentKey } from './webPay.js';
import {
  CAPTURED_PAYMENT_REQUIRED,
  ORIGIN,
  connectClient,
  fakeApi,
  firstText,
  jsonResponse,
  pricedRoute,
  unpricedRoute,
  type FakeRoute,
  type RecordedCall,
} from './webTestKit.js';

const PDF_B64 = Buffer.from('%PDF-1.7\n% kysigned test document\n').toString('base64');
const ARGS = {
  creator_email: 'Agent-Owner@Example.com',
  document_name: 'Test agreement',
  pdf_base64: PDF_B64,
  signers: [{ email: 'signer@example.com', name: 'Sam Signer' }],
};
const SETTLE = { success: true, transaction: '0xsettled', network: 'eip155:8453', payer: '0xpayer' };

/** A stateful fake API: preflight validates and replays; the priced route settles, then creates. */
function paidApi(opts: { priced?: boolean; createStatus?: number; createBody?: Record<string, unknown>; paid402?: boolean } = {}) {
  const created = new Map<string, Record<string, unknown>>();
  let settlements = 0;
  const preflight: FakeRoute = (c) => {
    if (c.method !== 'POST' || c.url !== `${ORIGIN}/v1/envelope/preflight`) return undefined;
    const body = JSON.parse(c.body ?? '{}') as Record<string, unknown>;
    if (!Array.isArray(body['signers']) || typeof body['document_name'] !== 'string' || body['document_name'] === '') {
      return jsonResponse({ error: 'document_name is required', code: 'validation_failed' }, 400);
    }
    const key = String(body['idempotency_key'] ?? '');
    const env = created.get(key);
    return jsonResponse(env ? { ok: true, already_created: true, envelope: env } : { ok: true });
  };
  const paidCreate: FakeRoute = (c) => {
    if (c.method !== 'POST' || c.url !== `${ORIGIN}/v1/x402/envelope` || !c.headers['payment-signature']) return undefined;
    const payload = decodePaymentSignatureHeader(c.headers['payment-signature']);
    const accepted = payload.accepted as unknown as Record<string, unknown>;
    const auth = (payload.payload as Record<string, Record<string, unknown>>)['authorization']!;
    if (opts.paid402) {
      return new Response('{"code":"PAYMENT_INVALID"}', {
        status: 402,
        headers: { 'Content-Type': 'application/json', 'Payment-Required': CAPTURED_PAYMENT_REQUIRED },
      });
    }
    // The platform's checks, before anything is settled or created.
    if (accepted['amount'] !== '250000' || String(auth['to']).toLowerCase() !== '0x8d671cd12ecf69e0b049a6b55c5b318097b4bc35') {
      return jsonResponse({ code: 'PAYMENT_PROOF_MISMATCH' }, 402);
    }
    settlements++;
    if (opts.createStatus && opts.createStatus !== 201) {
      return jsonResponse(opts.createBody ?? { code: 'validation_failed', payment_banked: true }, opts.createStatus, {
        'Payment-Response': encodePaymentResponseHeader(SETTLE as never),
      });
    }
    const env = {
      envelope_id: `env_${created.size + 1}`,
      status: 'active',
      document_hash: 'abc123',
      status_url: `${ORIGIN}/v1/envelope/env_${created.size + 1}`,
      verify_url: `${ORIGIN}/verify`,
      signing_links: [],
      payment: { payment_id: 'pay_1', amount_usd_micros: 250000, network: 'eip155:8453' },
      tracking: { token: 'ktt_tracking_for_this_envelope', poll: 'GET /v1/envelope/:id' },
    };
    created.set(c.headers['idempotency-key'] ?? '', env);
    return jsonResponse(env, 201, { 'Payment-Response': encodePaymentResponseHeader(SETTLE as never) });
  };
  const api = fakeApi([preflight, paidCreate, opts.priced === false ? unpricedRoute : pricedRoute]);
  const deps: WebMcpDeps = { origin: ORIGIN, fetchFn: api.fetchFn, version: '9.9.9' };
  return { deps, calls: api.calls, settlements: () => settlements };
}

const paidCalls = (calls: RecordedCall[]) => calls.filter((c) => c.url === `${ORIGIN}/v1/x402/envelope` && c.headers['payment-signature']);
const preflightKeys = (calls: RecordedCall[]) =>
  calls.filter((c) => c.url === `${ORIGIN}/v1/envelope/preflight`).map((c) => (JSON.parse(c.body ?? '{}') as { idempotency_key?: string }).idempotency_key);

function payingClient(key = generatePrivateKey()) {
  const account = privateKeyToAccount(key);
  const payments = new x402Client().register('eip155:8453', new ExactEvmScheme(toClientEvmSigner(account)));
  return { key, account, payments };
}

describe('unpaid call: validate for free, then the route\'s own terms (AC-284)', () => {
  it('exactly one PDF source is required, checked before any network call', async () => {
    const { deps, calls } = paidApi();
    const client = await connectClient((req) => handleMcpRequest(req, deps));
    for (const args of [{ ...ARGS, pdf_url: 'https://example.com/a.pdf' }, { ...ARGS, pdf_base64: undefined }]) {
      const r = await client.callTool({ name: 'create_envelope_x402', arguments: args });
      assert.equal(r.isError, true);
      assert.match(firstText(r), /exactly one of pdf_base64 or pdf_url/);
    }
    assert.equal(calls.length, 0);
    await client.close();
  });

  it('an invalid request gets the preflight\'s validation error and no payment is requested', async () => {
    const { deps, calls } = paidApi();
    const client = await connectClient((req) => handleMcpRequest(req, deps));
    const r = await client.callTool({ name: 'create_envelope_x402', arguments: { ...ARGS, document_name: '' } });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent, undefined, 'not a payment-required result');
    const body = JSON.parse(firstText(r).replace(/^Error: /, ''));
    assert.equal(body.code, 'preflight_rejected');
    assert.equal(body.detail.code, 'validation_failed');
    assert.match(body.message, /nothing was charged/i);
    assert.equal(calls.filter((c) => c.url === `${ORIGIN}/v1/x402/envelope`).length, 0, 'the priced route was never touched');
    await client.close();
  });

  it('a valid request answers payment-required in the transport shape, with the route\'s exact terms', async () => {
    const { deps, calls } = paidApi();
    const client = await connectClient((req) => handleMcpRequest(req, deps));
    const r = await client.callTool({ name: 'create_envelope_x402', arguments: ARGS });
    assert.equal(r.isError, true);
    const challenge = decodePaymentRequiredHeader(CAPTURED_PAYMENT_REQUIRED);
    assert.deepEqual(r.structuredContent, challenge, 'structured content is the route\'s own PaymentRequired');
    const content = r.content as Array<{ type: string; text: string }>;
    assert.deepEqual(JSON.parse(content[0]!.text), challenge, 'first text item is the same object, JSON-encoded');
    const prose = content[1]!.text;
    for (const alt of ['kysigned-mcp', '/v1/x402/envelope', '/account/api-keys', 'check_price']) {
      assert.ok(prose.includes(alt), `the plain-language item names ${alt}`);
    }
    assert.equal(paidCalls(calls).length, 0, 'nothing was paid');
    await client.close();
  });

  it('an instance with no priced route answers not-enabled, never a payment request', async () => {
    const { deps } = paidApi({ priced: false });
    const client = await connectClient((req) => handleMcpRequest(req, deps));
    const r = await client.callTool({ name: 'create_envelope_x402', arguments: ARGS });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent, undefined);
    assert.equal(JSON.parse(firstText(r).replace(/^Error: /, '')).code, 'x402_not_enabled');
    await client.close();
  });
});

describe('paid call through the reference x402 MCP client (AC-285, hermetic)', () => {
  it('pays with the caller\'s own wallet and gets the envelope, receipt, tracking token and settlement', async () => {
    const { deps, calls, settlements } = paidApi();
    const { account, payments } = payingClient();
    const mcp = new Client({ name: 'x402-agent', version: '0.0.0' });
    await connectClient((req) => handleMcpRequest(req, deps), { client: mcp });
    const agent = wrapMCPClientWithPayment(mcp, payments, { autoPayment: true });

    const result = await agent.callTool('create_envelope_x402', ARGS);
    assert.equal(result.paymentMade, true);
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.paymentResponse, SETTLE, 'settlement arrives in _meta["x402/payment-response"]');
    const out = JSON.parse((result.content[0] as { text: string }).text);
    assert.equal(out.envelope_id, 'env_1');
    assert.equal(out.payment.payment_id, 'pay_1');
    assert.equal(out.tracking.token, 'ktt_tracking_for_this_envelope');
    assert.equal(out.spending_intent_key, deriveIntentKey(ARGS));

    const paid = paidCalls(calls);
    assert.equal(paid.length, 1, 'exactly one relayed payment');
    assert.equal(settlements(), 1);
    const relayed = decodePaymentSignatureHeader(paid[0]!.headers['payment-signature']!);
    const auth = (relayed.payload as Record<string, Record<string, unknown>>)['authorization']!;
    assert.equal(String(auth['from']).toLowerCase(), account.address.toLowerCase(), 'the caller\'s wallet signed it');
    assert.equal(paid[0]!.headers['idempotency-key'], deriveIntentKey(ARGS));
    assert.equal(JSON.parse(paid[0]!.body!).idempotency_key, undefined, 'the key rides the header, not the create body');
    await mcp.close();
  });
});

describe('retries never double-pay (AC-286, DD-76)', () => {
  it('the unpaid call and the paid retry share one derived intent; a repeat replays with no second settlement', async () => {
    const { deps, calls, settlements } = paidApi();
    const { payments } = payingClient();
    const mcp = new Client({ name: 'x402-agent', version: '0.0.0' });
    await connectClient((req) => handleMcpRequest(req, deps), { client: mcp });
    const agent = wrapMCPClientWithPayment(mcp, payments, { autoPayment: true });

    await agent.callTool('create_envelope_x402', ARGS);
    const again = await agent.callTool('create_envelope_x402', ARGS);
    assert.equal(again.paymentMade, false, 'the repeat never asked for payment');
    const out = JSON.parse((again.content[0] as { text: string }).text);
    assert.equal(out.replayed, true);
    assert.equal(out.envelope_id, 'env_1');
    assert.equal(settlements(), 1, 'one settlement across both calls');
    const keys = preflightKeys(calls);
    assert.ok(keys.length >= 3);
    assert.ok(keys.every((k) => k === deriveIntentKey(ARGS)), 'every preflight carried the same derived intent');
    await mcp.close();
  });

  it('a replay never relays an attached payment', async () => {
    const { deps, calls, settlements } = paidApi();
    const { payments } = payingClient();
    const mcp = new Client({ name: 'x402-agent', version: '0.0.0' });
    await connectClient((req) => handleMcpRequest(req, deps), { client: mcp });
    const agent = wrapMCPClientWithPayment(mcp, payments, { autoPayment: true });
    await agent.callTool('create_envelope_x402', ARGS);
    const payload = await payments.createPaymentPayload(decodePaymentRequiredHeader(CAPTURED_PAYMENT_REQUIRED));
    const r = await mcp.callTool({ name: 'create_envelope_x402', arguments: ARGS, _meta: { 'x402/payment': payload } });
    assert.notEqual(r.isError, true);
    assert.equal(JSON.parse(firstText(r)).replayed, true);
    assert.equal(paidCalls(calls).length, 1, 'the second payment never left the endpoint');
    assert.equal(settlements(), 1);
    await mcp.close();
  });

  it('the derived key follows the request, and an explicit key wins', () => {
    const k = deriveIntentKey(ARGS);
    assert.match(k, /^mcpweb-[0-9a-f]{64}$/);
    assert.equal(deriveIntentKey({ ...ARGS, creator_email: ' agent-owner@example.com ' }), k, 'email case and spaces do not matter');
    assert.notEqual(deriveIntentKey({ ...ARGS, document_name: 'Another agreement' }), k);
    assert.notEqual(deriveIntentKey({ ...ARGS, signers: [{ email: 'other@example.com', name: 'Sam Signer' }] }), k);
    assert.notEqual(deriveIntentKey({ ...ARGS, pdf_base64: Buffer.from('%PDF-1.7\nother\n').toString('base64') }), k);
    assert.equal(deriveIntentKey({ ...ARGS, idempotency_key: '  mine-1 ' }), 'mine-1');
  });

  it('no key material in any output, recorded request or source (the endpoint only relays)', async () => {
    const { deps, calls } = paidApi();
    const { key, payments } = payingClient();
    const mcp = new Client({ name: 'x402-agent', version: '0.0.0' });
    await connectClient((req) => handleMcpRequest(req, deps), { client: mcp });
    const agent = wrapMCPClientWithPayment(mcp, payments, { autoPayment: true });
    const result = await agent.callTool('create_envelope_x402', ARGS);
    const hex = key.slice(2).toLowerCase();
    assert.ok(!JSON.stringify(result).toLowerCase().includes(hex));
    assert.ok(!JSON.stringify(calls).toLowerCase().includes(hex));
    const src = readFileSync(new URL('./webPay.ts', import.meta.url), 'utf8');
    for (const signing of ['privateKeyToAccount', 'signTypedData', 'createPaymentPayload', "from 'viem"]) {
      assert.ok(!src.includes(signing), `webPay.ts never signs (${signing})`);
    }
    await mcp.close();
  });
});

describe('paid outcomes other than 201 (F-46.2)', () => {
  async function paidDirect(opts: Parameters<typeof paidApi>[0]) {
    const api = paidApi(opts);
    const { payments } = payingClient();
    const client = await connectClient((req) => handleMcpRequest(req, api.deps));
    const payload = await payments.createPaymentPayload(decodePaymentRequiredHeader(CAPTURED_PAYMENT_REQUIRED));
    const r = await client.callTool({ name: 'create_envelope_x402', arguments: ARGS, _meta: { 'x402/payment': payload } });
    await client.close();
    return { r, api };
  }

  it('a settled-but-failed create passes through machine-readably and never asks to pay again', async () => {
    const { r } = await paidDirect({ createStatus: 400, createBody: { code: 'validation_failed', payment_banked: true, credit_email: 'agent-owner@example.com' } });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent, undefined, 'never a payment-required shape after a settlement');
    const body = JSON.parse(firstText(r).replace(/^Error: /, ''));
    assert.equal(body.http_status, 400);
    assert.equal(body.payment_banked, true);
    assert.deepEqual((r._meta as Record<string, unknown>)['x402/payment-response'], SETTLE);
  });

  it('a payment the platform refused (402, nothing settled) returns the route\'s fresh terms', async () => {
    const { r, api } = await paidDirect({ paid402: true });
    assert.equal(r.isError, true);
    assert.deepEqual(r.structuredContent, decodePaymentRequiredHeader(CAPTURED_PAYMENT_REQUIRED));
    assert.equal(api.settlements(), 0);
  });
});

describe('the web paid tool\'s inputs match the local wallet-paid tool (lockstep)', () => {
  it('same input schema as the local create_envelope_x402, apart from how an omitted key is chosen', async () => {
    const { server } = await import('./server.js');
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const local = new Client({ name: 'lockstep', version: '0.0.0' });
    await local.connect(a);
    const localTool = (await local.listTools()).tools.find((t) => t.name === 'create_envelope_x402')!;
    await local.close();

    const { deps } = paidApi();
    const web = await connectClient((req) => handleMcpRequest(req, deps));
    const webTool = (await web.listTools()).tools.find((t) => t.name === 'create_envelope_x402')!;
    await web.close();

    const strip = (schema: unknown) => {
      const s = JSON.parse(JSON.stringify(schema)) as { properties: Record<string, { description?: string }> };
      delete s.properties['idempotency_key']!.description;
      return s;
    };
    assert.deepEqual(strip(webTool.inputSchema), strip(localTool.inputSchema));
  });
});
