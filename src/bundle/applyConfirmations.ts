/**
 * applyOnlineConfirmations (F-32 / AC-152) — folds the additive ONLINE checks
 * (Bitcoin anchor confirmation + key-archive provenance gate) into a verdict and
 * DETERMINISTICALLY recomputes every tier. Shared by the /verify page and the CLI
 * so both upgrade identically once the network confirmations land.
 *
 * It uses only verdict-carried facts, so it needs no re-verification: offline a
 * valid `checks.timestamp` means the RFC-3161 leg verified (the OTS/Bitcoin leg is
 * online-only) and `signingTimeSec` is the TSA time — so timestamp durability
 * recomputes correctly the moment the Bitcoin anchor confirms.
 *
 * The provenance gate (DD-33/DD-35): a `keyProvenance: 'failed'` (the archive
 * publishes a DIFFERENT key for that domain/selector) drives the signer to FAILED;
 * `confirmed` lifts it toward PROVIDER KEY CONFIRMED; `pending` leaves it capped at
 * INTEGRITY VERIFIED. Live archive presence never grants provenance on its own.
 */
import { computeSignerTier, computeBundleTier, classifyTimestampDurability } from './assuranceTier.js';
import { validityFromWindow } from './keyValidityWindow.js';
import type { BundleVerdict, BitcoinAnchor } from './verifyTypes.js';
import type { KeyArchiveConfirmation } from './confirmKeyArchive.js';

export interface OnlineConfirmations {
  bitcoin?: Record<number, BitcoinAnchor>;
  keyArchive?: Record<number, KeyArchiveConfirmation>;
}

export function applyOnlineConfirmations(verdict: BundleVerdict, c: OnlineConfirmations = {}): BundleVerdict {
  for (const s of verdict.signers) {
    const btc = c.bitcoin?.[s.index];
    if (btc) s.bitcoinAnchor = btc;

    const ka = c.keyArchive?.[s.index];
    if (ka) {
      s.checks.keyAuthenticity = ka.keyAuthenticity;
      s.keyObservedAt = ka.observedAt;
      s.assurance.keyProvenance = ka.keyProvenance;
      if (ka.keyProvenance === 'failed' && !s.reasons.some((r) => /provider key/i.test(r))) {
        s.reasons.push(
          'provider key mismatch: the public archive publishes a different key for this domain/selector (possible forgery)',
        );
      }
      // F-32.4 validity window — anchored signing time within the key's recorded lifetime (as-recorded semantics).
      s.assurance.keyValidity = validityFromWindow(s.signingTimeSec, ka.lastSeenAt, ka.keyProvenance);
    }

    // Recompute durability from the (possibly upgraded) Bitcoin anchor.
    s.assurance.timestampDurability = classifyTimestampDurability({
      tsrOk: s.checks.timestamp,
      bitcoinConfirmed: s.bitcoinAnchor.status === 'confirmed',
      tsrTimeSec: s.signingTimeSec,
      bitcoinTimeSec: s.bitcoinAnchor.timeSec ?? null,
    });

    s.tier = computeSignerTier(
      { dkim: s.checks.dkim, attachment: s.checks.attachment, intent: s.checks.intent, timestamp: s.checks.timestamp },
      s.assurance,
    );
    s.proven = s.tier !== 'FAILED';
  }

  const structurallySound =
    verdict.errors.length === 0 && verdict.fingerprint.matchesPrinted && verdict.signers.length > 0;
  verdict.tier = structurallySound ? computeBundleTier(verdict.signers.map((s) => s.tier)) : 'FAILED';
  verdict.proven = verdict.tier !== 'FAILED';
  return verdict;
}
