/**
 * Sender gate — F2.8 default-deny enforcement for POST /v1/envelope.
 *
 * Two strategies:
 *   - 'allowlist' (self-hosted default): identity MUST be in allowed_senders
 *   - 'hosted':   identity may be in allowed_senders OR have a positive credit balance
 *
 * In both modes, if the identity is in allowed_senders and has a non-NULL
 * quota_per_month, the per-month usage counter is checked. Quota always wins
 * over credit balance — admins use it to cap individual senders explicitly.
 */
import type { DbPool } from '../db/pool.js';
import {
  getMatchingAllowedSender,
  getMonthlyUsage,
  type AllowedSender,
} from '../db/allowedSenders.js';

export type EnforcementStrategy = 'allowlist' | 'hosted';

export interface SenderGateInput {
  strategy: EnforcementStrategy;
  /** The runtime sender identity type — always 'email' (domains are matched implicitly). */
  identity_type: 'email';
  identity: string;
  period: string;            // "YYYY-MM" UTC
  creditBalance?: number;    // hosted strategy only
}

export interface SenderGateResult {
  allowed: boolean;
  reason?: string;
  /** When allowed via the allowlist, the matched entry (exact or domain). */
  matched?: AllowedSender;
}

export async function checkSenderAllowed(
  pool: DbPool,
  input: SenderGateInput
): Promise<SenderGateResult> {
  const allowEntry = await getMatchingAllowedSender(pool, input.identity_type, input.identity);

  if (allowEntry) {
    if (allowEntry.quota_per_month !== null) {
      // Quota is tracked against the matched entry — domain entries share a single counter,
      // exact-email entries have their own counter.
      const used = await getMonthlyUsage(
        pool,
        allowEntry.identity_type,
        allowEntry.identity,
        input.period
      );
      if (used >= allowEntry.quota_per_month) {
        return {
          allowed: false,
          reason: `Monthly quota reached (${used}/${allowEntry.quota_per_month}) for ${input.period}`,
          matched: allowEntry,
        };
      }
    }
    return { allowed: true, matched: allowEntry };
  }

  // Not on the allowlist.
  if (input.strategy === 'hosted' && (input.creditBalance ?? 0) > 0) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason:
      input.strategy === 'hosted'
        ? 'Sender not on the allowlist and has no credit balance'
        : 'Sender not on the allowlist (default-deny). Add this identity via the admin API.',
  };
}
