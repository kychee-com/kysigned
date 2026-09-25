/**
 * webTestKit — shared fixtures for the web front door's tests (F-46): a fake
 * kysigned API behind a recording fetch, and an MCP SDK client wired to the
 * web handler through the client transport's custom `fetch`, so every test
 * runs with no network. Test-only: nothing in the production modules imports it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const ORIGIN = 'https://kysigned.test';

// The verbatim live-gateway challenge (the same bytes wallet.test.ts pins),
// with the resource URL as the live route reports it.
export const CAPTURED_PAYMENT_REQUIRED =
  'eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9reXNpZ25lZC5jb20vdjEveDQwMi9lbnZlbG9wZSIsImRlc2NyaXB0aW9uIjoiVGVuYW50IHByaWNlZCByb3V0ZWQgZnVuY3Rpb24gcmVxdWVzdCIsIm1pbWVUeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LCJhY2NlcHRzIjpbeyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MyIsImFtb3VudCI6IjI1MDAwMCIsImFzc2V0IjoiMHg4MzM1ODlmQ0Q2ZURiNkUwOGY0YzdDMzJENGY3MWI1NGJkQTAyOTEzIiwicGF5VG8iOiIweDhkNjcxY2QxMmVjZjY5ZTBiMDQ5YTZiNTVjNWIzMTgwOTdiNGJjMzUiLCJtYXhUaW1lb3V0U2Vjb25kcyI6MzAwLCJleHRyYSI6eyJuYW1lIjoiVVNEIENvaW4iLCJ2ZXJzaW9uIjoiMiIsInJ1bjQwMl9wYXltZW50X2tpbmQiOiJ0ZW5hbnRfcm91dGUiLCJyb3V0ZV9wcmljaW5nX25ldHdvcmsiOiJtYWlubmV0IiwiYW1vdW50X3VzZF9taWNyb3MiOjI1MDAwMCwicGF5X3RvIjoib3JnX2RlZmF1bHRfcGF5b3V0In19XX0=';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type FakeRoute = (call: RecordedCall) => Response | Promise<Response> | undefined;

/** A recording fetch over a list of fake routes; an unmatched call is a 599 the test will see. */
export function fakeApi(routes: FakeRoute[]): { fetchFn: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
    const call: RecordedCall = { url: req.url, method: req.method, headers, body };
    calls.push(call);
    for (const route of routes) {
      const res = await route(call);
      if (res) return res;
    }
    return new Response(`no fake route for ${req.method} ${req.url}`, { status: 599 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** The priced route's unpaid challenge, as the gateway answers it. */
export const pricedRoute: FakeRoute = (c) =>
  c.method === 'POST' && c.url === `${ORIGIN}/v1/x402/envelope` && !c.headers['payment-signature']
    ? new Response('{"code":"PAYMENT_REQUIRED"}', {
        status: 402,
        headers: { 'Content-Type': 'application/json', 'Payment-Required': CAPTURED_PAYMENT_REQUIRED },
      })
    : undefined;

/** An instance with no priced route: the path falls to the API, which answers not-enabled. */
export const unpricedRoute: FakeRoute = (c) =>
  c.method === 'POST' && c.url === `${ORIGIN}/v1/x402/envelope`
    ? jsonResponse({ error: 'x402 is not enabled', code: 'payment_x402_not_enabled' }, 404)
    : undefined;

export const GOOD_TOKEN = 'ktt_good_token_for_envelope_env_1';

/** GET /v1/envelope/:id as the API answers a tracking token (src/functions/api.ts:365-381). */
export const trackingRead: FakeRoute = (c) => {
  const m = /^https:\/\/kysigned\.test\/v1\/envelope\/([^/]+)$/.exec(c.url);
  if (c.method !== 'GET' || !m) return undefined;
  if (c.headers['authorization'] !== GOOD_TOKEN) {
    return jsonResponse({ error: 'Authentication required', code: 'auth_invalid_key' }, 401);
  }
  if (m[1] !== 'env_1') return jsonResponse({ error: 'Not found', code: 'not_found' }, 404);
  return jsonResponse({
    id: 'env_1',
    status: 'active',
    signers: [{ email: 'signer@example.com', status: 'pending', delivery_status: 'delivered', last_rejection: null }],
  });
};

/** Connect an MCP SDK client to a web handler, entirely in-process. */
export async function connectClient(
  handler: (req: Request) => Promise<Response>,
  opts: { headers?: Record<string, string>; client?: Client } = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    fetch: (async (url: string | URL, init?: RequestInit) => handler(new Request(String(url), init))) as typeof fetch,
    requestInit: opts.headers ? { headers: opts.headers } : undefined,
  });
  const client = opts.client ?? new Client({ name: 'kysigned-web-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

export function firstText(result: { content?: unknown }): string {
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === 'text')?.text ?? '';
}
