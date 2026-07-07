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
}

export interface RequestMagicLinkResult {
  ok: boolean;
  reason?: string;
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
    body: JSON.stringify({ email: opts.email, redirect_url: opts.redirectUrl }),
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
  return { ok: true };
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
  };
  return {
    ok: true,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    email: body.user?.email,
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
