/**
 * trackingToken — the envelope-observer credential (spec F-30.7 / #154, DD-37).
 *
 * The fourth, narrowest authority in the link/auth model: an envelope-scoped,
 * read-only handle returned with every create 201. Custody mirrors apiKeyAuth:
 * the raw token exists only in create results (and the stored idempotent
 * replay body — that recoverability IS the durability mechanism, AC-175); the
 * DB stores only its sha256. Resolution degrades to null on any storage error
 * so an observer probe can never 500 the status route.
 *
 * Shape: `ktt_` + 32 random bytes base64url (43 chars). Deliberately NOT hex —
 * a bare 64-hex run is the raw-EVM-key shape the MCP custody guards ban from
 * tool output, and this token legitimately rides MCP results.
 */
import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { DbPool } from '../db/pool.js';

/** Token prefix — makes a leaked value greppable/identifiable (kysigned tracking token). */
export const TRACKING_TOKEN_PREFIX = 'ktt_';

/** 32 random bytes base64url under the ktt_ prefix; hash pairs with the raw. */
export function mintTrackingToken(): { raw: string; hash: string } {
  const raw = TRACKING_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { raw, hash: hashTrackingToken(raw) };
}

/** Deterministic hex sha256 of the raw token — the only form the DB ever sees. */
export function hashTrackingToken(raw: string): string {
  return bytesToHex(sha256(utf8ToBytes(raw)));
}

/** Persist the observer credential for an envelope. Stores ONLY the hash. */
export async function storeTrackingToken(pool: DbPool, envelopeId: string, rawToken: string): Promise<void> {
  await pool.query(
    `INSERT INTO envelope_tracking_tokens (envelope_id, token_hash) VALUES ($1, $2)
     ON CONFLICT (envelope_id) DO UPDATE SET token_hash = EXCLUDED.token_hash`,
    [envelopeId, hashTrackingToken(rawToken)],
  );
}

/**
 * Resolve a presented raw token to its envelope id, by hash. Null on wrong
 * prefix (no DB touch), unknown token, or ANY storage error (hardened like
 * resolveApiKey — the route answers 404/401, never 500).
 */
export async function resolveTrackingToken(pool: DbPool, rawToken: string): Promise<string | null> {
  if (!rawToken.startsWith(TRACKING_TOKEN_PREFIX)) return null;
  try {
    const res = await pool.query(
      `SELECT envelope_id FROM envelope_tracking_tokens WHERE token_hash = $1`,
      [hashTrackingToken(rawToken)],
    );
    const row = (res.rows as Array<{ envelope_id?: string }>)[0];
    return row?.envelope_id ?? null;
  } catch {
    return null;
  }
}
