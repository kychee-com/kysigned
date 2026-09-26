/**
 * The web MCP endpoint (82.2, F-46.1): a stateless, unauthenticated MCP
 * server over streamable HTTP with three free tools and the paid create.
 * Every test drives the real handler through the MCP SDK client with no
 * network (webTestKit.connectClient).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpRequest, WEB_TOOL_NAMES, type WebMcpDeps } from './webServer.js';
import { cannotRunProgramsLine } from './webFacts.js';
import {
  ORIGIN,
  GOOD_TOKEN,
  connectClient,
  fakeApi,
  firstText,
  pricedRoute,
  trackingRead,
  unpricedRoute,
} from './webTestKit.js';

const DASHES = /[–—]/;

function deps(routes = [pricedRoute, trackingRead]): { deps: WebMcpDeps; calls: ReturnType<typeof fakeApi>['calls'] } {
  const api = fakeApi(routes);
  return { deps: { origin: ORIGIN, fetchFn: api.fetchFn, version: '9.9.9' }, calls: api.calls };
}

describe('the endpoint (AC-280)', () => {
  it('initialize answers with the service info and no Authorization header is needed', async () => {
    const { deps: d } = deps();
    const client = await connectClient((req) => handleMcpRequest(req, d));
    const info = client.getServerVersion();
    assert.equal(info?.name, 'kysigned');
    assert.equal(info?.version, '9.9.9');
    await client.close();
  });

  it('tools/list is exactly the four web tools, free ones read-only, the paid one declaring its spend', async () => {
    const { deps: d } = deps();
    const client = await connectClient((req) => handleMcpRequest(req, d));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...WEB_TOOL_NAMES].sort());
    assert.deepEqual(
      [...WEB_TOOL_NAMES].sort(),
      ['check_envelope_status', 'check_price', 'create_envelope_x402', 'explain_kysigned'],
    );
    for (const name of ['explain_kysigned', 'check_price', 'check_envelope_status']) {
      const t = tools.find((x) => x.name === name)!;
      assert.equal(t.annotations?.readOnlyHint, true, `${name} is read-only`);
    }
    const paid = tools.find((t) => t.name === 'create_envelope_x402')!;
    assert.equal(paid.annotations?.readOnlyHint, false);
    assert.equal(paid.annotations?.destructiveHint, true, 'paying real funds is irreversible: hosts can gate it');
    assert.match(paid.description ?? '', /spends real funds/i);
    assert.match(paid.description ?? '', /check_price/);
    await client.close();
  });

  it('a creator key on the request changes nothing: it is never read, forwarded or honored', async () => {
    const { deps: d, calls } = deps();
    const client = await connectClient((req) => handleMcpRequest(req, d), {
      headers: { Authorization: 'Bearer ksk_should_never_travel' },
    });
    const { tools } = await client.listTools();
    assert.equal(tools.length, 4);
    await client.callTool({ name: 'check_price', arguments: {} });
    await client.callTool({ name: 'check_envelope_status', arguments: { envelope_id: 'env_1', tracking_token: GOOD_TOKEN } });
    assert.ok(calls.length >= 2);
    for (const c of calls) {
      assert.ok(!JSON.stringify(c.headers).includes('ksk_should_never_travel'), `the key leaked into ${c.method} ${c.url}`);
    }
    await client.close();
  });

  it('GET and DELETE answer 405 with a plain-text pointer to the server card; OPTIONS answers CORS', async () => {
    const { deps: d } = deps();
    for (const method of ['GET', 'DELETE']) {
      const res = await handleMcpRequest(new Request(`${ORIGIN}/mcp`, { method }), d);
      assert.equal(res.status, 405);
      assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
      assert.match(await res.text(), /\/\.well-known\/mcp\/server-card\.json/);
    }
    const pre = await handleMcpRequest(new Request(`${ORIGIN}/mcp`, { method: 'OPTIONS' }), d);
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.equal(pre.headers.get('access-control-allow-credentials'), null, 'no credentials: the endpoint is unauthenticated');
  });
});

describe('explain_kysigned (AC-281, AC-287)', () => {
  it('explains the product, every way to pay and track, and local verification only', async () => {
    const { deps: d, calls } = deps();
    const client = await connectClient((req) => handleMcpRequest(req, d));
    const text = firstText(await client.callTool({ name: 'explain_kysigned', arguments: {} }));
    for (const needle of [
      'I sign this document', // how signing by forwarding works
      'check_price', // the price is read live
      'create_envelope_x402', // pay here, inside the tool call
      'kysigned-mcp', // the local server's wallet tool and key tool
      '/v1/x402/envelope', // the HTTP x402 route
      '/account/api-keys', // where a person mints a key
      'ktt_', // the tracking token
      'check_envelope_status',
      `${ORIGIN}/verify`, // the browser check runs on the holder's device
      `${ORIGIN}/auth.md`,
    ]) {
      assert.ok(text.includes(needle), `explanation names ${needle}`);
    }
    assert.match(text, /never upload/i, 'verification stays on the holder\'s machine');
    assert.ok(!DASHES.test(text), 'no em or en dash in outbound copy');
    assert.equal(calls.length, 0, 'the explanation needs no network call');
    await client.close();
  });

  it('names the programmatic verifiers first, then the page, and what an agent that cannot run programs does (AC-302)', async () => {
    const { deps: d } = deps();
    const client = await connectClient((req) => handleMcpRequest(req, d));
    const text = firstText(await client.callTool({ name: 'explain_kysigned', arguments: {} }));
    const section = text.slice(text.indexOf('Verifying a bundle'));
    for (const needle of ['npx kysigned verify', 'verify_bundle', 'npx -y kysigned-mcp', '--json']) {
      assert.ok(section.includes(needle), `the verification section names ${needle}`);
    }
    assert.ok(section.indexOf('npx kysigned verify') < section.indexOf(`${ORIGIN}/verify`), 'the command comes before the page');
    assert.ok(text.includes(cannotRunProgramsLine(ORIGIN)), 'the line for an agent that cannot run programs');
    assert.doesNotMatch(section, /bin\/verify-bundle\.mjs/, 'no clone-and-run path once the package ships');
    await client.close();
  });
});

describe('check_price (AC-282)', () => {
  it('reports the terms of the priced route\'s own challenge', async () => {
    const { deps: d, calls } = deps();
    const client = await connectClient((req) => handleMcpRequest(req, d));
    const r = await client.callTool({ name: 'check_price', arguments: {} });
    assert.notEqual(r.isError, true);
    const price = JSON.parse(firstText(r));
    assert.equal(price.amount_atomic, '250000');
    assert.equal(price.amount_usd, '0.25');
    assert.equal(price.network, 'eip155:8453');
    assert.equal(price.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    assert.equal(price.asset_name, 'USD Coin');
    assert.equal(price.pay_to, '0x8d671cd12ecf69e0b049a6b55c5b318097b4bc35');
    assert.equal(price.route, `${ORIGIN}/v1/x402/envelope`);
    const probe = calls.find((c) => c.url === `${ORIGIN}/v1/x402/envelope`)!;
    assert.equal(probe.method, 'POST');
    assert.equal(probe.headers['payment-signature'], undefined, 'the probe never pays');
    await client.close();
  });

  it('an instance with no priced route answers a machine-readable not-enabled result', async () => {
    const { deps: d } = deps([unpricedRoute]);
    const client = await connectClient((req) => handleMcpRequest(req, d));
    const r = await client.callTool({ name: 'check_price', arguments: {} });
    assert.equal(r.isError, true);
    const body = JSON.parse(firstText(r).replace(/^Error: /, ''));
    assert.equal(body.code, 'x402_not_enabled');
    await client.close();
  });
});

describe('check_envelope_status (AC-283)', () => {
  it('a valid tracking token reads its envelope, sent as the Authorization header', async () => {
    const { deps: d, calls } = deps();
    const client = await connectClient((req) => handleMcpRequest(req, d));
    const r = await client.callTool({ name: 'check_envelope_status', arguments: { envelope_id: 'env_1', tracking_token: GOOD_TOKEN } });
    assert.notEqual(r.isError, true);
    const env = JSON.parse(firstText(r));
    assert.equal(env.id, 'env_1');
    assert.equal(env.signers[0].delivery_status, 'delivered');
    const read = calls.find((c) => c.url === `${ORIGIN}/v1/envelope/env_1`)!;
    assert.equal(read.headers['authorization'], GOOD_TOKEN);
    await client.close();
  });

  it('another envelope\'s id gets the stranger\'s not-found', async () => {
    const { deps: d } = deps();
    const client = await connectClient((req) => handleMcpRequest(req, d));
    const r = await client.callTool({ name: 'check_envelope_status', arguments: { envelope_id: 'env_other', tracking_token: GOOD_TOKEN } });
    assert.equal(r.isError, true);
    assert.match(firstText(r), /404/);
    assert.match(firstText(r), /not_found/);
    await client.close();
  });

  it('without a token the call fails naming tracking_token, with no network call', async () => {
    const { deps: d, calls } = deps();
    const client = await connectClient((req) => handleMcpRequest(req, d));
    const r = await client.callTool({ name: 'check_envelope_status', arguments: { envelope_id: 'env_1' } });
    assert.equal(r.isError, true);
    assert.match(firstText(r), /tracking_token/);
    assert.equal(calls.length, 0);
    await client.close();
  });

  it('a creator API key in the token\'s place is refused locally and never sent', async () => {
    const { deps: d, calls } = deps();
    const client = await connectClient((req) => handleMcpRequest(req, d));
    const r = await client.callTool({ name: 'check_envelope_status', arguments: { envelope_id: 'env_1', tracking_token: 'ksk_creator_key' } });
    assert.equal(r.isError, true);
    const body = JSON.parse(firstText(r).replace(/^Error: /, ''));
    assert.equal(body.code, 'api_key_not_accepted');
    assert.equal(calls.length, 0, 'the key never left the endpoint');
    await client.close();
  });
});
