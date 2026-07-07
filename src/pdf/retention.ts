/**
 * Ephemeral PDF retention rule (spec F8.6).
 *
 * Pure function: given an envelope, its signers, and the current time, decide
 * whether the original PDF should be deleted now. The retention sweep wraps
 * this with the actual storage delete + DB update.
 *
 * Rules (in priority order):
 *
 *   1. Already deleted (pdf_deleted_at set)           → no-op (false)
 *   2. status in {voided, expired}                    → delete immediately
 *   3. status in {active, awaiting_seal}              → keep (signing in progress)
 *   4. status = completed AND ≥ 30 days since done    → delete (hard cap)
 *   5. status = completed AND any signer bounced
 *        AND ≥ 7 days since done                      → delete (bounce fallback)
 *   6. status = completed AND every signer's
 *        completion email is confirmed delivered      → delete (the happy path)
 *   7. otherwise (waiting on delivery confirmations)  → keep
 *
 * The "happy path" deletion typically fires within minutes-to-hours of completion,
 * not days, because completion emails are delivered fast and SES posts the
 * delivery webhook immediately.
 */
import type { Envelope, EnvelopeSigner } from '../db/types.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function shouldDeletePdf(
  envelope: Envelope,
  signers: EnvelopeSigner[],
  now: Date
): boolean {
  // 1. Already ephemerally deleted → no-op. (F-013: we do NOT gate on
  //    `pdf_storage_key` — that column is never written on create, so keying
  //    deletion off it made this always-false and blobs accumulated forever. The
  //    blob lives at deterministic keys derived from document_hash + signing_token,
  //    and the actual delete is idempotent at the storage layer.)
  if (envelope.pdf_deleted_at) return false;

  // 2. Voided / expired → delete immediately.
  if (envelope.status === 'voided' || envelope.status === 'expired') return true;

  // 3. Still collecting signatures / awaiting a manual seal → keep (the document
  //    and covers are still needed to finish the envelope).
  if (envelope.status === 'active' || envelope.status === 'awaiting_seal') return false;

  // status === 'completed' from here on.
  if (!envelope.completed_at) return false; // defensive: data inconsistency
  // F-014: `completed_at` is typed Date, but a caller reading raw DB rows (notably
  // the retention sweep's `SELECT *` scan) can hand us the production wire shape — an
  // ISO string from run402's HTTP DB, which has no `.getTime()`. Coerce defensively
  // so this pure decision never crashes regardless of how the row was loaded.
  // (`now` is always caller-constructed (`new Date()`), never DB-sourced, so it needs
  // no coercion.) `new Date(x)` is idempotent for a Date and parses an ISO string.
  const ageMs = now.getTime() - new Date(envelope.completed_at).getTime();

  // 4. Hard 30-day cap.
  if (ageMs >= THIRTY_DAYS_MS) return true;

  const anyBounced = signers.some((s) => s.completion_email_bounced_at !== null);
  const allDelivered =
    signers.length > 0 &&
    signers.every((s) => s.completion_email_delivered_at !== null);

  // 5. Bounce fallback: any bounce + 7-day grace expired.
  if (anyBounced && ageMs >= SEVEN_DAYS_MS) return true;

  // 6. Happy path: everyone confirmed delivered.
  if (allDelivered) return true;

  // 7. Still waiting.
  return false;
}
