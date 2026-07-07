/**
 * Admin API — F2.8 management endpoints for allowed_senders.
 *
 * The library exposes pure handlers; the deploying service wires authentication
 * (e.g., static admin token, session cookie, or platform IAM) before calling them.
 */
import type { DbPool } from '../db/pool.js';
import {
  addAllowedSender,
  removeAllowedSender,
  listAllowedSenders,
  type IdentityType,
} from '../db/allowedSenders.js';

export interface AdminContext {
  pool: DbPool;
  operator: string; // identity of the human/system making the change (audit trail)
}

export interface AddAllowedSenderRequest {
  identity_type: IdentityType;
  identity: string;
  quota_per_month: number | null;
  note?: string | null;
}

const VALID_IDENTITY_TYPES: IdentityType[] = ['email', 'email_domain'];

export async function handleAddAllowedSender(ctx: AdminContext, req: AddAllowedSenderRequest) {
  if (!VALID_IDENTITY_TYPES.includes(req.identity_type)) {
    return { status: 400, body: { error: 'identity_type must be "email" or "email_domain"' } };
  }
  if (!req.identity || req.identity.trim() === '') {
    return { status: 400, body: { error: 'identity is required' } };
  }
  if (req.quota_per_month !== null && req.quota_per_month !== undefined && req.quota_per_month < 0) {
    return { status: 400, body: { error: 'quota_per_month must be >= 0 or null' } };
  }

  const row = await addAllowedSender(ctx.pool, {
    identity_type: req.identity_type,
    identity: req.identity,
    quota_per_month: req.quota_per_month ?? null,
    added_by: ctx.operator,
    note: req.note ?? null,
  });

  return { status: 201, body: row };
}

export async function handleRemoveAllowedSender(
  ctx: AdminContext,
  identity_type: IdentityType,
  identity: string
) {
  if (!VALID_IDENTITY_TYPES.includes(identity_type)) {
    return { status: 400, body: { error: 'identity_type must be "email" or "email_domain"' } };
  }
  const removed = await removeAllowedSender(ctx.pool, identity_type, identity);
  if (!removed) {
    return { status: 404, body: { error: 'Sender not found' } };
  }
  return { status: 200, body: { removed: true } };
}

export async function handleListAllowedSenders(ctx: AdminContext) {
  const rows = await listAllowedSenders(ctx.pool);
  return { status: 200, body: rows };
}
