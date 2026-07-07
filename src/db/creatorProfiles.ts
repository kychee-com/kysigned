/**
 * creatorProfiles — the envelope creator's saved name (spec F1.11 / DD-97).
 *
 * Surface D (DD-97): when an envelope creator ticks "Will you also sign?",
 * kysigned prefills their signer row's name from a value saved on their OWN
 * account. This is the CREATOR's own name (our customer) — NOT a store of
 * signer/recipient names ([[feedback_kysigned_role_terminology]]). We already
 * have the creator's email from sign-in; the only new datum is their name.
 *
 * One row per creator account, keyed by the normalized (lowercased) login
 * email. Migration 014 ships the schema. Written at envelope-send
 * (`handleCreateEnvelope`, the name the creator used for themselves) and read
 * by `GET /v1/auth/user` to prefill the creator's row. The live input always
 * wins — this is a convenience default only (F1.11).
 */
import type { DbPool } from './pool.js';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The creator's saved name, or null if they have none yet. Keyed by their
 * normalized login email.
 */
export async function getCreatorName(pool: DbPool, email: string): Promise<string | null> {
  const normalized = normalizeEmail(email);
  const result = await pool.query(
    `SELECT display_name FROM creator_profiles WHERE account_email = $1`,
    [normalized],
  );
  if (result.rows.length === 0) return null;
  return (result.rows[0] as { display_name: string }).display_name;
}

/**
 * Save (insert-or-overwrite) the creator's name for their account. A later
 * call for the same account replaces the prior value — the typo-fix path.
 */
export async function upsertCreatorName(pool: DbPool, email: string, name: string): Promise<void> {
  const normalized = normalizeEmail(email);
  await pool.query(
    `INSERT INTO creator_profiles (account_email, display_name, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (account_email)
     DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()`,
    [normalized, name],
  );
}
