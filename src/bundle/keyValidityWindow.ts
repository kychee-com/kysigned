/**
 * Key-validity window (F-32.4, #139) — the durable statement requires the anchored
 * signing time `T` to fall within the key's OBSERVED-LIVE-in-DNS interval from the
 * independent archive.
 *
 * The rule is the UPPER bound only: `T <= last-observed-live + grace`. A signature
 * anchored after the provider stopped serving that key in DNS cannot be genuine —
 * this is what defeats the retired-key / rotate-and-publish forgery (a real but
 * later-disclosed historical key, forged with a fresh timestamp).
 *
 * The LOWER bound (first-observed) is deliberately NOT required: kysigned
 * contributes the key to the archive at signing time, so first-observed ≈ `T`, and
 * requiring `T >= first-observed` would reject every genuine bundle (the exact trap
 * the earlier presence-only model was created to escape — DD-16 → DD-33/DD-35).
 *
 * Outside the window (or unknown) is `inconclusive` (caps below PROVEN (DURABLE)),
 * not `failed`: it denies the long-term claim without hard-rejecting a bundle over
 * an archive gap. Validity is only meaningful once provenance is confirmed.
 */
import type { DimensionState } from './assuranceTier.js';

/** Grace over last-observed-live: archive re-observation cadence + rotation/crawl lag. */
export const KEY_VALIDITY_GRACE_SEC = 90 * 24 * 60 * 60; // 90 days

export function validityFromWindow(
  signingTimeSec: number | null,
  lastSeenAtIso: string | null,
  keyProvenance: DimensionState,
): DimensionState {
  // Only meaningful once we know the key was the provider's (provenance confirmed).
  if (keyProvenance !== 'confirmed') return 'inconclusive';
  if (signingTimeSec == null || !lastSeenAtIso) return 'inconclusive';
  const lastSeenMs = Date.parse(lastSeenAtIso);
  if (Number.isNaN(lastSeenMs)) return 'inconclusive';
  const lastSeenSec = Math.floor(lastSeenMs / 1000);
  return signingTimeSec <= lastSeenSec + KEY_VALIDITY_GRACE_SEC ? 'confirmed' : 'inconclusive';
}
