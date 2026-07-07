/**
 * session.test.ts — the cookie session middleware (F-18.1 / DD-72).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DbPool } from '../../db/pool.js';
import {
  SESSION_COOKIE,
  CSRF_HEADER,
  buildSessionCookie,
  buildClearSessionCookie,
  csrfOk,
  startSession,
  resolveSession,
  endSession,
  type SessionConfig,
} from './session.js';

/** Stateful fake pool interpreting the auth_sessions DAO SQL. */
function sessionPool() {
  const rows = new Map<string, Record<string, unknown>>();
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as unknown[];
      if (text.includes('INSERT INTO auth_sessions')) {
        const [session_id, email, at, rt, ate, se] = v as [string, string, string, string, Date, Date];
        rows.set(session_id, {
          session_id, email, run402_access_token: at, run402_refresh_token: rt,
          access_token_expires_at: ate, session_expires_at: se,
        });
        return { rows: [], rowCount: 0 } as never;
      }
      if (text.includes('SELECT') && text.includes('FROM auth_sessions')) {
        const [session_id] = v as [string];
        const row = rows.get(session_id);
        // Mirror the SQL `session_expires_at > now()` against the test's FIXED clock
        // (NOW), not real Date.now() — otherwise a fixture session (expiry NOW+TTL)
        // silently "expires" once real wall-clock passes it (it did: NOW+7d = today).
        const live = row && (row.session_expires_at as Date).getTime() > NOW.getTime();
        return { rows: live ? [row] : [], rowCount: live ? 1 : 0 } as never;
      }
      if (text.includes('UPDATE auth_sessions') && text.includes('run402_access_token')) {
        const [at, rt, ate, session_id] = v as [string, string, Date, string];
        const row = rows.get(session_id);
        if (row) { row.run402_access_token = at; row.run402_refresh_token = rt; row.access_token_expires_at = ate; }
        return { rows: [], rowCount: 1 } as never;
      }
      if (text.includes('DELETE FROM auth_sessions')) {
        const [session_id] = v as [string];
        rows.delete(session_id);
        return { rows: [], rowCount: 1 } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    },
    async end() {},
  };
  return { pool, rows };
}

const NOW = new Date('2026-06-15T12:00:00Z');
const cfg: SessionConfig = { projectAnonKey: 'anon', secure: true, cookieDomain: '.kysigned.com', sessionTtlDays: 7, accessTokenTtlSeconds: 2700 };

describe('cookie builders', () => {
  it('session cookie is HttpOnly + Secure + SameSite=Lax + Domain + Max-Age', () => {
    const c = buildSessionCookie('sess-1', cfg);
    assert.ok(c.startsWith(`${SESSION_COOKIE}=sess-1`));
    assert.match(c, /HttpOnly/);
    assert.match(c, /Secure/);
    assert.match(c, /SameSite=Lax/);
    assert.match(c, /Domain=\.kysigned\.com/);
    assert.match(c, /Max-Age=604800/); // 7 days
  });
  it('omits Secure for local dev (secure:false) + host-only when no domain', () => {
    const c = buildSessionCookie('s', { projectAnonKey: 'a', secure: false });
    assert.ok(!/Secure/.test(c));
    assert.ok(!/Domain=/.test(c));
  });
  it('clear cookie has Max-Age=0', () => {
    assert.match(buildClearSessionCookie(cfg), /Max-Age=0/);
  });
});

describe('csrfOk', () => {
  it('safe methods always pass', () => {
    assert.equal(csrfOk('GET', new Headers()), true);
    assert.equal(csrfOk('HEAD', new Headers()), true);
  });
  it('unsafe methods require the custom header', () => {
    assert.equal(csrfOk('POST', new Headers()), false);
    assert.equal(csrfOk('POST', new Headers([[CSRF_HEADER, '1']])), true);
    assert.equal(csrfOk('DELETE', new Headers([[CSRF_HEADER, 'anything']])), true);
  });
});

