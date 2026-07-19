/**
 * testReset — test-only purge of a single identity across the four account
 * tables so a fresh trial grant (F-13.4) can re-fire. Backs the F-28
 * test-account reset endpoint; NEVER reachable without KYSIGNED_TEST_RESET_SECRET.
 *
 * Identity match is trim+lowercase (matching userCredits.normalizeEmail) — the
 * exact form the email/sender_email columns are stored under. NOT normalizeInbox
 * (whose gmail-dot / +tag stripping would fail to match stored rows). The
 * signup_grant ledger row is caught by its `email` column, which re-opens the
 * one-grant-per-normalized-email trap (F-13.6). envelope_signers are removed by the
 * ON DELETE CASCADE FK on envelopes; signature_artifacts is NOT cascaded, so it is
 * deleted FIRST (scoped to the identity's envelopes) or the envelope delete would
 * FK-fail for any identity that has a completed/signed envelope.
 */
import type { DbPool } from './pool.js';
import { normalizeInbox } from '../api/signerInboxGuard.js';

export interface ResetReport {
  identity: string;
  signatureArtifactsDeleted: number;
  envelopesDeleted: number;
  authSessionsDeleted: number;
  userCreditsDeleted: number;
  creditLedgerDeleted: number;
  /** F-37 — pending captures + the establishment stamp (keyed by normalizeInbox). */
  attributionCapturesDeleted: number;
  creatorAttributionDeleted: number;
}

function normalizeIdentity(email: string): string {
  return email.trim().toLowerCase();
}

export async function resetTestAccount(pool: DbPool, email: string): Promise<ResetReport> {
  const identity = normalizeIdentity(email);
  // signature_artifacts references envelopes(id) with NO ON DELETE CASCADE, so it MUST be
  // deleted before the envelopes (scoped to the identity's own envelopes) — otherwise the
  // envelope delete FK-fails for any identity that has a completed/signed envelope.
  const art = await pool.query(
    `DELETE FROM signature_artifacts WHERE envelope_id IN (SELECT id FROM envelopes WHERE sender_email = $1)`,
    [identity],
  );
  const env = await pool.query(`DELETE FROM envelopes WHERE sender_email = $1`, [identity]);
  const sess = await pool.query(`DELETE FROM auth_sessions WHERE email = $1`, [identity]);
  const cred = await pool.query(`DELETE FROM user_credits WHERE email = $1`, [identity]);
  const ledg = await pool.query(`DELETE FROM credit_ledger WHERE email = $1`, [identity]);
  // F-37 — attribution rows key by the NORMALIZED inbox (normalizeInbox — the
  // same F-3.2a form the capture/bind DAO writes), NOT the trim+lowercase form
  // above: a dotted/+tagged sign-in variant must still purge its rows so a
  // reset identity re-establishes fresh (organic or newly-attributed).
  const inbox = normalizeInbox(identity);
  const capt = await pool.query(`DELETE FROM attribution_captures WHERE normalized_email = $1`, [inbox]);
  const attr = await pool.query(`DELETE FROM creator_attribution WHERE normalized_email = $1`, [inbox]);
  return {
    identity,
    signatureArtifactsDeleted: art.rowCount ?? 0,
    envelopesDeleted: env.rowCount ?? 0,
    authSessionsDeleted: sess.rowCount ?? 0,
    userCreditsDeleted: cred.rowCount ?? 0,
    creditLedgerDeleted: ledg.rowCount ?? 0,
    attributionCapturesDeleted: capt.rowCount ?? 0,
    creatorAttributionDeleted: attr.rowCount ?? 0,
  };
}
