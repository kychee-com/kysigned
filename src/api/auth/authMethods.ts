/**
 * authMethods — F-41.1/F-41.7 provider discovery (AC-244, AC-253).
 *
 * `GET /v1/auth/methods` tells the SPA which sign-in methods the PLATFORM
 * offers this project — today just `{google: boolean}` — by proxying run402's
 * `GET /auth/v1/providers` (`oauth[].provider === "google"` + `enabled`). The
 * anon key stays server-side (the F-18.1 posture), and every failure mode reads
 * `{google: false}`: the gate then renders the email-only form, whole and
 * working, which is exactly the fork posture when the platform has Google off.
 *
 * The platform answer is cached per warm container for a short TTL so a gate
 * render never fans out an upstream call per visitor; an OUTAGE answer is NOT
 * cached (a one-request blip must not hide the button for the whole TTL).
 */
import type { SessionConfig } from './session.js';

export const METHODS_CACHE_TTL_MS = 5 * 60 * 1000;

export interface AuthMethods {
  google: boolean;
}

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ status: number; ok?: boolean; json: () => Promise<unknown> }>;

export interface MethodsResolverOpts {
  session: SessionConfig;
  /** Injectable clock (tests). Milliseconds, Date.now-shaped. */
  now?: () => number;
}

/** Build the cached resolver the route handler calls. One per process. */
export function createMethodsResolver(opts: MethodsResolverOpts): () => Promise<AuthMethods> {
  const now = opts.now ?? Date.now;
  const f: FetchLike =
    (opts.session.fetchImpl as FetchLike | undefined) ??
    ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>);
  const base = opts.session.run402BaseUrl ?? 'https://api.run402.com';

  let cached: { at: number; value: AuthMethods } | null = null;

  return async () => {
    if (cached && now() - cached.at < METHODS_CACHE_TTL_MS) return cached.value;
    let value: AuthMethods = { google: false };
    let fromPlatform = false;
    try {
      const res = await f(`${base}/auth/v1/providers`, {
        headers: { apikey: opts.session.projectAnonKey, Authorization: `Bearer ${opts.session.projectAnonKey}` },
      });
      if (res.status >= 200 && res.status < 300) {
        const body = (await res.json()) as { oauth?: unknown };
        if (Array.isArray(body.oauth)) {
          const google = (body.oauth as Array<{ provider?: unknown; enabled?: unknown }>).find(
            (p) => p && p.provider === 'google',
          );
          value = { google: google?.enabled === true };
          fromPlatform = true;
        }
      }
    } catch {
      // Unreachable platform → email-only gate; never an error the gate shows.
    }
    // Only a REAL platform answer is worth holding for the TTL.
    cached = fromPlatform ? { at: now(), value } : null;
    return value;
  };
}
