/**
 * run402Http — routed-HTTP marshalling for the run402-function entry (14.5).
 *
 * run402 invokes a routed function with a `run402.routed_http.v1` request envelope
 * (method/path/headers/base64 body/context) and expects a base64 response envelope.
 * These helpers normalize the request into a convenient shape and build responses.
 * The types match the run402 contract structurally, so the deployed entry can pass
 * them straight through `@run402/functions` — and the marshalling stays pure +
 * unit-tested here, with no `@run402/functions` runtime dependency in the core lib.
 */
import { Buffer } from 'node:buffer';

export type RoutedHttpHeaderList = Array<[string, string]>;

export interface RoutedHttpRequestV1 {
  version: 'run402.routed_http.v1';
  method: string;
  url: string;
  path: string;
  rawPath: string;
  rawQuery: string;
  headers: RoutedHttpHeaderList;
  cookies: { raw: string | null };
  body: null | { encoding: 'base64'; data: string; size: number };
  context: {
    source: 'route';
    projectId: string;
    host: string;
    proto: 'https' | 'http';
    requestId?: string;
    clientIp?: string;
    userAgent?: string;
    [k: string]: unknown;
  };
}

export interface RoutedHttpResponseV1 {
  status: number;
  headers?: RoutedHttpHeaderList;
  cookies?: string[];
  body?: null | { encoding: 'base64'; data: string; size: number };
}

export interface NormalizedRequest {
  /** Upper-cased HTTP method. */
  method: string;
  path: string;
  query: URLSearchParams;
  /** Case-insensitive header access. */
  headers: Headers;
  /** Parsed Cookie header. */
  cookies: Record<string, string>;
  /** Decoded request body bytes, or null when there was no body. */
  bodyBytes: Uint8Array | null;
  host: string;
  projectId: string;
}

/** Normalize a routed-HTTP request envelope into a convenient, decoded shape. */
export function normalizeRoutedRequest(event: RoutedHttpRequestV1): NormalizedRequest {
  const headers = new Headers();
  for (const [k, v] of event.headers) headers.append(k, v);
  const bodyBytes = event.body ? new Uint8Array(Buffer.from(event.body.data, 'base64')) : null;
  return {
    method: event.method.toUpperCase(),
    path: event.path,
    query: new URLSearchParams(event.rawQuery),
    headers,
    cookies: parseCookies(event.cookies.raw),
    bodyBytes,
    host: event.context.host,
    projectId: event.context.projectId,
  };
}

/** The request body as a UTF-8 string ('' when absent). */
export function bodyText(req: NormalizedRequest): string {
  return req.bodyBytes ? new TextDecoder().decode(req.bodyBytes) : '';
}

/** The request body parsed as JSON, or null when absent / unparseable. */
export function bodyJson<T = unknown>(req: NormalizedRequest): T | null {
  const t = bodyText(req);
  if (!t) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

function parseCookies(raw: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export interface ResponseInit {
  headers?: RoutedHttpHeaderList;
  cookies?: string[];
}

function build(status: number, data: Uint8Array, contentType: string, init: ResponseInit): RoutedHttpResponseV1 {
  const buf = Buffer.from(data);
  const headers = withContentType(init.headers, contentType);
  const res: RoutedHttpResponseV1 = {
    status,
    headers,
    body: { encoding: 'base64', data: buf.toString('base64'), size: buf.byteLength },
  };
  if (init.cookies !== undefined) res.cookies = init.cookies;
  return res;
}

/** JSON response envelope. */
export function jsonResponse(status: number, value: unknown, init: ResponseInit = {}): RoutedHttpResponseV1 {
  return build(status, Buffer.from(JSON.stringify(value), 'utf8'), 'application/json; charset=utf-8', init);
}

/** Text/HTML response envelope (default text/plain). */
export function textResponse(
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
  init: ResponseInit = {},
): RoutedHttpResponseV1 {
  return build(status, Buffer.from(body, 'utf8'), contentType, init);
}

/** Binary response envelope (e.g. a PDF). */
export function bytesResponse(
  status: number,
  data: Uint8Array,
  contentType: string,
  init: ResponseInit = {},
): RoutedHttpResponseV1 {
  return build(status, data, contentType, init);
}

function withContentType(headers: RoutedHttpHeaderList | undefined, contentType: string): RoutedHttpHeaderList {
  const out = headers ? [...headers] : [];
  if (!out.some(([name]) => name.toLowerCase() === 'content-type')) {
    out.unshift(['content-type', contentType]);
  }
  return out;
}
