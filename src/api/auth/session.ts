/**
 * session — the function-entry's cookie session middleware (F-18.1 / DD-72).
 *
 * The SPA holds only an opaque `kysigned_session` id in an HttpOnly cookie; the
 * run402 access/refresh tokens stay server-side in `auth_sessions`. This module:
 *   - mints the session cookie (HttpOnly, Secure, SameSite=Lax),
 *   - resolves a request's cookie → the actor (email), refreshing the run402
 *     access token server-side when it has expired (a refresh failure = the
 *     run402 session is gone → 401, the SPA falls back to re-sign-in), and
 *   - enforces CSRF on unsafe methods via a custom-header check (the security
 *     comes from the browser's cross-origin custom-header preflight rule, not
 *     value secrecy — any fixed value works).
 *
 * Config-injected (run402 anon key, cookie domain, TTLs, a refresh fetch) so the
 * forker supplies their own; unit-tested against a stateful fake pool + fetch.
 */
import { randomUUID } from 'node:crypto';
import type { DbPool } from '../../db/pool.js';
import {
  createAuthSession,
  getAuthSession,
  updateAuthSessionTokens,
  deleteAuthSession,
} from '../../db/authSessions.js';
import { refreshAccessToken } from './dashboardAuth.js';

export const SESSION_COOKIE = 'kysigned_session';
export const CSRF_HEADER = 'x-kysigned-csrf';

const DAY_S = 24 * 60 * 60;

/** Session ids are minted with `randomUUID()` and `auth_sessions.session_id` is
 *  `UUID PRIMARY KEY`. A cookie value that is not a well-formed UUID can never be
 *  a real session AND makes Postgres reject the `text -> uuid` cast (throwing
 *  `invalid input syntax for type uuid`), so we screen it out BEFORE the query —
 *  treating a malformed id exactly like a missing cookie (→ 401), never a 500.
 *  (Regression: system-test F-001.) */
const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RefreshFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok?: boolean; json: () => Promise<unknown> }>;

export interface SessionConfig {
  /** run402 project anon key — required for the server-side token refresh. */
  projectAnonKey: string;
  run402BaseUrl?: string;
  /** Cookie Domain (e.g. `.kysigned.com`); omit for a host-only cookie. */
  cookieDomain?: string;
  /** Emit `Secure` (default true; set false only for local http dev). */
  secure?: boolean;
  /** Session lifetime in days (the cookie + the row). Default 7. */
  sessionTtlDays?: number;
  /** Access-token refresh cadence in seconds (the run402 access token TTL).
   *  Default 2700 (45 min). Imprecision is harmless — kysigned reads the DB with
   *  the service key, not the user token; the refresh only keeps the run402-backed
   *  session live + surfaces revocation. */
  accessTokenTtlSeconds?: number;
  /** Injectable fetch for the refresh call (tests). */
  fetchImpl?: RefreshFetch;
}

function cookieAttrs(cfg: SessionConfig): string[] {
  const a = ['HttpOnly', 'Path=/', 'SameSite=Lax'];
  if (cfg.secure !== false) a.push('Secure');
  if (cfg.cookieDomain) a.push(`Domain=${cfg.cookieDomain}`);
  return a;
}

/** `Set-Cookie` value carrying the session id. */
export function buildSessionCookie(sessionId: string, cfg: SessionConfig): string {
  const maxAge = (cfg.sessionTtlDays ?? 7) * DAY_S;
  return [`${SESSION_COOKIE}=${sessionId}`, ...cookieAttrs(cfg), `Max-Age=${maxAge}`].join('; ');
}

/** `Set-Cookie` value that clears the session (signout). */
export function buildClearSessionCookie(cfg: SessionConfig): string {
  return [`${SESSION_COOKIE}=`, ...cookieAttrs(cfg), 'Max-Age=0'].join('; ');
}

/** CSRF: safe methods always pass; unsafe methods require the custom header. */
export function csrfOk(method: string, headers: Headers): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  return headers.has(CSRF_HEADER);
}

export interface IssuedTokens {
  email: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * Create a session row for a freshly-authenticated user and return its id + the
 * `Set-Cookie` value. The access-token expiry is stamped from the configured TTL.
 */
export async function startSession(
  pool: DbPool,
  cfg: SessionConfig,
  tokens: IssuedTokens,
  now: Date = new Date(),
): Promise<{ sessionId: string; cookie: string }> {
  const sessionId = randomUUID();
  const accessTtl = (cfg.accessTokenTtlSeconds ?? 2700) * 1000;
  const sessionTtl = (cfg.sessionTtlDays ?? 7) * DAY_S * 1000;
  await createAuthSession(pool, {
    sessionId,
    email: tokens.email,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: new Date(now.getTime() + accessTtl),
    sessionExpiresAt: new Date(now.getTime() + sessionTtl),
  });
  return { sessionId, cookie: buildSessionCookie(sessionId, cfg) };
}

export interface SessionActor {
  email: string;
  sessionId: string;
}

/**
 * Resolve a request's session cookie → the actor, or null (= 401). Refreshes the
 * run402 access token server-side when it has expired; a refresh failure (the
 * run402 session was revoked/rotated away) resolves to null so the SPA re-signs in.
 */
export async function resolveSession(
  pool: DbPool,
  cfg: SessionConfig,
  cookies: Record<string, string>,
  now: Date = new Date(),
): Promise<SessionActor | null> {
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;
  // A malformed (non-UUID) id can never be a real session and would make the DB
  // reject the uuid cast → screen it out up front, exactly like a missing cookie
  // (F-001: this is what made the auth gate 500 instead of 401).
  if (!SESSION_ID_RE.test(sessionId)) return null;

  // Belt-and-braces: any throw while RESOLVING the session (a transient DB error,
  // a future row-shape surprise) must degrade to "no session" → 401, never bubble
  // up as a 500 from an authenticated route (spec F-12.1 / F-18.1). A real handler
  // error AFTER a valid session resolves is unaffected — only auth resolution is
  // hardened here.
  try {
    const s = await getAuthSession(pool, sessionId); // already filters session_expires_at > now()
    if (!s) return null;

    if (s.access_token_expires_at.getTime() <= now.getTime()) {
      const r = await refreshAccessToken({
        refreshToken: s.run402_refresh_token,
        projectAnonKey: cfg.projectAnonKey,
        run402BaseUrl: cfg.run402BaseUrl,
        fetchImpl: cfg.fetchImpl,
      });
      if (!r.ok || !r.accessToken || !r.refreshToken) return null;
      const accessTtl = (cfg.accessTokenTtlSeconds ?? 2700) * 1000;
      await updateAuthSessionTokens(pool, sessionId, {
        accessToken: r.accessToken,
        refreshToken: r.refreshToken,
        accessTokenExpiresAt: new Date(now.getTime() + accessTtl),
      });
    }
    return { email: s.email, sessionId };
  } catch {
    return null;
  }
}

/** Destroy a session (signout): delete the row + return the clearing cookie. */
export async function endSession(pool: DbPool, cfg: SessionConfig, sessionId: string): Promise<string> {
  await deleteAuthSession(pool, sessionId);
  return buildClearSessionCookie(cfg);
}
