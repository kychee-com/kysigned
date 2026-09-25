/**
 * webFunction — the `kysigned-agent` routed function (F-46, DD-73): one entry
 * for every agent URL, a Web `Request` -> `Response` handler like the API's.
 *
 *   /mcp                          the web MCP endpoint (webServer.ts)
 *   /mcp/server-card, /.well-known/..., /auth.md   discovery documents (webDocuments.ts)
 *   the negotiated content pages  HTML or markdown (webPages.ts)
 *   anything else                 a JSON 404
 *
 * It holds no database access, no service key and no secret: every call it
 * makes goes to the instance's own public origin, like any agent's would.
 * The origin comes from operator config (KYSIGNED_BASE_URL, else run402's
 * RUN402_PUBLIC_ORIGIN) or, failing both, the request URL, which run402
 * hands routed functions in full. It never falls back to kysigned.com.
 */
import { handleMcpRequest } from './webServer.js';
import { handleDocumentRequest } from './webDocuments.js';
import { matchPagePath, servePage } from './webPages.js';
import { VERSION } from './version.js';

// Inlined by the deploy's esbuild `define` (version.ts reads package.json at
// run time, which a bundle does not ship).
declare const __KYSIGNED_MCP_VERSION__: string | undefined;

export interface AgentDeps {
  /** The instance's public origin; defaults to the request URL's origin. */
  origin?: string;
  fetchFn: typeof fetch;
  version: string;
}

export function agentOrigin(req: Request, env: Record<string, string | undefined>): string {
  for (const key of ['KYSIGNED_BASE_URL', 'RUN402_PUBLIC_ORIGIN']) {
    const value = (env[key] ?? '').trim().replace(/\/+$/, '');
    if (value) return value;
  }
  return new URL(req.url).origin;
}

function jsonError(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function handleAgentRequest(req: Request, deps: AgentDeps): Promise<Response> {
  const origin = deps.origin ?? new URL(req.url).origin;
  try {
    const path = new URL(req.url).pathname;
    if (path === '/mcp') return await handleMcpRequest(req, { origin, fetchFn: deps.fetchFn, version: deps.version });
    const doc = handleDocumentRequest(req, { origin, version: deps.version });
    if (doc) return doc;
    const page = matchPagePath(path);
    if (page) return await servePage(req, page, { origin, fetchFn: deps.fetchFn });
    return jsonError(404, 'not_found', 'Not found');
  } catch (err) {
    console.error('kysigned-agent: unhandled error', err instanceof Error ? err.message : String(err));
    return jsonError(500, 'internal_error', 'Internal error');
  }
}

export default async function (req: Request): Promise<Response> {
  const version = typeof __KYSIGNED_MCP_VERSION__ === 'string' ? __KYSIGNED_MCP_VERSION__ : VERSION;
  return handleAgentRequest(req, { origin: agentOrigin(req, process.env), fetchFn: globalThis.fetch, version });
}
