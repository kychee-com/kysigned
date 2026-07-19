/**
 * attributionCapture — F-37 pending capture + bind-once (AC-206, DD-47).
 *
 * The server half of the paid-acquisition attribution rail. The magic link may
 * be opened on a different device than the ad click, so the browser's capture
 * rides the magic-link REQUEST (the email submit) and is persisted here as a
 * PENDING capture keyed by the normalized inbox (F-3.2a — the same key the
 * trial grant dedupes on). At account establishment — the first
 * magic-link-confirmed sign-in — `bindAttributionIfPending` stamps
 * `creator_attribution` exactly once:
 *
 *   • the EARLIEST unexpired (≤90d) pending capture wins (first-touch);
 *   • no unexpired capture → the stamp is written with a NULL gclid, so the
 *     account is ORGANIC FOREVER (a later ad click never rewrites acquisition
 *     truth);
 *   • the stamp is `ON CONFLICT DO NOTHING` — never overwritten;
 *   • pending rows are single-purpose and purged at establishment.
 *
 * Everything here is best-effort from the caller's perspective: auth handlers
 * wrap these calls so an attribution failure can never break a sign-in.
 */
import type { DbPool } from '../db/pool.js';
import { normalizeInbox } from './signerInboxGuard.js';

/** 90 days — Google's click-to-conversion window; the client twin lives in frontend/src/lib/attribution.ts. */
export const ATTRIBUTION_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Accept small client-clock skew on captured_at, nothing more. */
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

const GCLID_RE = /^[A-Za-z0-9_-]{1,512}$/;

export type AttributionConsent = 'granted' | 'denied' | null;

export interface AttributionSubmission {
  gclid: string;
  capturedAt: Date;
  consent: AttributionConsent;
}

export interface BoundAttribution {
  gclid: string;
  capturedAt: Date;
  consent: AttributionConsent;
}

export type BindOutcome = { bound: false } | { bound: true; attribution: BoundAttribution };

/**
 * Validate the rider from the magic-link body. Returns null on ANY defect —
 * the magic-link endpoint's anti-enumeration 200 contract means a bad rider
 * is silently dropped, never a 4xx.
 */
export function parseAttributionSubmission(value: unknown, now: Date): AttributionSubmission | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const gclid = record.gclid;
  if (typeof gclid !== 'string' || !GCLID_RE.test(gclid)) return null;
  const capturedAtRaw = record.captured_at;
  if (typeof capturedAtRaw !== 'string') return null;
  const capturedAtMs = Date.parse(capturedAtRaw);
  if (!Number.isFinite(capturedAtMs)) return null;
  const age = now.getTime() - capturedAtMs;
  // Dead on arrival (already outside the click window) or implausibly future.
  if (age > ATTRIBUTION_WINDOW_MS || age < -MAX_FUTURE_SKEW_MS) return null;
  const consent: AttributionConsent =
    record.consent === 'granted' || record.consent === 'denied' ? record.consent : null;
  return { gclid, capturedAt: new Date(capturedAtMs), consent };
}

/** Persist a pending capture (deduped per normalized email + gclid; first row keeps its captured_at). */
export async function recordAttributionCapture(
  pool: DbPool,
  email: string,
  submission: AttributionSubmission,
): Promise<void> {
  await pool.query(
    `INSERT INTO attribution_captures (normalized_email, gclid, captured_at, consent_state)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (normalized_email, gclid) DO NOTHING`,
    [normalizeInbox(email), submission.gclid, submission.capturedAt, submission.consent],
  );
}

/**
 * Stamp the account's establishment (once, ever). Returns `bound: true` with
 * the attribution ONLY when THIS call freshly stamped a non-null gclid — the
 * caller's signal to enqueue the sign-up conversion (65.4).
 */
export async function bindAttributionIfPending(
  pool: DbPool,
  email: string,
  now: Date = new Date(),
): Promise<BindOutcome> {
  const normalized = normalizeInbox(email);
  const windowFloor = new Date(now.getTime() - ATTRIBUTION_WINDOW_MS);

  const pending = await pool.query(
    `SELECT gclid, captured_at, consent_state
       FROM attribution_captures
      WHERE normalized_email = $1 AND captured_at >= $2
      ORDER BY captured_at ASC
      LIMIT 1`,
    [normalized, windowFloor],
  );
  const row = (pending.rows[0] ?? null) as
    | { gclid: string; captured_at: string | Date; consent_state: string | null }
    | null;

  // Stamp establishment exactly once — with the winning capture, or as
  // permanently-organic (NULL gclid) when none is bindable right now.
  const stamp = await pool.query(
    `INSERT INTO creator_attribution (normalized_email, gclid, captured_at, consent_state)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (normalized_email) DO NOTHING`,
    [
      normalized,
      row ? row.gclid : null,
      row ? new Date(row.captured_at as string) : null,
      row ? (row.consent_state === 'granted' || row.consent_state === 'denied' ? row.consent_state : null) : null,
    ],
  );

  // Pending rows are single-purpose: purge at establishment (and on every
  // later sign-in, which also clears junk posted after establishment).
  await pool.query(`DELETE FROM attribution_captures WHERE normalized_email = $1`, [normalized]);

  if (!row || (stamp.rowCount ?? 0) === 0) return { bound: false };
  return {
    bound: true,
    attribution: {
      gclid: row.gclid,
      capturedAt: new Date(row.captured_at as string),
      consent: row.consent_state === 'granted' || row.consent_state === 'denied' ? row.consent_state : null,
    },
  };
}

/** The bound attribution for an account — null for organic or never-established. */
export async function getCreatorAttribution(pool: DbPool, email: string): Promise<BoundAttribution | null> {
  const r = await pool.query(
    `SELECT gclid, captured_at, consent_state
       FROM creator_attribution
      WHERE normalized_email = $1`,
    [normalizeInbox(email)],
  );
  const row = (r.rows[0] ?? null) as
    | { gclid: string | null; captured_at: string | Date | null; consent_state: string | null }
    | null;
  if (!row || typeof row.gclid !== 'string' || row.gclid === '' || row.captured_at == null) return null;
  return {
    gclid: row.gclid,
    capturedAt: new Date(row.captured_at as string),
    consent: row.consent_state === 'granted' || row.consent_state === 'denied' ? row.consent_state : null,
  };
}
