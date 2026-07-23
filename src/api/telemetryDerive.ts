/**
 * telemetryDerive — F-38.5 (spec 0.59.0, DD-50.3/50.4): traffic-source bucket +
 * country, derived server-side then DISCARDED.
 *
 * The collection beacon's own `Referer` is our page, so the browser hands the
 * server the landing referrer and the click-id yes/no fact as derivation
 * riders; these pure functions turn them into the coarse stored values and the
 * caller throws the riders away — no referrer URL and no click-id value ever
 * reach a stored row (F-38.1).
 *
 * Country comes from what the serving platform stamps on the request. run402
 * mints ONE canonical header, `x-run402-country`, on BOTH ingress paths
 * (run402-private#609): custom domains from the edge Worker's authoritative
 * `request.cf.country`, managed `*.run402.com` subdomains from CloudFront's
 * viewer country. `cf-ipcountry` remains as run402's documented compat alias on
 * the custom-domain path, and stays trustworthy there because the Worker scrubs
 * any client-supplied copy before stamping its own (#608).
 *
 * The raw `cloudfront-viewer-country` is deliberately NOT read: the gateway
 * blocklists it and translates it to the canonical header, so a copy arriving
 * here could only have been supplied by the caller. Anything else — including
 * Cloudflare's XX/T1 sentinels — is the explicit 'unknown', never a guess
 * (AC-218).
 */

export type TelemetrySourceBucket = 'paid' | 'organic' | 'referral' | 'direct' | 'unknown';

/** Hosts whose referrals count as organic search. Suffix-matched per label. */
const SEARCH_ENGINE_HOSTS = [
  'google.com',
  'bing.com',
  'duckduckgo.com',
  'yahoo.com',
  'ecosia.org',
  'startpage.com',
  'brave.com',
  'search.brave.com',
  'yandex.com',
  'baidu.com',
];

function refHost(referrer: string): string | null {
  try {
    return new URL(referrer).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostMatches(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

/**
 * Bucket one page-load's traffic source. Precedence: an ad click id present →
 * paid; own-host referrer or none → direct; search engine → organic; anything
 * else → referral. Never throws — a malformed referrer is treated as absent.
 */
export function deriveSourceBucket(input: {
  referrer: string | null;
  gclidPresent: boolean;
  ownHost: string;
}): TelemetrySourceBucket {
  if (input.gclidPresent) return 'paid';
  const raw = (input.referrer ?? '').trim();
  if (raw === '') return 'direct';
  const host = refHost(raw);
  if (host === null) return 'direct';
  const own = input.ownHost.toLowerCase();
  if (own !== '' && hostMatches(host, own)) return 'direct';
  if (SEARCH_ENGINE_HOSTS.some((s) => hostMatches(host, s))) return 'organic';
  return 'referral';
}

/**
 * The visitor's country as the serving platform provides it for THIS request,
 * or the explicit 'unknown'. The canonical platform header wins; the vendor
 * alias is the fallback for a deployment whose edge predates it. Only a clean
 * ISO 3166-1 alpha-2 shape passes; Cloudflare's XX (unknown) and T1 (Tor)
 * sentinels normalize to 'unknown'.
 */
export function deriveCountry(headers: Headers): string {
  const raw = headers.get('x-run402-country') ?? headers.get('cf-ipcountry') ?? '';
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return 'unknown';
  if (code === 'XX' || code === 'T1') return 'unknown';
  return code;
}
