/**
 * apiKeyAuth — bearer creator API keys (spec F-30.1 / AC-131, DD-28).
 *
 * The `/v1` auth gate's SECOND mode: an `Authorization` header carrying a
 * `ksk_…` key resolves to the SAME creator principal a cookie session yields.
 * The raw key exists exactly once (in the mint response); the DB stores only
 * its sha256. Resolution is hardened like resolveSession: any throw degrades
 * to null so the gate answers 401, never 500 (spec F-12.1 / F-18.1).
 */
import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { DbPool } from '../../db/pool.js';
import { getApiKeyByHash, touchApiKeyLastUsed } from '../../db/apiKeys.js';

/** Key prefix — makes a leaked value greppable/identifiable (kysigned secret key). */
export const API_KEY_PREFIX = 'ksk_';

/** 32 random bytes hex-encoded under the ksk_ prefix; hash pairs with the raw. */
export function mintApiKey(): { raw: string; hash: string } {
  const raw = API_KEY_PREFIX + randomBytes(32).toString('hex');
  return { raw, hash: hashApiKey(raw) };
}

/** Deterministic hex sha256 of the raw key — the only form the DB ever sees. */
export function hashApiKey(raw: string): string {
  return bytesToHex(sha256(utf8ToBytes(raw)));
}

/**
 * Parse an Authorization header into a key CANDIDATE. `Bearer <key>` (scheme
 * case-insensitive) and a bare `<key>` are both accepted — the MCP passes
 * `KYSIGNED_AUTHORIZATION` verbatim, so both spellings occur in the wild.
 * Returns null ONLY when there is no attempt (missing/whitespace header);
 * present-but-garbage returns the candidate so the caller can reject it —
 * an explicit credential must win or fail, never silently fall back.
 */
export function extractBearerKey(header: string | null): string | null {
  if (header == null) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;
  const candidate = /^bearer\s+/i.test(trimmed) ? trimmed.replace(/^bearer\s+/i, '') : trimmed;
  const value = candidate.trim();
  return value === '' ? null : value;
}

export interface ApiKeyActor {
  email: string;
  keyId: string;
}

/**
 * Resolve an Authorization header to the key's creator, or null (→ the gate's
 * machine-readable 401). Filters revoked keys at the SQL layer; stamps
 * last_used_at best-effort (a stamp failure never fails auth).
 */
export async function resolveApiKey(pool: DbPool, header: string | null): Promise<ApiKeyActor | null> {
  const candidate = extractBearerKey(header);
  if (candidate === null) return null;
  // Wrong shape can never be a real key — no DB round-trip for it.
  if (!candidate.startsWith(API_KEY_PREFIX) || candidate.length < API_KEY_PREFIX.length + 32) return null;
  try {
    const row = await getApiKeyByHash(pool, hashApiKey(candidate));
    if (!row) return null;
    try {
      await touchApiKeyLastUsed(pool, row.id);
    } catch {
      /* best-effort — a failed stamp must not fail auth */
    }
    return { email: row.creator_email, keyId: row.id };
  } catch {
    // Same hardening as resolveSession: resolution errors degrade to "no auth".
    return null;
  }
}
