/**
 * Key-validity window (F-32.4, #139/#147) — the durable statement requires the
 * anchored signing time `T` to fall within the key's RECORDED lifetime interval
 * from the independent archive.
 *
 * The rule is the UPPER bound only: `T <= last-seen (as recorded) + grace`. A
 * signature anchored after the provider stopped serving that key in DNS cannot be
 * genuine — this is what defeats the retired-key / rotate-and-publish forgery (a
 * real but later-disclosed historical key, forged with a fresh timestamp).
 *
 * "As recorded" is a documented limitation (spec 0.44.0, DD-36): the archive's
 * public API does not label live-DNS vs archival (GCD-recovered) observations, so
 * the window consumes the recorded times regardless of source. If the archive ships
 * per-source semantics (upstream ask zkemail/archive#46), this tightens to live
 * observations only.
 *
 * The LOWER bound (first-observed) is deliberately NOT required: kysigned
 * contributes the key to the archive at signing time, so first-observed ≈ `T`, and
 * requiring `T >= first-observed` would reject every genuine bundle (the exact trap
 * the earlier presence-only model was created to escape — DD-16 → DD-33/DD-35).
 *
 * Before provenance is confirmed (offline / archive pending) validity is `pending`
 * (not yet checkable) — matching the timestamp-durability dimension so the three
 * surfaces label it identically. Once provenance IS confirmed, a signing time outside
 * the window (or unknown) is `inconclusive` (caps below PROVEN (DURABLE)), not `failed`:
 * it denies the long-term claim without hard-rejecting a bundle over an archive gap.
 */
import type { DimensionState } from './assuranceTier.js';

/** Grace over the recorded last-seen: archive re-observation cadence + rotation/crawl lag. */
export const KEY_VALIDITY_GRACE_SEC = 90 * 24 * 60 * 60; // 90 days

export function validityFromWindow(
  signingTimeSec: number | null,
  lastSeenAtIso: string | null,
  keyProvenance: DimensionState,
): DimensionState {
  // Not yet checkable until provenance is confirmed → `pending` (mirrors the durability
  // dimension's offline state so web/CLI/toolkit label it identically — F-020). The
  // `inconclusive` results below are reserved for a CHECKED-but-cannot-confirm window.
  if (keyProvenance !== 'confirmed') return 'pending';
  if (signingTimeSec == null || !lastSeenAtIso) return 'inconclusive';
  const lastSeenMs = Date.parse(lastSeenAtIso);
  if (Number.isNaN(lastSeenMs)) return 'inconclusive';
  const lastSeenSec = Math.floor(lastSeenMs / 1000);
  return signingTimeSec <= lastSeenSec + KEY_VALIDITY_GRACE_SEC ? 'confirmed' : 'inconclusive';
}