describe('startSession / resolveSession / endSession', () => {
  it('startSession creates a row and returns the session cookie', async () => {
    const { pool, rows } = sessionPool();
    const { sessionId, cookie } = await startSession(pool, cfg, { email: 'a@x.com', accessToken: 'at', refreshToken: 'rt' }, NOW);
    assert.ok(sessionId);
    assert.ok(cookie.includes(sessionId));
    assert.equal(rows.size, 1);
    assert.equal(rows.get(sessionId)!.email, 'a@x.com');
  });

  it('resolveSession returns the actor for a valid unexpired session (no refresh needed)', async () => {
    const { pool } = sessionPool();
    const { sessionId } = await startSession(pool, cfg, { email: 'a@x.com', accessToken: 'at', refreshToken: 'rt' }, NOW);
    const actor = await resolveSession(pool, cfg, { [SESSION_COOKIE]: sessionId }, NOW);
    assert.equal(actor?.email, 'a@x.com');
    assert.equal(actor?.sessionId, sessionId);
  });

  it('resolveSession returns null with no cookie / unknown session', async () => {
    const { pool } = sessionPool();
    assert.equal(await resolveSession(pool, cfg, {}, NOW), null);
    assert.equal(await resolveSession(pool, cfg, { [SESSION_COOKIE]: 'nope' }, NOW), null);
  });

  // ── FC1.1 regression (system-test F-001) ──────────────────────────────────
  // PROD bug: auth_sessions.session_id is `UUID PRIMARY KEY`, so a malformed
  // cookie value makes Postgres reject the `text -> uuid` cast and THROW
  // (`invalid input syntax for type uuid`). The in-memory mock above never
  // casts, so it hid the bug — every authed /v1/* route 500'd instead of 401.
  // These tests drive a pool that throws like Postgres does, and assert the
  // resolver swallows it to null (-> the auth gate returns a clean 401).

  /** A pool that THROWS on a non-uuid session_id, exactly as run402's HttpDbPool
   *  (real Postgres) does — the failure mode the in-memory mock could not surface. */
  function uuidStrictPool(): DbPool {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return {
      async query(text: string, values?: unknown[]) {
        const v = (values ?? []) as unknown[];
        if (text.includes('FROM auth_sessions')) {
          const id = String(v[0] ?? '');
          if (!UUID_RE.test(id)) {
            throw new Error('invalid input syntax for type uuid: "' + id + '"');
          }
          return { rows: [], rowCount: 0 } as never; // well-formed but unknown -> no row
        }
        return { rows: [], rowCount: 0 } as never;
      },
      async end() {},
    };
  }

  it('resolveSession returns null (not a throw) when a malformed session id makes the DB reject the uuid cast (F-001)', async () => {
    const pool = uuidStrictPool();
    // Must NOT throw — must resolve to null so the auth gate answers 401.
    const actor = await resolveSession(pool, cfg, { [SESSION_COOKIE]: 'fake_session_token' }, NOW);
    assert.equal(actor, null);
  });

  it('resolveSession returns null for a well-formed but unknown UUID (no over-rejection of valid ids)', async () => {
    const pool = uuidStrictPool();
    const actor = await resolveSession(pool, cfg, { [SESSION_COOKIE]: '00000000-0000-4000-8000-000000000000' }, NOW);
    assert.equal(actor, null);
  });

  it('resolveSession refreshes + rotates run402 tokens when the access token has expired', async () => {
    const { pool, rows } = sessionPool();
    const { sessionId } = await startSession(pool, cfg, { email: 'a@x.com', accessToken: 'at', refreshToken: 'rt' }, NOW);
    let refreshCalled = false;
    const refreshCfg: SessionConfig = {
      ...cfg,
      fetchImpl: async () => { refreshCalled = true; return { status: 200, ok: true, json: async () => ({ access_token: 'at2', refresh_token: 'rt2', user: { email: 'a@x.com' } }) }; },
    };
    const LATER = new Date(NOW.getTime() + 3000 * 1000); // past the 2700s access TTL
    const actor = await resolveSession(pool, refreshCfg, { [SESSION_COOKIE]: sessionId }, LATER);
    assert.equal(refreshCalled, true);
    assert.equal(actor?.email, 'a@x.com');
    assert.equal(rows.get(sessionId)!.run402_access_token, 'at2'); // rotated + persisted
    assert.equal(rows.get(sessionId)!.run402_refresh_token, 'rt2');
  });

  it('resolveSession returns null when the refresh fails (revoked run402 session → re-sign-in)', async () => {
    const { pool } = sessionPool();
    const { sessionId } = await startSession(pool, cfg, { email: 'a@x.com', accessToken: 'at', refreshToken: 'rt' }, NOW);
    const failCfg: SessionConfig = { ...cfg, fetchImpl: async () => ({ status: 401, ok: false, json: async () => ({ error: 'used' }) }) };
    const LATER = new Date(NOW.getTime() + 3000 * 1000);
    assert.equal(await resolveSession(pool, failCfg, { [SESSION_COOKIE]: sessionId }, LATER), null);
  });

  it('endSession deletes the row and returns the clearing cookie', async () => {
    const { pool, rows } = sessionPool();
    const { sessionId } = await startSession(pool, cfg, { email: 'a@x.com', accessToken: 'at', refreshToken: 'rt' }, NOW);
    const clear = await endSession(pool, cfg, sessionId);
    assert.equal(rows.size, 0);
    assert.match(clear, /Max-Age=0/);
    // a resolve after signout is unauthenticated
    assert.equal(await resolveSession(pool, cfg, { [SESSION_COOKIE]: sessionId }, NOW), null);
  });
});
