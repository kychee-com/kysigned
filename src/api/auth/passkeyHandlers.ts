/**
 * passkeyHandlers — WebAuthn passkey sign-in / registration, proxied to run402
 * (F-18.1 passkey-first).
 *
 * kysigned implements NO WebAuthn itself: run402 owns the relying-party logic
 * (challenge issuance + assertion/attestation verification). These handlers are
 * a thin proxy to run402's `/auth/v1/passkeys/*`, the same shape as the
 * magic-link proxy (authHandlers.ts):
 *
 *   POST /v1/auth/passkeys/login/options    (public)  → run402 login/options
 *   POST /v1/auth/passkeys/login/verify     (public)  → run402 login/verify, then
 *                                                        resolve email + startSession
 *   POST /v1/auth/passkeys/register/options (session) → run402 register/options
 *   POST /v1/auth/passkeys/register/verify  (session) → run402 register/verify
 *   GET    /v1/auth/passkeys                (session) → run402 list
 *   DELETE /v1/auth/passkeys/:id            (session) → run402 delete
 *
 * The login routes are unauthenticated — the ceremony IS the auth; a successful
 * verify issues the same HttpOnly `kysigned_session` cookie as magic-link. The
 * register/list/delete routes are session-authed: the caller's run402 access
 * token (held server-side in `auth_sessions`, already validated+refreshed by the
 * entry's session gate) is the upstream Bearer.
 *
 * WebAuthn binds the challenge to the request Origin, so the SPA's `app_origin`
 * is forwarded as the upstream `Origin` header to keep the server-to-server call
 * in sync with the browser ceremony (handles apex vs www.).
 */
import type { DbPool } from '../../db/pool.js';
import { getAuthSession } from '../../db/authSessions.js';
import { startSession, type SessionConfig } from './session.js';
import { fetchRun402User } from './dashboardAuth.js';

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok?: boolean; json: () => Promise<unknown> }>;

export interface PasskeyHandlerCtx {
  pool: DbPool;
  /** Reused for the run402 anon key + base URL + (test) fetch, and to startSession. */
  session: SessionConfig;
  /** Origin for the upstream WebAuthn call when the SPA sent no `app_origin`. */
  fallbackOrigin: string;
}

export interface PasskeyResult {
  status: number;
  body: unknown;
  setCookies?: string[];
}

function base(cfg: SessionConfig): string {
  return cfg.run402BaseUrl ?? 'https://api.run402.com';
}

function fetchImpl(cfg: SessionConfig): FetchLike {
  return (
    (cfg.fetchImpl as FetchLike | undefined) ??
    ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>)
  );
}

async function parseJson(res: { status: number; json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return { error: `Upstream returned non-JSON (status ${res.status})` };
  }
}

