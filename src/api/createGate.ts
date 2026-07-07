/**
 * F-3.1 / F-3.6 / F-13 — the envelope-creation gate (evidence-bundle model).
 *
 * This is the EARLY box that DEFINES the seams later phases implement:
 *   - the credit balance is read through an injected `getCreditBalance`
 *     callback; the local credit store + provider top-ups land in Phase 13.
 *   - the cookie-session 401 is enforced by the deployed Lambda's auth
 *     middleware (Phase 12); the handler still guards a missing identity here
 *     so the contract is testable in isolation.
 *
 * Verdict contract (AC-5):
 *   - no authenticated creator            -> 401
 *   - allowedCreators set & creator absent -> 403 (F-3.6 forker org-restriction)
 *   - balance below the per-envelope cost  -> 402 (F-13)
 *   - otherwise                            -> ok (handler proceeds to 201)
 *
 * Pricing is FLAT $0.25/envelope (F-13.1) — any number of signers, no
 * per-signer surcharge.
 */

/** F-13.1 — flat per-envelope price: $0.25 = 250_000 USD micros. */
export const DEFAULT_ENVELOPE_COST_USD_MICROS = 250_000;

/**
 * Format a USD-micros integer as a human "$0.25" string. The gate's error is
 * surfaced verbatim to the SPA, so it must read in dollars — raw micros
 * ("need 250000") confused creators (Barry QA 2026-06-16). Mirrors the
 * frontend `formatUsd` (lib/api.ts) cents-rounding so both agree.
 */
export function formatUsdMicros(micros: number): string {
  const cents = Math.round(micros / 10_000);
  return `$${(cents / 100).toFixed(2)}`;
}

export interface CreateGateContext {
  /** The authenticated creator identity (login email). */
  senderIdentity?: string;
  /**
   * Optional operator-config allowlist of creator identities (F-3.6). Empty or
   * absent = any authenticated, funded creator may create. Entries are matched
   * case-insensitively as exact emails, plus exact-domain wildcards like
   * `*@example.com`.
   */
  allowedCreators?: string[];
  /** Injected credit-balance read (USD micros); absent = credit check skipped. */
  getCreditBalance?: (senderIdentity: string) => Promise<number>;
  /** Flat per-envelope cost override (USD micros). Defaults to $0.25. */
  envelopeCostUsdMicros?: number;
  /** Signer count — accepted for callers, but cost is flat regardless (F-13.1). */
  signerCount?: number;
}

export interface GateVerdict {
  ok: boolean;
  /** Set when !ok — the HTTP status the create endpoint must return. */
  status?: 401 | 402 | 403;
  error?: string;
  /** Set when !ok — the stable machine-readable taxonomy code (F-30.3 / AC-137). */
  code?: 'auth_required' | 'auth_forbidden' | 'payment_required';
  /** The resolved per-envelope cost (USD micros) — what the handler debits. */
  cost: number;
}

export function allowedCreatorMatches(identity: string, rule: string): boolean {
  const normalizedIdentity = identity.trim().toLowerCase();
  const normalizedRule = rule.trim().toLowerCase();
  if (!normalizedIdentity || !normalizedRule) return false;
  if (normalizedRule.startsWith('*@')) {
    const domain = normalizedRule.slice(2);
    const identityDomain = normalizedIdentity.split('@')[1];
    return domain.length > 0 && identityDomain === domain;
  }
  return normalizedRule === normalizedIdentity;
}

export async function evaluateCreateGate(ctx: CreateGateContext): Promise<GateVerdict> {
  const cost = ctx.envelopeCostUsdMicros ?? DEFAULT_ENVELOPE_COST_USD_MICROS;

  // 401 — no authenticated creator (F-3.1). The Lambda enforces the session
  // upstream; this guards a missing/blank identity reaching the handler.
  const identity = ctx.senderIdentity?.trim();
  if (!identity) {
    return { ok: false, status: 401, error: 'Authentication required', code: 'auth_required', cost };
  }

  // 403 — optional allowedCreators allowlist (F-3.6). Empty/absent = allow any.
  if (ctx.allowedCreators && ctx.allowedCreators.length > 0) {
    const listed = ctx.allowedCreators.some((c) => allowedCreatorMatches(identity, c));
    if (!listed) {
      return { ok: false, status: 403, error: 'Creator not on the operator allowlist', code: 'auth_forbidden', cost };
    }
  }

  // 402 — insufficient envelope credit (F-13). Skipped when no credit seam is
  // wired (self-host default / unit tests).
  if (ctx.getCreditBalance) {
    const balance = await ctx.getCreditBalance(identity);
    if (balance < cost) {
      return {
        ok: false,
        status: 402,
        error: `Insufficient credit — your balance is ${formatUsdMicros(balance)}, but sending an envelope costs ${formatUsdMicros(cost)}.`,
        code: 'payment_required',
        cost,
      };
    }
  }

  return { ok: true, cost };
}
