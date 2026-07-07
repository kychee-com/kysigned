/**
 * authSessions.test.ts — server-side session store (F-18.1 / DD-72).
 *
 * The SPA holds only an opaque `kysigned_session` id in an HttpOnly cookie; the
 * run402 access/refresh tokens live here, never in the browser. The session
 * function-entry creates a row on token exchange, reads it (cookie → email +
 * tokens) on every authed request, rotates the run402 tokens after a refresh,
 * and deletes it on signout. Tested against a fake pool capturing SQL + params.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuthSession,
  getAuthSession,
  updateAuthSessionTokens,
  touchAuthSession,
  deleteAuthSession,
  deleteExpiredAuthSessions,
} from './authSessions.js';
import type { DbPool } from './pool.js';

function fakePool(rows: Record<string, unknown>[] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values: values ?? [] });
      return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] } as never;
    },
    async end() {},
  };
  return { pool, calls };
}

const NOW = new Date('2026-06-15T12:00:00Z');
const LATER = new Date('2026-06-15T13:00:00Z');
const SESSION_END = new Date('2026-06-22T12:00:00Z');

describe('authSessions DAO', () => {
  it('createAuthSession inserts the session row with all token fields', async () => {
    const { pool, calls } = fakePool();
    await createAuthSession(pool, {
      sessionId: 'sess-1',
      email: 'alice@example.com',
      accessToken: 'at',
      refreshToken: 'rt',
      accessTokenExpiresAt: LATER,
      sessionExpiresAt: SESSION_END,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.text, /INSERT INTO auth_sessions/i);
    assert.deepEqual(calls[0]!.values, ['sess-1', 'alice@example.com', 'at', 'rt', LATER, SESSION_END]);
  });

  it('getAuthSession returns the row, filtered to unexpired sessions', async () => {
    const row = {
      session_id: 'sess-1',
      email: 'alice@example.com',
      run402_access_token: 'at',
      run402_refresh_token: 'rt',
      access_token_expires_at: LATER.toISOString(),
      session_expires_at: SESSION_END.toISOString(),
      created_at: NOW.toISOString(),
      last_used_at: NOW.toISOString(),
    };
    const { pool, calls } = fakePool([row]);
    const s = await getAuthSession(pool, 'sess-1');
    assert.match(calls[0]!.text, /FROM auth_sessions/i);
    assert.match(calls[0]!.text, /session_expires_at > now\(\)/i); // expiry filter in SQL
    assert.deepEqual(calls[0]!.values, ['sess-1']);
    assert.equal(s?.email, 'alice@example.com');
    assert.equal(s?.run402_access_token, 'at');
    // timestamp columns rehydrated to Date
    assert.ok(s?.access_token_expires_at instanceof Date);
    assert.ok(s?.session_expires_at instanceof Date);
  });

  it('getAuthSession returns null when no (unexpired) row', async () => {
    const { pool } = fakePool([]);
    assert.equal(await getAuthSession(pool, 'missing'), null);
  });

  it('updateAuthSessionTokens rotates access+refresh and the access expiry', async () => {
    const { pool, calls } = fakePool();
    await updateAuthSessionTokens(pool, 'sess-1', {
      accessToken: 'at2',
      refreshToken: 'rt2',
      accessTokenExpiresAt: LATER,
    });
    assert.match(calls[0]!.text, /UPDATE auth_sessions/i);
    assert.match(calls[0]!.text, /run402_access_token/i);
    assert.deepEqual(calls[0]!.values, ['at2', 'rt2', LATER, 'sess-1']);
  });

  it('touchAuthSession bumps last_used_at', async () => {
    const { pool, calls } = fakePool();
    await touchAuthSession(pool, 'sess-1');
    assert.match(calls[0]!.text, /UPDATE auth_sessions SET last_used_at = now\(\)/i);
    assert.deepEqual(calls[0]!.values, ['sess-1']);
  });

  it('deleteAuthSession removes the session (signout)', async () => {
    const { pool, calls } = fakePool();
    await deleteAuthSession(pool, 'sess-1');
    assert.match(calls[0]!.text, /DELETE FROM auth_sessions WHERE session_id = \$1/i);
    assert.deepEqual(calls[0]!.values, ['sess-1']);
  });

  it('deleteExpiredAuthSessions purges expired rows and returns the count', async () => {
    const { pool, calls } = fakePool([{ session_id: 'a' }, { session_id: 'b' }]);
    const n = await deleteExpiredAuthSessions(pool);
    assert.match(calls[0]!.text, /DELETE FROM auth_sessions WHERE session_expires_at <= now\(\)/i);
    assert.equal(n, 2);
  });
});
