/**
 * authSessions — server-side session store (F-18.1 / DD-72).
 *
 * The SPA holds only an opaque `kysigned_session` id in an HttpOnly cookie; the
 * run402 access/refresh tokens never leave the server — they live in this table.
 * The function-entry's session middleware:
 *   - createAuthSession on a successful token exchange (magic-link / passkey),
 *   - getAuthSession (cookie → email + tokens) on every authed request,
 *   - updateAuthSessionTokens after a server-side refresh rotation,
 *   - deleteAuthSession on signout, and
 *   - deleteExpiredAuthSessions from a periodic sweep.
 *
 * Runs over run402's HTTP SQL (HttpDbPool) in prod; structurally a plain DbPool.
 */
import type { DbPool } from './pool.js';

export interface AuthSession {
  session_id: string;
  email: string;
  run402_access_token: string;
  run402_refresh_token: string;
  access_token_expires_at: Date;
  session_expires_at: Date;
  created_at: Date;
  last_used_at: Date;
}

const TS_COLS = [
  'access_token_expires_at',
  'session_expires_at',
  'created_at',
  'last_used_at',
] as const;

function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function rehydrate(row: Record<string, unknown>): AuthSession {
  for (const c of TS_COLS) if (c in row) row[c] = toDate(row[c]);
  return row as unknown as AuthSession;
}

export interface CreateAuthSessionInput {
  sessionId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  sessionExpiresAt: Date;
}

export async function createAuthSession(pool: DbPool, s: CreateAuthSessionInput): Promise<void> {
  await pool.query(
    `INSERT INTO auth_sessions
       (session_id, email, run402_access_token, run402_refresh_token, access_token_expires_at, session_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [s.sessionId, s.email, s.accessToken, s.refreshToken, s.accessTokenExpiresAt, s.sessionExpiresAt],
  );
}

/** The session row IF it exists and has not expired; null otherwise. */
export async function getAuthSession(pool: DbPool, sessionId: string): Promise<AuthSession | null> {
  const res = await pool.query(
    `SELECT * FROM auth_sessions WHERE session_id = $1 AND session_expires_at > now()`,
    [sessionId],
  );
  const row = res.rows[0] as Record<string, unknown> | undefined;
  return row ? rehydrate(row) : null;
}

export interface RotateTokensInput {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
}

/** Persist a rotated run402 access+refresh pair after a server-side refresh. */
export async function updateAuthSessionTokens(
  pool: DbPool,
  sessionId: string,
  t: RotateTokensInput,
): Promise<void> {
  await pool.query(
    `UPDATE auth_sessions
       SET run402_access_token = $1, run402_refresh_token = $2, access_token_expires_at = $3, last_used_at = now()
     WHERE session_id = $4`,
    [t.accessToken, t.refreshToken, t.accessTokenExpiresAt, sessionId],
  );
}

export async function touchAuthSession(pool: DbPool, sessionId: string): Promise<void> {
  await pool.query(`UPDATE auth_sessions SET last_used_at = now() WHERE session_id = $1`, [sessionId]);
}

export async function deleteAuthSession(pool: DbPool, sessionId: string): Promise<void> {
  await pool.query(`DELETE FROM auth_sessions WHERE session_id = $1`, [sessionId]);
}

/** Periodic sweep — purge expired sessions. Returns the number removed. */
export async function deleteExpiredAuthSessions(pool: DbPool): Promise<number> {
  const res = await pool.query(
    `DELETE FROM auth_sessions WHERE session_expires_at <= now() RETURNING session_id`,
    [],
  );
  return res.rowCount ?? res.rows.length;
}
