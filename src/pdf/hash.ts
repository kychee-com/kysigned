import { createHash } from 'node:crypto';
import { validatePublicHttpsUrl, assertResolvesPublic } from '../net/urlGuard.js';

export function computePdfHash(pdfBytes: Uint8Array): string {
  return createHash('sha256').update(pdfBytes).digest('hex');
}

/** A refused/failed `pdf_url` — the create handler maps this to a clean 400
 *  (`validation_pdf_url`), never a 500/stack trace or an echoed internal body. */
export class PdfUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfUrlError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
// Above the 15 MB document ceiling (F-3.5) but bounded so an unbounded body
// cannot exhaust the function before the size guard runs.
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export interface FetchPdfDeps {
  fetchImpl?: typeof fetch;
  /** DNS resolver (host → all addresses); injectable for tests. */
  lookup?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Fetch a creator-supplied `pdf_url` SERVER-SIDE, under the F-16.7 SSRF guard:
 * https-only; literal AND DNS-resolved host must be public; no host-changing
 * redirects (`redirect: 'error'`); time-bounded; size-capped. Every rejection
 * is a `PdfUrlError` so the caller returns a clean named 400.
 */
export async function fetchPdfFromUrl(url: string, deps: FetchPdfDeps = {}): Promise<Uint8Array> {
  const verdict = validatePublicHttpsUrl(url);
  if (!verdict.ok) throw new PdfUrlError(`pdf_url ${verdict.reason}`);

  const host = new URL(url).hostname;
  try {
    await assertResolvesPublic(host, deps.lookup);
  } catch {
    throw new PdfUrlError('pdf_url host is not reachable from the service');
  }

  const doFetch = deps.fetchImpl ?? fetch;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  let response: Response;
  try {
    response = await doFetch(url, {
      redirect: 'error', // a public URL must not bounce the fetch into an internal host
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    // redirect / network / timeout — never surface the internal reason to the caller.
    throw new PdfUrlError('pdf_url could not be fetched');
  }
  if (!response.ok) throw new PdfUrlError(`pdf_url fetch failed (${response.status})`);

  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PdfUrlError('pdf_url document exceeds the size limit');
  }
  return readBounded(response, maxBytes);
}

/** Read the body with a running byte cap — an undeclared oversize stream is
 *  aborted rather than buffered whole. */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.length > maxBytes) throw new PdfUrlError('pdf_url document exceeds the size limit');
    return buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new PdfUrlError('pdf_url document exceeds the size limit');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function decodePdfBase64(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}
