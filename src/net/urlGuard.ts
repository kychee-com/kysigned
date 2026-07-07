/**
 * urlGuard — SSRF defense for server-side fetches (spec F-16.7 / AC-140).
 *
 * kysigned makes two outbound requests on a creator's behalf: fetching a
 * `pdf_url` document at create time, and delivering a signed `callback_url`
 * webhook (F-30.3). Both must be barred from reaching anything the network
 * trusts but the creator should not — loopback, link-local (incl. the
 * `169.254.169.254` cloud-metadata endpoint), and RFC-1918 private ranges.
 *
 * Two layers: a synchronous literal-host + https check (`validatePublicHttpsUrl`)
 * and an async resolved-IP check (`assertResolvesPublic`) so a *public* hostname
 * that resolves to a private address is also refused. The residual DNS-rebinding
 * window (the host re-resolving between this check and the fetch's own
 * resolution) is documented as accepted for v1 (spec F-16.7).
 */
import { lookup } from 'node:dns/promises';

/** Literal hostnames/IPs that must never be the target of a server-side fetch. */
const BLOCKED_HOSTNAME_RE = new RegExp(
  [
    '^localhost$',
    '^127\\.', // loopback v4
    '^\\[?::1\\]?$', // loopback v6
    '^10\\.', // RFC-1918
    '^192\\.168\\.', // RFC-1918
    '^172\\.(1[6-9]|2\\d|3[01])\\.', // RFC-1918 172.16–172.31
    '^169\\.254\\.', // link-local + cloud metadata
    '^0\\.', // "this network" / 0.0.0.0
  ].join('|'),
  'i',
);

export function isBlockedHostname(host: string): boolean {
  return BLOCKED_HOSTNAME_RE.test(host);
}

/** True for a resolved IP (v4 or v6) in a loopback/link-local/private/metadata range. */
export function isBlockedIp(ip: string): boolean {
  const s = ip.trim().toLowerCase();
  // IPv6
  if (s.includes(':')) {
    if (s === '::1') return true; // loopback
    if (s.startsWith('fe80')) return true; // link-local
    if (s.startsWith('fc') || s.startsWith('fd')) return true; // unique-local (ULA)
    // v4-mapped v6 (::ffff:10.0.0.1) — fall through to the v4 check on the tail
    const tail = s.split(':').pop() ?? '';
    if (/\d+\.\d+\.\d+\.\d+/.test(tail)) return isBlockedIp(tail);
    return false;
  }
  const oct = s.split('.').map(Number);
  if (oct.length !== 4 || oct.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → refuse
  const [a, b] = oct;
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 192 && b === 168) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  return false;
}

export type UrlVerdict = { ok: true } | { ok: false; reason: string };

/** Synchronous guard: parses, requires https, and blocks literal private hosts. */
export function validatePublicHttpsUrl(raw: string): UrlVerdict {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'is not a valid URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'must be https' };
  if (isBlockedHostname(u.hostname)) return { ok: false, reason: 'host is not reachable from the service' };
  return { ok: true };
}

/** Default DNS resolver — returns every address the host resolves to. */
async function defaultLookup(host: string): Promise<string[]> {
  const res = await lookup(host, { all: true });
  return res.map((r) => r.address);
}

/**
 * Resolve the host and throw if ANY address is private/blocked — closes the
 * "public hostname → internal IP" SSRF vector. Injectable for tests.
 */
export async function assertResolvesPublic(
  host: string,
  lookupImpl: (h: string) => Promise<string[]> = defaultLookup,
): Promise<void> {
  const ips = await lookupImpl(host);
  if (ips.length === 0) throw new Error('host does not resolve');
  for (const ip of ips) {
    if (isBlockedIp(ip)) throw new Error(`host resolves to a non-public address (${ip})`);
  }
}