/** POST to a run402 passkey endpoint; returns the upstream status + parsed body. */
async function run402PasskeyPost(
  ctx: PasskeyHandlerCtx,
  path: string,
  bearer: string | null,
  body: unknown,
  originHeader: string | undefined,
): Promise<{ status: number; body: unknown }> {
  const f = fetchImpl(ctx.session);
  const headers: Record<string, string> = {
    apikey: ctx.session.projectAnonKey,
    'Content-Type': 'application/json',
    Origin: originHeader || ctx.fallbackOrigin,
  };
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  const res = await f(`${base(ctx.session)}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await parseJson(res) };
}

/** The session's run402 access token (the gate already validated/refreshed it). */
async function sessionAccessToken(ctx: PasskeyHandlerCtx, sessionId: string): Promise<string | null> {
  const s = await getAuthSession(ctx.pool, sessionId);
  return s?.run402_access_token ?? null;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// ── login (public — the ceremony is the auth) ────────────────────────────────

export async function handlePasskeyLoginOptions(
  ctx: PasskeyHandlerCtx,
  body: { email?: unknown; app_origin?: unknown },
): Promise<PasskeyResult> {
  const appOrigin = asString(body.app_origin);
  return run402PasskeyPost(
    ctx,
    '/auth/v1/passkeys/login/options',
    null,
    { email: asString(body.email), app_origin: appOrigin },
    appOrigin,
  );
}

export async function handlePasskeyLoginVerify(
  ctx: PasskeyHandlerCtx,
  body: { challenge_id?: unknown; response?: unknown; app_origin?: unknown },
): Promise<PasskeyResult> {
  const up = await run402PasskeyPost(
    ctx,
    '/auth/v1/passkeys/login/verify',
    null,
    { challenge_id: body.challenge_id, response: body.response },
    asString(body.app_origin),
  );
  if (up.status >= 400) return { status: up.status, body: up.body };

  const data = (up.body ?? {}) as { access_token?: string; refresh_token?: string };
  if (!data.access_token || !data.refresh_token) {
    return { status: 502, body: { error: 'Passkey verify returned unexpected shape (no tokens)' } };
  }
  // run402's passkey verify returns tokens but not the email — resolve it canonically.
  const userInfo = await fetchRun402User({
    accessToken: data.access_token,
    projectAnonKey: ctx.session.projectAnonKey,
    run402BaseUrl: ctx.session.run402BaseUrl,
    fetchImpl: ctx.session.fetchImpl,
  });
  const email = userInfo.ok && userInfo.user ? userInfo.user.email.toLowerCase() : null;
  if (!email) {
    return { status: 401, body: { error: 'Could not resolve user email after passkey verify' } };
  }
  const { cookie } = await startSession(ctx.pool, ctx.session, {
    email,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  });
  return { status: 200, body: { ok: true, email }, setCookies: [cookie] };
}

// ── register + manage (session-authed; Bearer = the session's run402 token) ──

export async function handlePasskeyRegisterOptions(
  ctx: PasskeyHandlerCtx,
  sessionId: string,
  body: { app_origin?: unknown; label?: unknown },
): Promise<PasskeyResult> {
  const at = await sessionAccessToken(ctx, sessionId);
  if (!at) return { status: 401, body: { error: 'Not authenticated' } };
  const appOrigin = asString(body.app_origin);
  if (!appOrigin) return { status: 400, body: { error: 'app_origin is required' } };
  return run402PasskeyPost(
    ctx,
    '/auth/v1/passkeys/register/options',
    at,
    { app_origin: appOrigin, label: asString(body.label) },
    appOrigin,
  );
}

export async function handlePasskeyRegisterVerify(
  ctx: PasskeyHandlerCtx,
  sessionId: string,
  body: { challenge_id?: unknown; response?: unknown; label?: unknown; app_origin?: unknown },
): Promise<PasskeyResult> {
  const at = await sessionAccessToken(ctx, sessionId);
  if (!at) return { status: 401, body: { error: 'Not authenticated' } };
  if (!body.challenge_id || !body.response) {
    return { status: 400, body: { error: 'challenge_id and response are required' } };
  }
  return run402PasskeyPost(
    ctx,
    '/auth/v1/passkeys/register/verify',
    at,
    { challenge_id: body.challenge_id, response: body.response, label: asString(body.label) },
    asString(body.app_origin),
  );
}

export async function handlePasskeyList(ctx: PasskeyHandlerCtx, sessionId: string): Promise<PasskeyResult> {
  const at = await sessionAccessToken(ctx, sessionId);
  if (!at) return { status: 401, body: { error: 'Not authenticated' } };
  const f = fetchImpl(ctx.session);
  const res = await f(`${base(ctx.session)}/auth/v1/passkeys`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${at}`, apikey: ctx.session.projectAnonKey },
  });
  return { status: res.status, body: await parseJson(res) };
}

export async function handlePasskeyDelete(
  ctx: PasskeyHandlerCtx,
  sessionId: string,
  id: string,
): Promise<PasskeyResult> {
  const at = await sessionAccessToken(ctx, sessionId);
  if (!at) return { status: 401, body: { error: 'Not authenticated' } };
  const f = fetchImpl(ctx.session);
  const res = await f(`${base(ctx.session)}/auth/v1/passkeys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${at}`, apikey: ctx.session.projectAnonKey },
  });
  if (res.status === 204) return { status: 204, body: { ok: true } };
  return { status: res.status, body: await parseJson(res) };
}
