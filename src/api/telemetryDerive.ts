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
 * Country comes from what the serving platform stamps on the request:
 * kysigned.com rides the Cloudflare custom-domain edge (`cf-ipcountry`, when
 * the zone's IP-geolocation flag is on); managed run402 subdomains would carry
 * `cloudfront-viewer-country`. Anything else — including Cloudflare's XX/T1
 * sentinels — is the explicit 'unknown', never a guess (AC-218).
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
 * or the explicit 'unknown'. Only a clean ISO 3166-1 alpha-2 shape passes;
 * Cloudflare's XX (unknown) and T1 (Tor) sentinels normalize to 'unknown'.
 */
export function deriveCountry(headers: Headers): string {
  const raw = headers.get('cf-ipcountry') ?? headers.get('cloudfront-viewer-country') ?? '';
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return 'unknown';
  if (code === 'XX' || code === 'T1') return 'unknown';
  return code;
}
