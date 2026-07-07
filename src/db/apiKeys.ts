/**
 * apiKeys — creator API-key store (spec F-30.1 / AC-131, AC-132).
 *
 * One row per minted key: the sha256 HASH of the key (never the raw value),
 * the owning creator's email, an optional label, and lifecycle stamps. The
 * lookup path filters revoked keys in SQL; revocation is scoped to the owner
 * so a creator can only ever revoke their own keys.
 *
 * Runs over run402's HTTP SQL (HttpDbPool) in prod; structurally a plain DbPool.
 * HttpDbPool returns TIMESTAMPTZ as ISO strings — rehydrate at this boundary.
 */
import type { DbPool } from './pool.js';

export interface ApiKeyRow {
  id: string;
  creator_email: string;
  key_hash: string;
  label: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const TS_COLS = ['created_at', 'last_used_at', 'revoked_at'] as const;

function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function rehydrate(row: Record<string, unknown>): ApiKeyRow {
  for (const c of TS_COLS) if (c in row) row[c] = toDate(row[c]);
  return row as unknown as ApiKeyRow;
}

export interface CreateApiKeyInput {
  creatorEmail: string;
  keyHash: string;
  label: string | null;
}

export async function createApiKey(pool: DbPool, k: CreateApiKeyInput): Promise<ApiKeyRow> {
  const res = await pool.query(
    `INSERT INTO api_keys (creator_email, key_hash, label)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [k.creatorEmail, k.keyHash, k.label],
  );
  return rehydrate(res.rows[0] as Record<string, unknown>);
}

/** The live (non-revoked) key row for a hash; null otherwise. */
export async function getApiKeyByHash(pool: DbPool, keyHash: string): Promise<ApiKeyRow | null> {
  const res = await pool.query(
    `SELECT * FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
    [keyHash],
  );
  const row = res.rows[0] as Record<string, unknown> | undefined;
  return row ? rehydrate(row) : null;
}

/** Every key (live and revoked) belonging to the creator, newest first. */
export async function listApiKeysByCreator(pool: DbPool, creatorEmail: string): Promise<ApiKeyRow[]> {
  const res = await pool.query(
    `SELECT * FROM api_keys WHERE creator_email = $1 ORDER BY created_at DESC`,
    [creatorEmail],
  );
  return (res.rows as Array<Record<string, unknown>>).map(rehydrate);
}

/** Owner-scoped revocation. True iff a LIVE key of THIS creator was revoked. */
export async function revokeApiKey(pool: DbPool, id: string, creatorEmail: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE api_keys SET revoked_at = now()
     WHERE id = $1 AND creator_email = $2 AND revoked_at IS NULL
     RETURNING id`,
    [id, creatorEmail],
  );
  return (res.rowCount ?? res.rows.length) > 0;
}

export async function touchApiKeyLastUsed(pool: DbPool, id: string): Promise<void> {
  await pool.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [id]);
}
