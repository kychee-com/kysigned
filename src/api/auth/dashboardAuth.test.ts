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
  exchangeEmailCode,
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

  // F-43.1 / AC-258 — both-mode delivery. REAL accepted wire (harvested
  // 2026-07-28, toolbelt fixture magic-link-both-accepted.json): the 200 body
  // is {message, challenge_id}.
  it('sends delivery:"both" when asked and parses challenge_id from the accepted response', async () => {
    const { f, calls } = fakeFetch({ status: 200, body: { message: 'accepted', challenge_id: 'ch_1' } });
    const result = await requestMagicLink({
      ...baseOpts,
      email: 'a@b.com',
      redirectUrl: 'https://kysigned.com/dashboard',
      delivery: 'both',
      fetchImpl: f,
    });
    assert.equal(result.ok, true);
    assert.equal(result.challengeId, 'ch_1');
    const body = JSON.parse(String(calls[0]!.init?.body));
    assert.equal(body.delivery, 'both');
  });

  it('omits the delivery field entirely when not asked — the link-only request stays byte-compatible', async () => {
    const { f, calls } = fakeFetch({ status: 200, body: { message: 'sent' } });
    const result = await requestMagicLink({
      ...baseOpts,
      email: 'a@b.com',
      redirectUrl: 'https://kysigned.com/dashboard',
      fetchImpl: f,
    });
    assert.equal(result.ok, true);
    assert.equal(result.challengeId, undefined);
    const body = JSON.parse(String(calls[0]!.init?.body));
    assert.equal('delivery' in body, false);
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

// F-43.2 — the code door. Platform contract (openspec project-email-code-auth,
// read at 436cb999): POST /auth/v1/token?grant_type=email_code takes EXACTLY
// {challenge_id, code}, answers with the SAME session contract as the link
// exchange (incl. the preserved magic_link metadata block with client_state),
// and fails uniformly R402_AUTH_EMAIL_CODE_INVALID / _EXHAUSTED.
describe('exchangeEmailCode — POST /auth/v1/token?grant_type=email_code', () => {
  const baseOpts = {
    run402BaseUrl: 'https://api.run402.com',
    projectAnonKey: 'anon_test',
  } as const;

  it('posts exactly {challenge_id, code} and returns the session contract + client_state', async () => {
    const { f, calls } = fakeFetch({
      status: 200,
      body: {
        access_token: 'eyJcode',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'rt_code',
        user: { id: 'u1', email: 'A@b.com' },
        magic_link: { client_state: '{"draft_id":"x"}', delivery: 'both', verified_with: 'code' },
      },
    });
    const result = await exchangeEmailCode({ ...baseOpts, challengeId: 'ch_1', code: '123456', fetchImpl: f });
    assert.equal(result.ok, true);
    assert.equal(result.accessToken, 'eyJcode');
    assert.equal(result.refreshToken, 'rt_code');
    assert.equal(result.email, 'A@b.com');
    assert.equal(result.clientState, '{"draft_id":"x"}');
    assert.equal(calls[0]!.url, 'https://api.run402.com/auth/v1/token?grant_type=email_code');
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { challenge_id: 'ch_1', code: '123456' });
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers['apikey'], 'anon_test');
  });

  it('surfaces the platform error code so the handler can tell exhausted from invalid', async () => {
    for (const [platformCode, status] of [
      ['R402_AUTH_EMAIL_CODE_INVALID', 401],
      ['R402_AUTH_EMAIL_CODE_EXHAUSTED', 401],
    ] as const) {
      const { f } = fakeFetch({ status, body: { error: 'nope', code: platformCode } });
      const result = await exchangeEmailCode({ ...baseOpts, challengeId: 'ch_1', code: '000000', fetchImpl: f });
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, platformCode);
    }
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
