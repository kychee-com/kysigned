/**
 * billingGate — F-13 `[service]` credit-gate activation.
 *
 * The create gate (`createGate.ts` / `evaluateCreateGate`, wired into
 * `envelope.ts`) enforces the 402-on-insufficient-credit (AC-5) ONLY when the
 * handler's `ApiContext` carries a `senderGate` with a `getCreditBalance` seam.
 * The PUBLIC forker app leaves it unwired and gates by the F-3.6 allowlist
 * instead (no service-to-user payment).
 *
 * kysigned.com — operator #1, the `[service]` deployment — sets
 * `KYSIGNED_BILLING=hosted`, which wires the seam to the kysigned-local credit
 * ledger (`userCredits`, F-13.5): balance reads, per-envelope debit (AC-33),
 * and void-before-signature refund (AC-49).
 *
 * The payment-provider TOP-UP that *funds* the ledger (checkout + webhook) is the
 * private `[service]` activation — its keys are kysigned.com-only secrets. This module
 * only reads/mutates the local balance that the top-up funds; it never touches any
 * payment provider.
 */
import type { DbPool } from '../db/pool.js';
import type { SenderGateConfig } from './envelope.js';
import { getCreditBalance, debitUser, creditUser } from '../db/userCredits.js';

/**
 * Hosted-billing mode token. Matches the legacy `senderGate` `'hosted'` strategy
 * (the kysigned.com credit-ledger model) — "this has not changed".
 */
export const HOSTED_BILLING_MODE = 'hosted';

/**
 * Build the credit-backed sender gate (hosted billing). Wires the three seams
 * `createGate`/`envelope.ts` consume against the local credit ledger. The
 * post-create debit and the void refund are best-effort: a ledger hiccup is
 * surfaced as `{ ok: false }` (logged by the caller) and never throws out of
 * create/void — the create gate already verified funds before assembly.
 */
export function buildHostedSenderGate(pool: DbPool, costUsdMicros: number): SenderGateConfig {
  return {
    costUsdMicros,
    getCreditBalance: async (identity) => Number(await getCreditBalance(pool, identity)),
    deductCredit: async (identity, amountUsdMicros, envelopeId) => {
      try {
        const r = await debitUser(pool, {
          email: identity,
          amountUsdMicros: BigInt(amountUsdMicros),
          envelopeId,
        });
        return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'debit_failed' };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'debit_failed' };
      }
    },
    refundCredit: async (identity, amountUsdMicros, envelopeId) => {
      try {
        await creditUser(pool, {
          email: identity,
          amountUsdMicros: BigInt(amountUsdMicros),
          source: 'refund',
          // Distinct from the `('envelope', envelopeId)` debit row, so the
          // ledger's UNIQUE(source, external_ref) idempotency lets debit + refund
          // coexist for the same envelope while still de-duping a double refund.
          externalRef: envelopeId,
          description: `Refund — voided unsigned envelope ${envelopeId}`,
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'refund_failed' };
      }
    },
  };
}

/**
 * Resolve the sender gate from the operator's billing mode. Returns the credit
 * gate for `KYSIGNED_BILLING=hosted` (case/whitespace-insensitive); `undefined`
 * for any other value — a forker leaves the credit seam unwired so `createGate`
 * skips the 402 check and falls back to the F-3.6 allowlist.
 */
export function resolveSenderGate(
  billingMode: string | undefined,
  pool: DbPool,
  costUsdMicros: number,
): SenderGateConfig | undefined {
  if ((billingMode ?? '').trim().toLowerCase() !== HOSTED_BILLING_MODE) return undefined;
  return buildHostedSenderGate(pool, costUsdMicros);
}
