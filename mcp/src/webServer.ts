/**
 * webServer — the web MCP endpoint (F-46.1, DD-73): MCP over streamable HTTP
 * at `<origin>/mcp`, stateless and unauthenticated. Each request gets a fresh
 * server and transport (nothing to keep between requests, as a routed
 * function needs), with exactly four tools: three free, read-only ones and
 * the x402-paid create (webPay.ts).
 *
 * The endpoint takes no creator credentials of any kind: no tool reads the
 * incoming request's headers, and check_envelope_status accepts only a
 * tracking token. It reaches kysigned the way any agent does, over the
 * instance's own public origin, so it can do nothing an outside agent cannot.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { apiRequest, textResult, type McpToolResult } from './http.js';
import { fetchChallenge, X402RouteError, X402_CREATE_PATH } from './x402Challenge.js';
import { WEB_FACTS, explainKysigned } from './webFacts.js';
import { registerPaidTool, x402NotEnabled } from './webPay.js';

export interface WebMcpDeps {
  /** The instance's public origin, e.g. https://kysigned.com (no trailing slash). */
  origin: string;
  /** Every outbound call goes through this (the tests inject a fake API). */
  fetchFn: typeof fetch;
  /** Reported as the server version (inlined at bundle time). */
  version: string;
}

export const WEB_TOOL_NAMES = ['explain_kysigned', 'check_price', 'check_envelope_status', 'create_envelope_x402'] as const;

/** Unauthenticated endpoint: any origin may call it, and no credentials are ever involved. */
export const CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

const INSTRUCTIONS =
  'kysigned: e-signatures where the signature is an email. Start with explain_kysigned. check_price reads the live ' +
  'per-envelope price; create_envelope_x402 pays for an envelope from your own wallet over x402; check_envelope_status ' +
  'polls one envelope with the tracking token a create returns. Verifying the resulting evidence bundle happens on your ' +
  'own machine, never here.';

function errorJson(body: Record<string, unknown>): McpToolResult {
  return textResult(`Error: ${JSON.stringify(body, null, 2)}`, true);
}

export function buildWebMcpServer(deps: WebMcpDeps): McpServer {
  const { origin, fetchFn } = deps;
  const server = new McpServer({ name: 'kysigned', version: deps.version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'explain_kysigned',
    {
      description:
        'Explain kysigned: how signing by forwarding an email works, the price, every way to create and pay for an envelope, how to track it, and how to verify the evidence bundle on your own machine. Free, no network call.',
      inputSchema: {},
      annotations: { title: 'Explain kysigned', readOnlyHint: true, openWorldHint: false },
    },
    async () => textResult(explainKysigned(origin)),
  );

  server.registerTool(
    'check_price',
    {
      description:
        "This instance's live per-envelope price, read from the x402 create route's own unpaid challenge: amount, asset, network and payee. Free; never pays or creates anything.",
      inputSchema: {},
      annotations: { title: 'Check price', readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const { paymentRequired, terms } = await fetchChallenge(origin, fetchFn);
        const accept = paymentRequired.accepts.find((a) => a.scheme === 'exact') ?? paymentRequired.accepts[0];
        return textResult(
          JSON.stringify(
            {
              route: `${origin}${X402_CREATE_PATH}`,
              scheme: accept?.scheme,
              network: terms.network,
              asset: terms.asset,
              asset_name: terms.assetName,
              amount_atomic: terms.amountAtomic,
              amount_usd: terms.amountUsdMicros !== undefined ? (terms.amountUsdMicros / 1_000_000).toFixed(2) : undefined,
              pay_to: terms.payTo,
              max_timeout_seconds: accept?.maxTimeoutSeconds,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        if (err instanceof X402RouteError && err.kind === 'not_priced') return x402NotEnabled(origin, err.message);
        return errorJson({ code: 'price_unavailable', message: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  server.registerTool(
    'check_envelope_status',
    {
      description:
        "Check one envelope with its tracking token (ktt_..., returned by every create): the envelope's status and every signer's signing and delivery status, plus last_rejection when a signer's latest forward was rejected. No account or API key: the token reads exactly its own envelope and nothing else. This endpoint accepts no creator API keys.",
      inputSchema: {
        envelope_id: z.string().min(1).describe('The envelope ID to check'),
        tracking_token: z
          .string()
          .min(1)
          .describe('The envelope-scoped read-only tracking token (ktt_...) from the create result.'),
      },
      annotations: { title: 'Check envelope status', readOnlyHint: true, openWorldHint: true },
    },
    async ({ envelope_id, tracking_token }) => {
      const token = tracking_token.trim();
      if (token.startsWith(WEB_FACTS.apiKeyPrefix)) {
        return errorJson({
          code: 'api_key_not_accepted',
          message:
            `This web endpoint accepts no creator API keys (${WEB_FACTS.apiKeyPrefix}...). Pass the envelope's tracking token ` +
            `(${WEB_FACTS.trackingTokenPrefix}...) from its create result, or use your key with the local ${WEB_FACTS.localPackage} server.`,
        });
      }
      if (!token.startsWith(WEB_FACTS.trackingTokenPrefix)) {
        return errorJson({
          code: 'tracking_token_required',
          message: `tracking_token must be the envelope's tracking token (${WEB_FACTS.trackingTokenPrefix}...) from its create result.`,
        });
      }
      const r = await apiRequest(origin, `/v1/envelope/${encodeURIComponent(envelope_id)}`, { auth: token }, fetchFn);
      if (!r.ok) return r.result;
      return textResult(JSON.stringify(r.data, null, 2));
    },
  );

  registerPaidTool(server, { origin, fetchFn });
  return server;
}

function withHeaders(status: number, body: ArrayBuffer | string | null, base: Headers, extra: Readonly<Record<string, string>>): Response {
  const headers = new Headers(base);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(body, { status, headers });
}

/** The `/mcp` handler: POST carries JSON-RPC; GET/DELETE have nothing to offer a stateless server. */
export async function handleMcpRequest(req: Request, deps: WebMcpDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return withHeaders(204, null, new Headers(), CORS_HEADERS);
  if (req.method !== 'POST') {
    return withHeaders(
      405,
      `This is kysigned's MCP endpoint (streamable HTTP, stateless): send JSON-RPC requests with POST. ` +
        `Server card: ${deps.origin}/.well-known/mcp/server-card.json\n`,
      new Headers({ 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST, OPTIONS' }),
      CORS_HEADERS,
    );
  }
  const server = buildWebMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    // Read the whole body before closing, so nothing is cut off when the
    // per-request server and transport shut down.
    const body = await res.arrayBuffer();
    return withHeaders(res.status, body.byteLength > 0 ? body : null, res.headers, CORS_HEADERS);
  } finally {
    await server.close();
  }
}
