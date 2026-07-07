/**
 * Dashboard auth tests — run402-backed magic-link + session-token helpers.
 *
 * The kysigned dashboard authenticates users via run402's public auth surface:
 *
 *   - Email magic-link — the dashboard calls
 *     POST https://api.run402.com/auth/v1/magic-link to request a link,
 *     and POST .../auth/v1/token?grant_type=magic_link to exchange the
 *     clicked token for an access_token. The access_token is then validated
 *     with GET .../auth/v1/user before each privileged action, and rotated
 *     via grant_type=refresh_token.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  requestMagicLink,
  exchangeMagicLinkToken,
  refreshAccessToken,
  fetchRun402User,
} from './dashboardAuth.js';

function fakeFetch(canned: { status: number; body: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(canned.body), {
      status: canned.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { f, calls };
}

describe('requestMagicLink — POST /auth/v1/magic-link', () => {
  const baseOpts = {
    run402BaseUrl: 'https://api.run402.com',
    projectAnonKey: 'anon_test',
  } as const;

  it('posts to the right URL with the project anon key', async () => {
    const { f, calls } = fakeFetch({ status: 200, body: { message: 'sent' } });
    const result = await requestMagicLink({
      ...baseOpts,
      email: 'a@b.com',
      redirectUrl: 'https://kysigned.com/dashboard',
      fetchImpl: f,
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://api.run402.com/auth/v1/magic-link');
    assert.equal(calls[0]!.init?.method, 'POST');
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers['apikey'], 'anon_test');
    assert.equal(headers['Content-Type'], 'application/json');
    const body = JSON.parse(String(calls[0]!.init?.body));
    assert.equal(body.email, 'a@b.com');
    assert.equal(body.redirect_url, 'https://kysigned.com/dashboard');
  });

  it('reports failure when run402 returns non-2xx', async () => {
    const { f } = fakeFetch({ status: 429, body: { error: 'rate limit' } });
    const result = await requestMagicLink({
      ...baseOpts,
      email: 'a@b.com',
      redirectUrl: 'https://kysigned.com/dashboard',
      fetchImpl: f,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason!, /429|rate/i);
  });
});

describe('exchangeMagicLinkToken — POST /auth/v1/token?grant_type=magic_link', () => {
  const baseOpts = {
    run402BaseUrl: 'https://api.run402.com',
    projectAnonKey: 'anon_test',
  } as const;

  it('posts the magic-link token and returns access_token + email on success', async () => {
    const { f, calls } = fakeFetch({
      status: 200,
      body: {
        access_token: 'eyJabc',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'rt_xyz',
        user: { id: 'u1', email: 'a@b.com' },
      },
    });
    const result = await exchangeMagicLinkToken({
      ...baseOpts,
      magicLinkToken: 'mlt_123',
      fetchImpl: f,
    });
    assert.equal(result.ok, true);
    assert.equal(result.accessToken, 'eyJabc');
    assert.equal(result.refreshToken, 'rt_xyz');
    assert.equal(result.email, 'a@b.com');
    assert.equal(
      calls[0]!.url,
      'https://api.run402.com/auth/v1/token?grant_type=magic_link'
    );
  });

  it('reports failure on 401', async () => {
    const { f } = fakeFetch({ status: 401, body: { error: 'expired' } });
    const result = await exchangeMagicLinkToken({
      ...baseOpts,
      magicLinkToken: 'mlt_bad',
      fetchImpl: f,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason!, /401|expired/i);
  });
});

describe('refreshAccessToken — POST /auth/v1/token?grant_type=refresh_token (2F.AUTH1)', () => {
  const baseOpts = {
    run402BaseUrl: 'https://api.run402.com',
    projectAnonKey: 'anon_test',
  } as const;

  it('posts the refresh token and returns rotated access + refresh tokens on success', async () => {
    const { f, calls } = fakeFetch({
      status: 200,
      body: {
        access_token: 'eyJnew',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'rt_rotated',
        user: { id: 'u1', email: 'a@b.com' },
      },
    });
    const result = await refreshAccessToken({
      ...baseOpts,
      refreshToken: 'rt_old',
      fetchImpl: f,
    });
    assert.equal(result.ok, true);
    assert.equal(result.accessToken, 'eyJnew');
    assert.equal(result.refreshToken, 'rt_rotated');
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]!.url,
      'https://api.run402.com/auth/v1/token?grant_type=refresh_token'
    );
    assert.equal(calls[0]!.init?.method, 'POST');
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers['apikey'], 'anon_test');
    assert.equal(headers['Content-Type'], 'application/json');
    const body = JSON.parse(String(calls[0]!.init?.body));
    assert.equal(body.refresh_token, 'rt_old');
  });

  it('reports failure on 401 (refresh expired/used) without throwing', async () => {
    const { f } = fakeFetch({ status: 401, body: { error: 'Refresh token expired' } });
    const result = await refreshAccessToken({
      ...baseOpts,
      refreshToken: 'rt_expired',
      fetchImpl: f,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason!, /401|expired/i);
  });
});

describe('fetchRun402User — GET /auth/v1/user (token validation)', () => {
  const baseOpts = {
    run402BaseUrl: 'https://api.run402.com',
    projectAnonKey: 'anon_test',
  } as const;

  it('returns user data on 200', async () => {
    const { f, calls } = fakeFetch({
      status: 200,
      body: { id: 'u1', email: 'a@b.com', display_name: 'A B' },
    });
    const result = await fetchRun402User({
      ...baseOpts,
      accessToken: 'eyJabc',
      fetchImpl: f,
    });
    assert.equal(result.ok, true);
    assert.equal(result.user?.email, 'a@b.com');
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer eyJabc');
    assert.equal(headers['apikey'], 'anon_test');
  });

  it('returns ok=false on 401 without throwing', async () => {
    const { f } = fakeFetch({ status: 401, body: { error: 'invalid' } });
    const result = await fetchRun402User({
      ...baseOpts,
      accessToken: 'bad',
      fetchImpl: f,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason!, /401|invalid/i);
  });
});
