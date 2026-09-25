/**
 * The kysigned-agent function entry (82.6, F-46, DD-73): one routed function
 * for every agent URL. It dispatches /mcp, the discovery documents and the
 * negotiated pages, takes its origin from operator config or the request URL
 * (run402 hands routed functions the full public URL), and answers anything
 * else with a JSON 404.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import defaultHandler, { agentOrigin, handleAgentRequest } from './webFunction.js';

const ORIGIN = 'https://kysigned.test';

function staticHost(): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.endsWith('/_agent/pages/faq.md')) return new Response('---\ntitle: "FAQ"\nurl: /faq\n---\n\n# FAQ\n');
    if (url.endsWith('/_agent/pages/faq.html')) return new Response('<h1>FAQ</h1>', { headers: { 'Content-Type': 'text/html' } });
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

async function call(path: string, init: RequestInit = {}, host = staticHost()) {
  const res = await handleAgentRequest(new Request(`${ORIGIN}${path}`, init), { origin: ORIGIN, fetchFn: host.fetchFn, version: '9.9.9' });
  return { res, host };
}

describe('dispatch', () => {
  it('/mcp speaks MCP: an initialize POST answers JSON-RPC with the server info', async () => {
    const { res } = await call('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { serverInfo: { name: string; version: string } } };
    assert.equal(body.result.serverInfo.name, 'kysigned');
    assert.equal(body.result.serverInfo.version, '9.9.9');
  });

  it('GET /mcp is a 405 pointer, never the SPA', async () => {
    const { res } = await call('/mcp');
    assert.equal(res.status, 405);
    assert.match(await res.text(), /server-card/);
  });

  it('every discovery document and honest 404 is served here', async () => {
    const want: Array<[string, number, RegExp]> = [
      ['/mcp/server-card', 200, /^application\/json/],
      ['/.well-known/mcp/server-card.json', 200, /^application\/json/],
      ['/.well-known/agent-skills/index.json', 200, /^application\/json/],
      ['/.well-known/agent-skills/kysigned-send-for-signature/SKILL.md', 200, /^text\/markdown/],
      ['/.well-known/api-catalog', 200, /^application\/linkset\+json/],
      ['/auth.md', 200, /^text\/markdown/],
      ['/.well-known/oauth-authorization-server', 404, /^application\/json/],
      ['/.well-known/oauth-protected-resource', 404, /^application\/json/],
      ['/.well-known/openid-configuration', 404, /^application\/json/],
    ];
    for (const [path, status, type] of want) {
      const { res } = await call(path);
      assert.equal(res.status, status, path);
      assert.match(res.headers.get('content-type') ?? '', type, path);
    }
  });

  it('the negotiated pages are served from the staged copies', async () => {
    const { res, host } = await call('/faq', { headers: { Accept: 'text/markdown' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.deepEqual(host.calls, [`${ORIGIN}/_agent/pages/faq.md`]);
  });

  it('anything else is a JSON 404', async () => {
    for (const path of ['/', '/dashboard', '/nope', '/.well-known/security.txt']) {
      const { res } = await call(path);
      assert.equal(res.status, 404, path);
      assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
    }
  });

  it('an unexpected failure is a clean JSON 500 with no stack', async () => {
    const throwing = { fetchFn: (async () => { throw new Error('boom at /secret/path'); }) as unknown as typeof fetch, calls: [] as string[] };
    const { res } = await call('/faq', {}, throwing);
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.equal(JSON.parse(text).code, 'internal_error');
    assert.ok(!text.includes('/secret/path'));
  });

  it('the default export is the routed entry', () => {
    assert.equal(typeof defaultHandler, 'function');
  });
});

describe('agentOrigin', () => {
  const req = new Request('https://www.kysigned.test/mcp');
  it('prefers the operator config, then run402\'s public origin, then the request URL', () => {
    assert.equal(agentOrigin(req, { KYSIGNED_BASE_URL: 'https://kysigned.test/' }), 'https://kysigned.test');
    assert.equal(agentOrigin(req, { RUN402_PUBLIC_ORIGIN: 'https://fork.run402.test' }), 'https://fork.run402.test');
    assert.equal(agentOrigin(req, {}), 'https://www.kysigned.test');
    assert.equal(agentOrigin(req, { KYSIGNED_BASE_URL: '  ' }), 'https://www.kysigned.test');
  });

  it('documents carry the configured origin, never a hardcoded kysigned.com', async () => {
    const res = await handleAgentRequest(new Request('https://www.fork.test/mcp/server-card'), {
      origin: agentOrigin(new Request('https://www.fork.test/'), { RUN402_PUBLIC_ORIGIN: 'https://fork.test' }),
      fetchFn: staticHost().fetchFn,
      version: '1.0.0',
    });
    const card = (await res.json()) as { remotes: Array<{ url: string }>; name: string };
    assert.equal(card.remotes[0]!.url, 'https://fork.test/mcp');
    assert.equal(card.name, 'test.fork/kysigned');
  });
});
