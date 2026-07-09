/**
 * http — the single outbound-request layer for every kysigned-mcp tool.
 *
 * Centralizes the behavior that used to be copy-pasted per tool (and was the
 * root of several MCP-host bugs): endpoint normalization (#123), res.ok
 * checking with a stable-code-preserving error (#119), JSON-only parsing with
 * a bounded-text fallback for HTML/empty error bodies (#120), and network-
 * failure diagnostics that name the endpoint + cause code (#120). Tool
 * failures become MCP results with `isError: true` so hosts branch correctly.
 */
export const DEFAULT_ENDPOINT = 'https://kysigned.com';

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [k: string]: unknown;
}

/** A plain text tool result; pass `isError` for a failure the host must branch on. */
export function textResult(text: string, isError = false): McpToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

/** Normalize the configured base endpoint ONCE: trim, strip trailing slashes, default. */
export function normalizeEndpoint(raw: string | undefined): string {
  const base = (raw ?? '').trim() || DEFAULT_ENDPOINT;
  return base.replace(/\/+$/, '');
}

/**
 * Join base + an absolute API path without a double slash, preserving an
 * intentional path prefix on the base (a self-hosted deployment behind
 * `/prefix`). `new URL(path, base)` is deliberately NOT used — an absolute
 * path would discard the base's prefix.
 */
export function apiUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

/** Unwrap a fetch failure to a diagnosable cause code (ECONNREFUSED, ENOTFOUND, …). */
function causeCode(err: unknown): string {
  const cause = (err as { cause?: unknown })?.cause;
  const fromCause =
    (cause as { code?: string; errno?: string } | undefined)?.code ??
    (cause as { errno?: string } | undefined)?.errno;
  if (fromCause) return String(fromCause);
  return err instanceof Error && err.message ? err.message : 'unknown error';
}

export type ApiOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; result: McpToolResult };

/**
 * Perform one API request and normalize the outcome. Success → `{ ok, data }`
 * (the full parsed JSON, never truncated). Any non-2xx or transport failure →
 * `{ ok:false, result }` where `result` is a ready-to-return isError tool
 * result carrying `[<status>] <code>: <message>` (or the endpoint + cause on a
 * network failure). `fetchImpl` is injectable for tests.
 */
export async function apiRequest(
  base: string,
  path: string,
  opts: { method?: string; auth?: string | undefined; body?: unknown } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<ApiOutcome> {
  const url = apiUrl(base, path);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.auth) headers['Authorization'] = opts.auth;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: opts.method ?? 'GET',
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch (err) {
    return { ok: false, result: textResult(`Error: cannot reach ${base} (${causeCode(err)})`, true) };
  }

  const looksJson = (res.headers.get('content-type') ?? '').toLowerCase().includes('json');
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    raw = '';
  }
  let data: Record<string, unknown> | undefined;
  if (looksJson && raw.trim()) {
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* malformed JSON despite the header — fall back to raw text below */
    }
  }

  if (!res.ok) {
    const code = typeof data?.['code'] === 'string' ? (data['code'] as string) : undefined;
    const jsonMsg =
      (typeof data?.['error'] === 'string' && (data['error'] as string)) ||
      (typeof data?.['message'] === 'string' && (data['message'] as string)) ||
      '';
    const msg = jsonMsg || raw.trim().slice(0, 500) || res.statusText || 'request failed';
    const text = `Error: [${res.status}]${code ? ` ${code}` : ''}: ${msg}`;
    return { ok: false, result: textResult(text, true) };
  }

  return { ok: true, data: data ?? {} };
}
