/**
 * passkeyHandlers.test — the WebAuthn passkey proxy handlers (F-18.1 restore).
 *
 * kysigned does NOT implement WebAuthn — run402 does. These handlers are a thin
 * proxy to run402's `/auth/v1/passkeys/*`, mirroring the magic-link proxy:
 *   - login/options + login/verify are PUBLIC (the ceremony is the auth); a
 *     successful verify pulls run402's tokens, resolves the email, and starts a
 *     server-side session (the same cookie the magic-link path issues).
 *   - register/options + register/verify + list + delete are SESSION-authed:
 *     the caller's run402 access token (read from auth_sessions) is the Bearer.
 *
 * Tested against a fake run402 (injected fetch) + a stateful fake pool — no
 * network, no real DB.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import type { DbPool } from '../../db/pool.js';
import type { SessionConfig } from './session.js';
import { SESSION_COOKIE } from './session.js';
import {
  handlePasskeyLoginOptions,
  handlePasskeyLoginVerify,
  handlePasskeyRegisterOptions,
  handlePasskeyRegisterVerify,
  handlePasskeyList,
  handlePasskeyDelete,
  type PasskeyHandlerCtx,
} from './passkeyHandlers.js';

// ── fake run402 (injected fetch) ──────────────────────────────────────────────
interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
function fakeFetch(routes: Record<string, { status: number; body: unknown }>) {
  const calls: FakeCall[] = [];
  const f = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, headers: init?.headers ?? {}, body: init?.body });
    const path = new URL(url).pathname;
    const r = routes[`${method} ${path}`];
    const status = r?.status ?? 404;
    const body = r?.body ?? { error: `no fake route for ${method} ${path}` };
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  return { f, calls };
}

// ── fake pool ────────────────────────────────────────────────────────────────
function fakePool(sessionRow?: Record<string, unknown>): { pool: DbPool; queries: string[] } {
  const queries: string[] = [];
  const pool: DbPool = {
    async query(text: string) {
      queries.push(text);
      if (/select \* from auth_sessions/i.test(text)) {
        const rows = sessionRow ? [sessionRow] : [];
        return { rows, rowCount: rows.length } as unknown as pg.QueryResult;
      }
      return { rows: [], rowCount: 0 } as unknown as pg.QueryResult;
    },
    async end() {},
  };
  return { pool, queries };
}

const FUTURE = new Date(Date.now() + 1_000_000_000);
function aSessionRow(): Record<string, unknown> {
  return {
    session_id: 'sess1',
    email: 'a@b.com',
    run402_access_token: 'USER_AT',
    run402_refresh_token: 'USER_RT',
    access_token_expires_at: FUTURE,
    session_expires_at: FUTURE,
    created_at: new Date(),
    last_used_at: new Date(),
  };
}

function ctxWith(
  fetchImpl: SessionConfig['fetchImpl'],
  pool: DbPool,
): PasskeyHandlerCtx {
  const session: SessionConfig = {
    projectAnonKey: 'ANON',
    run402BaseUrl: 'https://api.run402.com',
    fetchImpl,
    secure: false,
  };
  return { pool, session, fallbackOrigin: 'https://kysigned.com' };
}

describe('passkey handlers — login (public)', () => {
  it('login/options proxies to run402 with apikey + the SPA Origin, passes the challenge through', async () => {
    const { f, calls } = fakeFetch({
      'POST /auth/v1/passkeys/login/options': {
        status: 200,
        body: { challenge_id: 'c1', options: { challenge: 'abc' } },
      },
    });
    const { pool } = fakePool();
    const r = await handlePasskeyLoginOptions(ctxWith(f, pool), {
      email: 'a@b.com',
      app_origin: 'https://www.kysigned.com',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { challenge_id: 'c1', options: { challenge: 'abc' } });
    // apikey present, Origin forwarded from app_origin (WebAuthn binding), no Bearer.
    assert.equal(calls[0]!.headers['apikey'], 'ANON');
    assert.equal(calls[0]!.headers['Origin'], 'https://www.kysigned.com');
    assert.ok(!('Authorization' in calls[0]!.headers));
  });

  it('login/verify success → resolves email, starts a session, sets the cookie', async () => {
    const { f } = fakeFetch({
      'POST /auth/v1/passkeys/login/verify': {
        status: 200,
        body: { access_token: 'AT', refresh_token: 'RT' },
      },
      'GET /auth/v1/user': { status: 200, body: { id: 'u1', email: 'A@B.com' } },
    });
    const { pool, queries } = fakePool();
    const r = await handlePasskeyLoginVerify(ctxWith(f, pool), {
      challenge_id: 'c1',
      response: { id: 'cred' },
      app_origin: 'https://kysigned.com',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, email: 'a@b.com' });
    assert.equal(r.setCookies?.length, 1);
    assert.ok(r.setCookies![0]!.startsWith(`${SESSION_COOKIE}=`));
    // the session row was inserted.
    assert.ok(queries.some((q) => /insert into auth_sessions/i.test(q)));
  });

  it('login/verify upstream 4xx → passes status + body through, NO cookie', async () => {
    const { f } = fakeFetch({
      'POST /auth/v1/passkeys/login/verify': { status: 401, body: { error: 'bad assertion' } },
    });
    const { pool } = fakePool();
    const r = await handlePasskeyLoginVerify(ctxWith(f, pool), {
      challenge_id: 'c1',
      response: { id: 'cred' },
    });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: 'bad assertion' });
    assert.equal(r.setCookies, undefined);
  });

  it('login/verify with tokens missing → 502 (unexpected upstream shape)', async () => {
    const { f } = fakeFetch({
      'POST /auth/v1/passkeys/login/verify': { status: 200, body: { not: 'tokens' } },
    });
    const { pool } = fakePool();
    const r = await handlePasskeyLoginVerify(ctxWith(f, pool), { challenge_id: 'c1', response: {} });
    assert.equal(r.status, 502);
  });
});

describe('passkey handlers — register/list/delete (session-authed)', () => {
  it('register/options without a session token → 401', async () => {
    const { f } = fakeFetch({});
    const { pool } = fakePool(/* no session row */);
    const r = await handlePasskeyRegisterOptions(ctxWith(f, pool), 'missing', {
      app_origin: 'https://kysigned.com',
    });
    assert.equal(r.status, 401);
  });

  it('register/options missing app_origin → 400', async () => {
    const { f } = fakeFetch({});
    const { pool } = fakePool(aSessionRow());
    const r = await handlePasskeyRegisterOptions(ctxWith(f, pool), 'sess1', {});
    assert.equal(r.status, 400);
  });

  it('register/options proxies with the session run402 Bearer', async () => {
    const { f, calls } = fakeFetch({
      'POST /auth/v1/passkeys/register/options': {
        status: 200,
        body: { challenge_id: 'rc1', options: {} },
      },
    });
    const { pool } = fakePool(aSessionRow());
    const r = await handlePasskeyRegisterOptions(ctxWith(f, pool), 'sess1', {
      app_origin: 'https://kysigned.com',
      label: 'Yubikey',
    });
    assert.equal(r.status, 200);
    assert.equal(calls[0]!.headers['Authorization'], 'Bearer USER_AT');
    assert.equal(calls[0]!.headers['apikey'], 'ANON');
  });

  it('register/verify requires challenge_id + response → 400 otherwise', async () => {
    const { f } = fakeFetch({});
    const { pool } = fakePool(aSessionRow());
    const r = await handlePasskeyRegisterVerify(ctxWith(f, pool), 'sess1', { app_origin: 'x' });
    assert.equal(r.status, 400);
  });

  it('list → GET run402 with the session Bearer, passes the roster through', async () => {
    const { f, calls } = fakeFetch({
      'GET /auth/v1/passkeys': { status: 200, body: { passkeys: [{ id: 'pk1' }] } },
    });
    const { pool } = fakePool(aSessionRow());
    const r = await handlePasskeyList(ctxWith(f, pool), 'sess1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { passkeys: [{ id: 'pk1' }] });
    assert.equal(calls[0]!.method, 'GET');
    assert.equal(calls[0]!.headers['Authorization'], 'Bearer USER_AT');
  });

  it('list without a session token → 401', async () => {
    const { f } = fakeFetch({});
    const { pool } = fakePool();
    const r = await handlePasskeyList(ctxWith(f, pool), 'missing');
    assert.equal(r.status, 401);
  });

  it('delete → DELETE run402 by id; 204 normalises to {ok:true}', async () => {
    const { f, calls } = fakeFetch({
      'DELETE /auth/v1/passkeys/pk1': { status: 204, body: null },
    });
    const { pool } = fakePool(aSessionRow());
    const r = await handlePasskeyDelete(ctxWith(f, pool), 'sess1', 'pk1');
    assert.equal(r.status, 204);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(calls[0]!.method, 'DELETE');
    assert.equal(calls[0]!.headers['Authorization'], 'Bearer USER_AT');
  });
});
