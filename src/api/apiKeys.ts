/**
 * API-key management handlers (spec F-30.1 / AC-132) — session-only surfaces.
 *
 * Mint is the ONE place the raw key ever appears; list returns metadata only;
 * revoke is owner-scoped and answers 404 for foreign/unknown ids alike (no
 * existence leak). The auth gate keeps these routes OUT of bearer scope — a
 * key cannot mint, list, or revoke keys (AC-131 privilege containment).
 */
import type { DbPool } from '../db/pool.js';
import { createApiKey, listApiKeysByCreator, revokeApiKey } from '../db/apiKeys.js';
import { mintApiKey } from './auth/apiKeyAuth.js';

export interface ApiKeysCtx {
  pool: DbPool;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

const LABEL_MAX = 100;

export async function handleMintApiKey(
  ctx: ApiKeysCtx,
  creatorEmail: string,
  body: Record<string, unknown>,
): Promise<HandlerResult> {
  const rawLabel = body.label;
  if (rawLabel !== undefined && rawLabel !== null && typeof rawLabel !== 'string') {
    return { status: 400, body: { error: 'label must be a string', code: 'validation_label' } };
  }
  const label = typeof rawLabel === 'string' ? rawLabel.trim() : null;
  if (label !== null && label.length > LABEL_MAX) {
    return { status: 400, body: { error: `label exceeds ${LABEL_MAX} characters`, code: 'validation_label' } };
  }

  const { raw, hash } = mintApiKey();
  const row = await createApiKey(ctx.pool, {
    creatorEmail,
    keyHash: hash,
    label: label === '' ? null : label,
  });
  // The raw key's ONLY appearance — it is not stored and cannot be re-fetched.
  return {
    status: 201,
    body: { id: row.id, key: raw, label: row.label, created_at: row.created_at },
  };
}

export async function handleListApiKeys(ctx: ApiKeysCtx, creatorEmail: string): Promise<HandlerResult> {
  const rows = await listApiKeysByCreator(ctx.pool, creatorEmail);
  return {
    status: 200,
    body: {
      keys: rows.map((r) => ({
        id: r.id,
        label: r.label,
        created_at: r.created_at,
        last_used_at: r.last_used_at,
        revoked_at: r.revoked_at,
      })),
    },
  };
}

export async function handleRevokeApiKey(
  ctx: ApiKeysCtx,
  creatorEmail: string,
  id: string,
): Promise<HandlerResult> {
  const revoked = await revokeApiKey(ctx.pool, id, creatorEmail);
  if (!revoked) return { status: 404, body: { error: 'API key not found', code: 'not_found' } };
  return { status: 200, body: { id, revoked: true } };
}
