/**
 * googleCeremonies — F-41's server-side ceremony row (DD-59), one per started
 * "Continue with Google".
 *
 * The OAuth callback can only hand the browser a URL hash, and a URL is the
 * wrong place for everything this flow needs to remember: the PKCE verifier
 * (secret), the pending-send handle (a capability), the attribution rider
 * (personal-adjacent), the link intent, and the funnel gate trigger. So all of
 * it lives HERE, in one short-TTL row, and run402's `client_state` carries only
 * the row's opaque id — which comes back in the hash on success AND failure
 * (`#code=…&state=<id>` / `#error=…&state=<id>`), letting the landing resume
 * either way without the URL ever holding secret material.
 *
 * Consumption is exactly-once by construction (the same single-winner UPDATE
 * pattern as the pending-send claim): the first exchange to arrive wins the
 * row, and a replayed callback, an expired ceremony, and an unknown id are all
 * indistinguishable — null. An id alone reads nothing a caller did not already
 * hold (F-40.6 parity), because consuming it only pays off inside the exchange,
 * which still has to win the run402 code exchange with the verifier stored here.
 *
 * PKCE (RFC 7636, S256): the verifier never leaves the server; run402's start
 * gets the derived challenge and its token exchange gets the verifier back.
 */
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { DbPool } from './pool.js';

/** Matches run402's own OAuth transaction window (`expires_in: 600`, read at
 *  414cc643) — a shorter row would kill valid callbacks mid-ceremony. */
export const GOOGLE_CEREMONY_TTL_MS = 10 * 60 * 1000;

/** RFC 7636 §4.1 — 32 random bytes → 43 base64url chars. */
export function mintPkceVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** RFC 7636 §4.2 — S256: base64url(sha256(ascii(verifier))). */
export function pkceChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export interface GoogleCeremonyFields {
  pkceVerifier: string;
  /** The pending-send handle (`<id>.<secret>`) a send-gate ceremony carries. */
  draftHandle?: string;
  /** The F-37 attribution submission captured in the STARTING browser. */
  gclid?: unknown;
  /** Set on a Connect-Google (link) ceremony: the initiating session's address. */
  linkEmail?: string;
  /** The F-38.3 gate-trigger value ('direct' | 'redirect' | 'send'). */
  gateTrigger?: string;
}

export interface GoogleCeremonyRecord extends GoogleCeremonyFields {
  id: string;
  gclid: unknown | null;
  draftHandle: string | undefined;
  linkEmail: string | undefined;
  gateTrigger: string | undefined;
  createdAt: Date;
  expiresAt: Date;
}

interface Row {
  id: string;
  pkce_verifier: string;
  draft_handle: string | null;
  gclid: unknown;
  link_email: string | null;
  gate_trigger: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

function toRecord(row: Row): GoogleCeremonyRecord {
  // The HTTP DB layer may hand JSONB back as an object or as its text form.
  let gclid: unknown = row.gclid ?? null;
  if (typeof gclid === 'string') {
    try {
      gclid = JSON.parse(gclid);
    } catch {
      gclid = null;
    }
  }
  return {
    id: row.id,
    pkceVerifier: row.pkce_verifier,
    draftHandle: row.draft_handle ?? undefined,
    gclid,
    linkEmail: row.link_email ?? undefined,
    gateTrigger: row.gate_trigger ?? undefined,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
  };
}

/** Returns the opaque ceremony id — the ONLY thing that rides `client_state`. */
export async function createGoogleCeremony(
  pool: DbPool,
  fields: GoogleCeremonyFields,
  opts: { now?: Date; id?: string } = {},
): Promise<string> {
  const now = opts.now ?? new Date();
  const id = opts.id ?? `gc_${randomUUID()}`;
  await pool.query(
    `INSERT INTO google_signin_ceremonies
       (id, pkce_verifier, draft_handle, gclid, link_email, gate_trigger, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [
      id,
      fields.pkceVerifier,
      fields.draftHandle ?? null,
      fields.gclid === undefined ? null : JSON.stringify(fields.gclid),
      fields.linkEmail ? fields.linkEmail.trim().toLowerCase() : null,
      fields.gateTrigger ?? null,
      new Date(now.getTime() + GOOGLE_CEREMONY_TTL_MS).toISOString(),
    ],
  );
  return id;
}

/**
 * Single-winner consumption: the WHERE clause decides — unconsumed AND
 * unexpired — and every loser (replay, expiry, unknown id) reads null, so the
 * exchange has exactly one honest failure to map (the F-40.3-grade plain one).
 */
export async function consumeGoogleCeremony(
  pool: DbPool,
  id: string,
  opts: { now?: Date } = {},
): Promise<GoogleCeremonyRecord | null> {
  const now = opts.now ?? new Date();
  const result = await pool.query(
    `UPDATE google_signin_ceremonies
        SET consumed_at = $2
      WHERE id = $1
        AND consumed_at IS NULL
        AND expires_at > $2
      RETURNING id, pkce_verifier, draft_handle, gclid, link_email, gate_trigger,
                created_at, expires_at, consumed_at`,
    [id, now.toISOString()],
  );
  if (result.rows.length === 0) return null;
  return toRecord(result.rows[0] as Row);
}

/** The reaper: consumed or expired rows have served their purpose — gone. */
export async function deleteFinishedGoogleCeremonies(pool: DbPool, now: Date = new Date()): Promise<number> {
  const result = await pool.query(
    `DELETE FROM google_signin_ceremonies
      WHERE consumed_at IS NOT NULL OR expires_at <= $1`,
    [now.toISOString()],
  );
  return result.rowCount ?? 0;
}
