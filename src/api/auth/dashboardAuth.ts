/**
 * Dashboard auth — run402-backed magic-link + session-token helpers.
 *
 * Backed directly by run402's public auth surface
 * (https://api.run402.com/auth/v1/*) — no abstraction layer:
 *
 *   - Email magic-link — POST /auth/v1/magic-link to request the link,
 *     POST /auth/v1/token?grant_type=magic_link to exchange the clicked
 *     token, GET /auth/v1/user to validate an access token, and
 *     POST /auth/v1/token?grant_type=refresh_token to rotate the session.
 *
 * The forker supplies their own run402 project anon key via the
 * `KYSIGNED_RUN402_ANON_KEY` env var.
 */

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ status: number; ok?: boolean; json: () => Promise<unknown> }>;

// --- Magic link (run402-backed) ---

interface BaseRun402AuthOpts {
  run402BaseUrl?: string;
  projectAnonKey: string;
  fetchImpl?: FetchLike;
}

function defaultBase(url?: string): string {
  return url ?? 'https://api.run402.com';
}

function defaultFetch(impl?: FetchLike): FetchLike {
  return impl ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>);
}

export interface RequestMagicLinkOpts extends BaseRun402AuthOpts {
  email: string;
  redirectUrl: string;
  /**
   * F-40 / DD-57 — run402's own carry-context field (≤2048 bytes). It is stored
   * with the token and returned on a VERIFIED exchange as
   * `magic_link.client_state`, so it is the bound, non-URL copy of whatever the
   * caller needs back. Omitted entirely when absent, so an ordinary sign-in
   * request is byte-identical to what it was before F-40.
   */
  clientState?: string;
  /**
   * F-43.1 — ask the platform to put a six-digit code in the email BESIDE the
   * link (`delivery: "both"`: one challenge backs both credentials; whichever
   * is used first consumes it). Omitted entirely when absent, so the link-only
   * request stays byte-identical to what it was before F-43.
   */
  delivery?: 'both';
}

export interface RequestMagicLinkResult {
  ok: boolean;
  reason?: string;
  /** The upstream status, so a caller can tell a REFUSAL apart from a fault. */
  status?: number;
  /**
   * F-43.1 — the opaque handle the code is verified against
   * (`grant_type=email_code`). Present only on a both-mode accepted response;
   * non-enumerating by platform design (returned regardless of account state).
   */
  challengeId?: string;
}

export async function requestMagicLink(
  opts: RequestMagicLinkOpts
): Promise<RequestMagicLinkResult> {
  const f = defaultFetch(opts.fetchImpl);
  const res = await f(`${defaultBase(opts.run402BaseUrl)}/auth/v1/magic-link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: opts.projectAnonKey,
    },
    body: JSON.stringify({
      email: opts.email,
      redirect_url: opts.redirectUrl,
      ...(opts.clientState ? { client_state: opts.clientState } : {}),
      ...(opts.delivery ? { delivery: opts.delivery } : {}),
    }),
  });
  if (res.status < 200 || res.status >= 300) {
    let reason = `run402 returned status ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) reason = `${reason}: ${body.error}`;
    } catch {
      // ignore
    }
    return { ok: false, reason, status: res.status };
  }
  // Both-mode accepted responses carry the challenge handle; the link-only
  // response body is ignored exactly as before.
  let challengeId: string | undefined;
  if (opts.delivery) {
    try {
      const body = (await res.json()) as { challenge_id?: unknown };
      if (typeof body.challenge_id === 'string' && body.challenge_id) challengeId = body.challenge_id;
    } catch {
      // a malformed accepted body degrades to link-only; the email still went out
    }
  }
  return { ok: true, ...(challengeId ? { challengeId } : {}) };
}

export interface ExchangeMagicLinkOpts extends BaseRun402AuthOpts {
  magicLinkToken: string;
}

export interface ExchangeMagicLinkResult {
  ok: boolean;
  accessToken?: string;
  refreshToken?: string;
  email?: string;
  reason?: string;
  /**
   * F-40 / DD-57 — whatever `clientState` rode the request, handed back verbatim
   * by run402 (`magic_link.client_state`). Present only on a VERIFIED exchange:
   * an expired or already-used token verifies to nothing, so a failure carries no
   * state at all. That asymmetry is exactly why the handle also rides the
   * redirect URL.
   */
  clientState?: string;
}

