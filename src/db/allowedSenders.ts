import type { DbPool } from './pool.js';

/**
 * Identity types for the allowed_senders table.
 *   - 'email':        single email address
 *   - 'email_domain': any email under this domain (e.g. "kychee.com" allows "*@kychee.com").
 *                     Subdomains are NOT matched implicitly — admins must add them explicitly.
 */
export type IdentityType = 'email' | 'email_domain';

export interface AllowedSender {
  id: string;
  identity_type: IdentityType;
  identity: string;
  quota_per_month: number | null;
  added_by: string;
  note: string | null;
  added_at: Date;
}

export interface AddAllowedSenderInput {
  identity_type: IdentityType;
  identity: string;
  quota_per_month: number | null;
  added_by: string;
  note?: string | null;
}

function normalize(identity: string): string {
  return identity.trim().toLowerCase();
}

/** Strip leading "@" or "." so admins can paste "@kychee.com" or "kychee.com" interchangeably. */
function normalizeDomain(domain: string): string {
  return normalize(domain).replace(/^[@.]+/, '');
}

function normalizeFor(type: IdentityType, identity: string): string {
  return type === 'email_domain' ? normalizeDomain(identity) : normalize(identity);
}

export async function addAllowedSender(
  pool: DbPool,
  input: AddAllowedSenderInput
): Promise<AllowedSender> {
  const result = await pool.query(
    `INSERT INTO allowed_senders (identity_type, identity, quota_per_month, added_by, note)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (identity_type, identity) DO UPDATE
       SET quota_per_month = EXCLUDED.quota_per_month,
           added_by = EXCLUDED.added_by,
           note = EXCLUDED.note
     RETURNING *`,
    [
      input.identity_type,
      normalizeFor(input.identity_type, input.identity),
      input.quota_per_month,
      input.added_by,
      input.note ?? null,
    ]
  );
  return result.rows[0] as AllowedSender;
}

export async function removeAllowedSender(
  pool: DbPool,
  identity_type: IdentityType,
  identity: string
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM allowed_senders WHERE identity_type = $1 AND identity = $2 RETURNING *`,
    [identity_type, normalizeFor(identity_type, identity)]
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

export async function listAllowedSenders(pool: DbPool): Promise<AllowedSender[]> {
  const result = await pool.query(`SELECT * FROM allowed_senders ORDER BY identity ASC`);
  return result.rows as AllowedSender[];
}

export async function getAllowedSender(
  pool: DbPool,
  identity_type: IdentityType,
  identity: string
): Promise<AllowedSender | null> {
  const result = await pool.query(
    `SELECT * FROM allowed_senders WHERE identity_type = $1 AND identity = $2`,
    [identity_type, normalizeFor(identity_type, identity)]
  );
  return (result.rows[0] as AllowedSender) ?? null;
}

/**
 * Resolve an incoming sender (an email) against the allowlist with domain
 * fallback: prefers an exact email entry; if none, falls back to a matching
 * 'email_domain' entry. Per-sender exact entries always win so admins can
 * carve out individual quotas/exclusions inside an otherwise-allowed domain.
 */
export async function getMatchingAllowedSender(
  pool: DbPool,
  _identity_type: 'email',
  identity: string
): Promise<AllowedSender | null> {
  // Single query that returns the exact email row OR the domain row.
  const email = normalize(identity);
  const domain = email.split('@')[1] ?? '';
  const result = await pool.query(
    `SELECT * FROM allowed_senders
     WHERE (identity_type = 'email'        AND identity = $1)
        OR (identity_type = 'email_domain' AND identity = $2)
     ORDER BY CASE identity_type WHEN 'email' THEN 0 ELSE 1 END
     LIMIT 1`,
    [email, domain]
  );
  return (result.rows[0] as AllowedSender) ?? null;
}

export async function isAllowedSender(
  pool: DbPool,
  identity_type: 'email',
  identity: string
): Promise<boolean> {
  const row = await getMatchingAllowedSender(pool, identity_type, identity);
  return row !== null;
}

/** Period format: "YYYY-MM" (UTC). */
export function currentPeriod(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export async function incrementMonthlyUsage(
  pool: DbPool,
  identity_type: IdentityType,
  identity: string,
  period: string
): Promise<void> {
  await pool.query(
    `INSERT INTO allowed_sender_usage (identity_type, identity, period, count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (identity_type, identity, period) DO UPDATE
       SET count = allowed_sender_usage.count + 1`,
    [identity_type, normalizeFor(identity_type, identity), period]
  );
}

export async function getMonthlyUsage(
  pool: DbPool,
  identity_type: IdentityType,
  identity: string,
  period: string
): Promise<number> {
  const result = await pool.query(
    `SELECT count FROM allowed_sender_usage
     WHERE identity_type = $1 AND identity = $2 AND period = $3`,
    [identity_type, normalizeFor(identity_type, identity), period]
  );
  if (result.rows.length === 0) return 0;
  return parseInt((result.rows[0] as { count: string }).count, 10);
}
