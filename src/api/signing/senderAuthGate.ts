/**
 * Sender-authentication gate — SPF + DMARC (F-6.2a / AC-62, spec v0.4.0).
 *
 * Cheap defense-in-depth ALONGSIDE the in-band DKIM crypto check (F-6.2). SES
 * computes SPF and DMARC verdicts at receipt and run402 surfaces them on the
 * `reply_received` event (run402-private #542). This gate returns the verdict;
 * whether a hard FAIL actually REJECTS is the caller's choice — `processForward`
 * consults it only when `enforceSenderAuth` is on (OPT-IN, default record-only,
 * `KYSIGNED_ENFORCE_SENDER_AUTH`). The verdicts are ALWAYS recorded (AC-62)
 * regardless. DMARC is the combination check (DKIM or SPF, with From-alignment,
 * under the domain's published policy), so a DMARC fail flags a spoofing attempt.
 *
 * **Honest scope (recorded in the spec):** SPF/DMARC are RECEIPT-TIME attestations
 * about the connecting IP / envelope — they are NOT message-intrinsic and cannot be
 * re-verified offline from the `.eml` decades later (only the DKIM signature can).
 * So this gate only HARDENS the anti-spoof decision; the verdicts are stored as
 * receipt metadata (audit trail), never as part of the Level-2 offline proof. We
 * therefore reject only an explicit `FAIL` — a `GRAY` / `PROCESSING_FAILED` /
 * absent verdict does not block (DKIM remains the authority), avoiding
 * over-rejection of legitimate signers whose receipt verdict was inconclusive.
 */

/** Raw SES receipt verdict statuses (PASS | FAIL | GRAY | PROCESSING_FAILED), as surfaced by run402. */
export interface ReceiptVerdicts {
  spf?: string | null;
  dkim?: string | null;
  dmarc?: string | null;
}

export type SenderAuthResult =
  | { ok: true }
  | {
      ok: false;
      /** Which receipt check hard-failed. */
      failed: 'spf' | 'dmarc';
      reason: 'spf_fail' | 'dmarc_fail';
      /** The raw verdict string (for the log + corrective notice). */
      verdict: string;
    };

function isFail(verdict: string | null | undefined): boolean {
  return String(verdict ?? '').trim().toUpperCase() === 'FAIL';
}

/**
 * Decide acceptance from the SES receipt verdicts. DMARC is checked first (the
 * authoritative combination verdict); SPF is the secondary signal. Only an
 * explicit FAIL rejects.
 */
export function evaluateSenderAuth(verdicts: ReceiptVerdicts): SenderAuthResult {
  if (isFail(verdicts.dmarc)) {
    return { ok: false, failed: 'dmarc', reason: 'dmarc_fail', verdict: String(verdicts.dmarc) };
  }
  if (isFail(verdicts.spf)) {
    return { ok: false, failed: 'spf', reason: 'spf_fail', verdict: String(verdicts.spf) };
  }
  return { ok: true };
}
