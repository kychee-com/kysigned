/**
 * http helper tests — the centralized outbound-request layer.
 * Covers issues #119 (isError + preserved code), #120 (non-JSON / network),
 * #123 (endpoint normalization).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEndpoint, apiUrl, apiRequest } from './http.js';

function stubFetch(responses: Array<Response | Error>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fn = (async (url: RequestInfo | URL) => {
    calls.push(String(url));
    const next = responses[i++] ?? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetch: fn, calls };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('#123 — endpoint normalization', () => {
  it('strips trailing slashes and defaults when empty', () => {
    assert.equal(normalizeEndpoint('https://x.test/'), 'https://x.test');
    assert.equal(normalizeEndpoint('https://x.test///'), 'https://x.test');
    assert.equal(normalizeEndpoint('  https://x.test  '), 'https://x.test');
    assert.equal(normalizeEndpoint(undefined), 'https://kysigned.com');
    assert.equal(normalizeEndpoint(''), 'https://kysigned.com');
  });
  it('joins without a double slash and preserves an intentional path prefix', () => {
    assert.equal(apiUrl('https://x.test', '/v1/envelopes'), 'https://x.test/v1/envelopes');
    assert.equal(apiUrl('https://x.test/', '/v1/envelopes'), 'https://x.test/v1/envelopes');
    assert.equal(apiUrl('https://x.test/prefix', '/v1/envelopes'), 'https://x.test/prefix/v1/envelopes');
  });
  it('a trailing-slash endpoint does not produce GET //v1/... ', async () => {
    const { fetch, calls } = stubFetch([json(200, { ok: true })]);
    await apiRequest(normalizeEndpoint('https://x.test/'), '/v1/envelopes', {}, fetch);
    assert.equal(calls[0], 'https://x.test/v1/envelopes');
    assert.ok(!calls[0]!.includes('//v1'), 'no double slash');
  });
});

describe('#119 — API errors become coded isError results', () => {
  it('a JSON error preserves status + stable code + message, isError true', async () => {
    const { fetch } = stubFetch([json(401, { code: 'auth_invalid_key', error: 'Invalid or missing API key' })]);
    const out = await apiRequest('https://x.test', '/v1/envelopes', {}, fetch);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.result.isError, true);
    const text = out.result.content[0]!.text;
    assert.match(text, /401/);
    assert.match(text, /auth_invalid_key/);
    assert.match(text, /Invalid or missing API key/);
  });
  it('a JSON error without a code still surfaces status + message as isError', async () => {
    const { fetch } = stubFetch([json(500, { error: 'boom' })]);
    const out = await apiRequest('https://x.test', '/v1/envelopes', {}, fetch);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.result.isError, true);
    assert.match(out.result.content[0]!.text, /500/);
    assert.match(out.result.content[0]!.text, /boom/);
  });
});

describe('#120 — non-JSON and network failures', () => {
  it('an HTML error body does not crash JSON parsing; surfaces bounded text as isError', async () => {
    const { fetch } = stubFetch([
      new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } }),
    ]);
    const out = await apiRequest('https://x.test', '/v1/envelopes', {}, fetch);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.result.isError, true);
    assert.match(out.result.content[0]!.text, /502/);
    assert.match(out.result.content[0]!.text, /Bad Gateway/);
  });
  it('an empty error body still yields a coded isError (no crash)', async () => {
    const { fetch } = stubFetch([new Response('', { status: 503 })]);
    const out = await apiRequest('https://x.test', '/v1/envelopes', {}, fetch);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.result.isError, true);
    assert.match(out.result.content[0]!.text, /503/);
  });
  it('a network failure surfaces the endpoint + cause code as isError', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const { fetch } = stubFetch([refused]);
    const out = await apiRequest('https://down.test', '/v1/envelopes', {}, fetch);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.result.isError, true);
    assert.match(out.result.content[0]!.text, /down\.test/);
    assert.match(out.result.content[0]!.text, /ECONNREFUSED/);
  });
  it('a large successful JSON body is returned whole (not truncated)', async () => {
    const big = { envelopes: Array.from({ length: 50 }, (_, i) => ({ id: `env-${i}`, status: 'active' })) };
    const { fetch } = stubFetch([json(200, big)]);
    const out = await apiRequest('https://x.test', '/v1/envelopes', {}, fetch);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal((out.data.envelopes as unknown[]).length, 50);
  });
});
