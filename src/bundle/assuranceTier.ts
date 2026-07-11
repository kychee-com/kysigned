/**
 * assuranceTier (F-32.1, #137) — the verdict-tier model that replaces the
 * binary PROVEN. A per-signer verdict is FAILED or the highest satisfied tier:
 *
 *   INTEGRITY VERIFIED   — the offline math is internally valid (DKIM against
 *                          the embedded key, byte-exact reconstruction, intent,
 *                          ≥1 valid timestamp). What EVERY well-formed bundle
 *                          establishes — and the ceiling for a bundle whose key
 *                          provenance cannot be independently confirmed (the
 *                          #136 malicious-operator forgery caps here).
 *   PROVIDER KEY CONFIRMED — + independently verifiable provenance that the exact
 *                          (domain, selector, key bytes) was the provider's (F-32.3).
 *   PROVEN (DURABLE)     — + durable timestamp assurance (F-32.2) AND the
 *                          anchored signing time inside the key's authenticated
 *                          validity window (F-32.4). The long-term statement.
 *
 * Each evidence dimension carries its own state; the tier is what the confirmed
 * dimensions jointly support. `pending`/`inconclusive` cap the tier (never an
 * error, upgradeable); `failed` on any required check or dimension is a hard
 * FAILED (tampered/substituted evidence is never a mere downgrade — AC-154).
 *
 * Pure and dependency-free so the Node engine, the browser engine, the CLI, and
 * the independent toolkit all compute the identical tier (parity, AC-152/AC-107).
 */

export type AssuranceTier = 'FAILED' | 'INTEGRITY_VERIFIED' | 'PROVIDER_KEY_CONFIRMED' | 'PROVEN_DURABLE';

/** Per-dimension evidence state. `pending` = upgradeable (not yet confirmed, not an error). */
export type DimensionState = 'confirmed' | 'pending' | 'inconclusive' | 'failed';

/** The offline hard checks that gate INTEGRITY VERIFIED (Tier 1). All must hold. */
export interface HardChecks {
  dkim: boolean;
  attachment: boolean;
  intent: boolean;
  /** At least one timestamp proof validates against the exact artifact bytes. */
  timestamp: boolean;
}

/** The three evidence dimensions layered above integrity (F-32.2/F-32.3/F-32.4). */
export interface AssuranceDimensions {
  keyProvenance: DimensionState;
  timestampDurability: DimensionState;
  keyValidity: DimensionState;
}

/** Human-facing tier label (F-10.4). */
export const TIER_LABEL: Record<AssuranceTier, string> = {
  FAILED: 'FAILED',
  INTEGRITY_VERIFIED: 'INTEGRITY VERIFIED',
  PROVIDER_KEY_CONFIRMED: 'PROVIDER KEY CONFIRMED',
  PROVEN_DURABLE: 'PROVEN (DURABLE)',
};

/**
 * The verdict tier from the hard checks + the three dimension states.
 * FAILED wins on any broken hard check OR any dimension explicitly `failed`
 * (tampered/substituted assurance evidence — AC-154). Otherwise the tier climbs
 * only as far as the confirmed dimensions allow.
 */
export function computeSignerTier(hard: HardChecks, dims: AssuranceDimensions): AssuranceTier {
  if (!hard.dkim || !hard.attachment || !hard.intent || !hard.timestamp) return 'FAILED';
  if (dims.keyProvenance === 'failed' || dims.timestampDurability === 'failed' || dims.keyValidity === 'failed') {
    return 'FAILED';
  }
  // Tier 1 established. Provider-key provenance must be independently confirmed
  // to climb — live archive presence alone never suffices (DD-33).
  if (dims.keyProvenance !== 'confirmed') return 'INTEGRITY_VERIFIED';
  // Tier 3 needs BOTH durable timestamp assurance and an authenticated validity window.
  if (dims.timestampDurability === 'confirmed' && dims.keyValidity === 'confirmed') return 'PROVEN_DURABLE';
  return 'PROVIDER_KEY_CONFIRMED';
}

/**
 * Timestamp assurance policy (F-32.2, #138). The dual timestamps have
 * complementary weaknesses, so the model never accepts one alone for the
 * statement that needs both:
 *   - **durable** (→ `confirmed`): a Bitcoin-anchored OTS proof CONFIRMED in a
 *     real block AND a valid RFC-3161 token, both over the same artifact hash and
 *     with times that do not contradict.
 *   - **provisional / pending** (→ `pending`): a valid RFC-3161 token alone
 *     (immediate, TSA-dependent), or an OTS commitment not yet block-anchored.
 *   - **contradictory** (→ `inconclusive`): both legs verify but the TSA time is
 *     materially AFTER the Bitcoin block time (impossible for genuine evidence —
 *     you cannot anchor a document before it was timestamped).
 * (Absent/invalid timestamps never reach here: the hard `timestamp` check already
 * requires ≥1 valid proof, so a bundle with none is FAILED before tiering.)
 */
export const TIMESTAMP_CONTRADICTION_TOLERANCE_SEC = 24 * 60 * 60; // 24h clock-skew / calendar-batching allowance

export function classifyTimestampDurability(i: {
  tsrOk: boolean;
  bitcoinConfirmed: boolean;
  tsrTimeSec: number | null;
  bitcoinTimeSec: number | null;
}): DimensionState {
  if (i.bitcoinConfirmed && i.tsrOk) {
    if (
      i.tsrTimeSec != null &&
      i.bitcoinTimeSec != null &&
      i.tsrTimeSec > i.bitcoinTimeSec + TIMESTAMP_CONTRADICTION_TOLERANCE_SEC
    ) {
      return 'inconclusive'; // contradictory: TSA claims a time after the anchor that supposedly commits it
    }
    return 'confirmed'; // durable
  }
  return 'pending'; // provisional (TSA-only) or OTS-pending (not yet block-anchored)
}

/** The bundle-level tier: the WEAKEST signer's tier (FAILED if any signer failed / none present). */
export function computeBundleTier(signerTiers: AssuranceTier[]): AssuranceTier {
  if (signerTiers.length === 0) return 'FAILED';
  const order: AssuranceTier[] = ['FAILED', 'INTEGRITY_VERIFIED', 'PROVIDER_KEY_CONFIRMED', 'PROVEN_DURABLE'];
  return signerTiers.reduce((weakest, t) => (order.indexOf(t) < order.indexOf(weakest) ? t : weakest), 'PROVEN_DURABLE');
}
