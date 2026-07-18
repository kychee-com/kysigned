/**
 * signupGrant — new-account trial credit (F-13.4 / F-13.6 / F-13.7, Phase 25).
 *
 * Every new hosted account opens with a one-time grant of envelope credits so a
 * creator can run the full signing flow with no credit card (kysigned.com: 4
 * credits = $1.00). The grant fires at the FIRST magic-link-confirmed sign-in
 * (`handleAuthTokenExchange`) — clicking the link is the mailbox-control proof
 * (F-18.4), so no free credit exists before the email is confirmed.
 *
 * Eligibility (F-13.6) is enforced cheaply by reusing infrastructure already in
 * the tree:
 *   • once / dedupe — the grant is written via `creditUser` with
 *     source='signup_grant' and external_ref = the NORMALIZED inbox
 *     (`normalizeInbox`, the F-3.2a normalizer). The existing
 *     credit_ledger_idempotency UNIQUE(source, external_ref) then guarantees BOTH
 *     at-most-one grant per normalized address (AC-94 dedupe) and once-only
 *     across repeat sign-ins (AC-93). No new constraint is needed.
 *   • disabled — a 0 amount (the forker default; `signupGrantCredits` unset)
 *     short-circuits, so the public template never grants unless an operator
 *     opts in.
 *   • disposable domains — excluded in a follow-up gate (25.4).
 *
 * Granted credits are ordinary credits (F-13.7): same balance, same per-envelope
 * debit and void-refund, never expiring — fungible with purchased credit. The
 * caller treats this as best-effort: a grant failure must never break sign-in.
 */
import type { DbPool } from '../db/pool.js';
import { creditUser } from '../db/userCredits.js';
import { normalizeInbox } from './signerInboxGuard.js';
import { isDisposableEmailDomain } from './disposableDomains.js';

export interface SignupGrantConfig {
  /**
   * The grant amount in USD micros (`signupGrantCredits` × the flat envelope
   * cost). 0 disables the grant — the forker default, so the public template
   * never grants unless an operator sets it.
   */
  grantUsdMicros: bigint;
}

export type SignupGrantReason = 'granted' | 'disabled' | 'already_granted' | 'disposable_domain';

export interface SignupGrantOutcome {
  granted: boolean;
  reason: SignupGrantReason;
  /** The resulting balance when a credit op ran (granted or already_granted). */
  balanceUsdMicros?: bigint;
  /** The fresh grant's credit_ledger row id — the F-36.4 event key (no address). */
  ledgerId?: string;
}

/**
 * Grant the trial credit to `email` if eligible. Idempotent + deduped via the
 * normalized-inbox external_ref (see module docs). Returns the outcome; never
 * throws for an ordinary already-granted case (that is a clean no-op).
 */
export async function grantSignupCreditIfEligible(
  pool: DbPool,
  email: string,
  config: SignupGrantConfig,
): Promise<SignupGrantOutcome> {
  if (config.grantUsdMicros <= 0n) {
    return { granted: false, reason: 'disabled' };
  }

  // F-13.6c — disposable / throwaway domains get no freebie (the account is
  // still valid and may still purchase). Magic-link confirmation proves mailbox
  // control for real domains; this removes the throwaway-inbox farming vector.
  if (isDisposableEmailDomain(email)) {
    return { granted: false, reason: 'disposable_domain' };
  }

  const result = await creditUser(pool, {
    email,
    amountUsdMicros: config.grantUsdMicros,
    source: 'signup_grant',
    // Dedupe key: the normalized inbox, so alias / dot / case / googlemail
    // variants of an already-granted address collide on the UNIQUE and grant
    // nothing (AC-94). The same key makes repeat sign-ins idempotent (AC-93).
    externalRef: normalizeInbox(email),
    description: 'New-account trial credit (F-13.4)',
  });

  return {
    granted: !result.deduplicated,
    reason: result.deduplicated ? 'already_granted' : 'granted',
    balanceUsdMicros: result.balanceUsdMicros,
    ...(result.ledgerId !== undefined ? { ledgerId: result.ledgerId } : {}),
  };
}