export async function exchangeMagicLinkToken(
  opts: ExchangeMagicLinkOpts
): Promise<ExchangeMagicLinkResult> {
  const f = defaultFetch(opts.fetchImpl);
  const res = await f(
    `${defaultBase(opts.run402BaseUrl)}/auth/v1/token?grant_type=magic_link`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: opts.projectAnonKey,
      },
      body: JSON.stringify({ token: opts.magicLinkToken }),
    }
  );
  if (res.status < 200 || res.status >= 300) {
    let reason = `run402 returned status ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) reason = `${reason}: ${body.error}`;
    } catch {
      // ignore
    }
    return { ok: false, reason };
  }
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    user?: { email?: string };
    magic_link?: { client_state?: unknown };
  };
  const clientState = body.magic_link?.client_state;
  return {
    ok: true,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    email: body.user?.email,
    ...(typeof clientState === 'string' && clientState ? { clientState } : {}),
  };
}

// --- Email-code exchange (F-43.2) ---

export interface ExchangeEmailCodeOpts extends BaseRun402AuthOpts {
  challengeId: string;
  code: string;
}

export interface ExchangeEmailCodeResult {
  ok: boolean;
  accessToken?: string;
  refreshToken?: string;
  email?: string;
  /** Same preserved metadata block as the link exchange (F-40's bound copy). */
  clientState?: string;
  reason?: string;
  /**
   * The platform's error code on failure — R402_AUTH_EMAIL_CODE_INVALID
   * (uniform: wrong, expired, superseded, consumed, cross-project) or
   * R402_AUTH_EMAIL_CODE_EXHAUSTED (fifth wrong attempt burned it). The
   * handler maps these to friendly copy; they are never rendered.
   */
  errorCode?: string;
  /**
   * FC28.4 — the HTTP status, so the handler can tell a spent verification
   * budget (429, the per-challenge limiter firing BEFORE verification) from a
   * wrong guess. Both arrive as failures; only one is the visitor's fault.
   */
  status?: number;
  /**
   * FC28.4 — the platform's own terminal classification. The error CODE is
   * uniform on purpose (it never says WHICH of wrong/expired/superseded/
   * consumed happened), but the envelope publishes whether this challenge can
   * still be tried: the normative `next_actions[0].type` and, corroborating it,
   * `retryable`. Terminal means only a FRESH email recovers, so telling the
   * visitor to check the digits would be advice that cannot work.
   *
   * Absent both signals → `false`: an unrecognised envelope degrades to today's
   * uniform retry copy rather than falsely declaring the challenge dead.
   */
  terminal?: boolean;
}

/**
 * Verify a six-digit email code against its challenge —
 * `POST /auth/v1/token?grant_type=email_code`, body exactly
 * `{challenge_id, code}` per the platform contract. Success returns the SAME
 * session contract as the link exchange (one shared challenge backs both
 * credentials; whichever is used first consumes it).
 */
export async function exchangeEmailCode(opts: ExchangeEmailCodeOpts): Promise<ExchangeEmailCodeResult> {
  const f = defaultFetch(opts.fetchImpl);
  const res = await f(`${defaultBase(opts.run402BaseUrl)}/auth/v1/token?grant_type=email_code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: opts.projectAnonKey,
    },
    body: JSON.stringify({ challenge_id: opts.challengeId, code: opts.code }),
  });
  if (res.status < 200 || res.status >= 300) {
    let reason = `run402 returned status ${res.status}`;
    let errorCode: string | undefined;
    let terminal = false;
    try {
      const body = (await res.json()) as {
        error?: string;
        code?: string;
        retryable?: boolean;
        next_actions?: Array<{ type?: string }>;
      };
      if (body?.error) reason = `${reason}: ${body.error}`;
      if (typeof body?.code === 'string') errorCode = body.code;
      // The normative signal first (`request_fresh_credential` means exactly
      // "this credential is dead, get a new one"); `retryable` corroborates and
      // covers a gateway that stops sending next_actions. Neither → false.
      const nextAction = Array.isArray(body?.next_actions) ? body.next_actions[0]?.type : undefined;
      terminal = nextAction !== undefined ? nextAction === 'request_fresh_credential' : body?.retryable === false;
    } catch {
      // ignore
    }
    return { ok: false, reason, status: res.status, terminal, ...(errorCode ? { errorCode } : {}) };
  }
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    user?: { email?: string };
    magic_link?: { client_state?: unknown };
  };
  const clientState = body.magic_link?.client_state;
  return {
    ok: true,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    email: body.user?.email,
    ...(typeof clientState === 'string' && clientState ? { clientState } : {}),
  };
}

// --- Refresh-token rotation (2F.AUTH1 / F2.1.7) ---

export interface RefreshAccessTokenOpts extends BaseRun402AuthOpts {
  refreshToken: string;
}

export interface RefreshAccessTokenResult {
  ok: boolean;
  accessToken?: string;
  refreshToken?: string;
  email?: string;
  reason?: string;
}

/**
 * Exchange a still-valid refresh token for a fresh access token (and a rotated
 * refresh token — run402 rotates the refresh token on every use). Parallels
 * `exchangeMagicLinkToken` but hits the `grant_type=refresh_token` flow. The
 * caller (the kysigned-api Lambda's auth route) invokes this when the SPA's
 * 401 interceptor presents a refresh token; on failure (expired/used/invalid
 * refresh token → 401) the SPA falls back to magic-link re-sign-in.
 */
export async function refreshAccessToken(
  opts: RefreshAccessTokenOpts
): Promise<RefreshAccessTokenResult> {
  const f = defaultFetch(opts.fetchImpl);
  const res = await f(
    `${defaultBase(opts.run402BaseUrl)}/auth/v1/token?grant_type=refresh_token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: opts.projectAnonKey,
      },
      body: JSON.stringify({ refresh_token: opts.refreshToken }),
    }
  );
  if (res.status < 200 || res.status >= 300) {
    let reason = `run402 returned status ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) reason = `${reason}: ${body.error}`;
    } catch {
      // ignore
    }
    return { ok: false, reason };
  }
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    user?: { email?: string };
  };
  return {
    ok: true,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    email: body.user?.email,
  };
}

export interface FetchRun402UserOpts extends BaseRun402AuthOpts {
  accessToken: string;
}

export interface FetchRun402UserResult {
  ok: boolean;
  user?: { id: string; email: string; display_name?: string };
  reason?: string;
}

export async function fetchRun402User(
  opts: FetchRun402UserOpts
): Promise<FetchRun402UserResult> {
  const f = defaultFetch(opts.fetchImpl);
  const res = await f(`${defaultBase(opts.run402BaseUrl)}/auth/v1/user`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      apikey: opts.projectAnonKey,
    },
  });
  if (res.status < 200 || res.status >= 300) {
    let reason = `run402 returned status ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) reason = `${reason}: ${body.error}`;
    } catch {
      // ignore
    }
    return { ok: false, reason };
  }
  const body = (await res.json()) as { id: string; email: string; display_name?: string };
  return { ok: true, user: body };
}
