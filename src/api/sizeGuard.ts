/**
 * F-3.5 — bundle-size guard (evidence-bundle model).
 *
 * Rejects an envelope at creation when the ESTIMATED completed bundle would
 * exceed the operator ceiling (default 15 MB decoded total). The completed
 * bundle embeds the canonical PDF once (`document-original.pdf`) plus, per
 * signer, the raw forwarded `.eml` — which re-encodes the canonical PDF as
 * base64 (~1.37x) inside MIME — plus its timestamps and a rendered signature
 * page; the binding real-world wall is recipient-MTA deliverability (~25 MB
 * encoded), so 15 MB raw keeps margin (F-3.5).
 *
 * The estimator is intentionally CONFIG-DRIVEN: the Phase-2 size spike measures
 * the real overhead-per-signer on actual provider transits and TUNES these
 * constants (Open-Q #3). The guard logic itself is final.
 */

const MiB = 1024 * 1024;

export interface SizeGuardConfig {
  /** Reject when the estimate exceeds this many bytes. Default 15 MiB (F-3.5). */
  ceilingBytes?: number;
  /** Cover-page bytes added to the source upload to form the canonical PDF. */
  coverOverheadBytes?: number;
  /** Base64 inflation of an attachment re-encoded inside a forwarded `.eml`. */
  base64Inflation?: number;
  /** Per-signer fixed overhead: MIME headers + TSA + OTS + signature page. */
  perSignerOverheadBytes?: number;
  /** Whole-bundle fixed overhead: keys.json + VERIFY-README + PDF container. */
  fixedOverheadBytes?: number;
}

export const SIZE_GUARD_DEFAULTS: Required<SizeGuardConfig> = {
  ceilingBytes: 15 * MiB,
  coverOverheadBytes: 25_000,
  base64Inflation: 1.37,
  perSignerOverheadBytes: 20_000,
  fixedOverheadBytes: 30_000,
};

export interface SizeEstimate {
  ok: boolean;
  documentBytes: number;
  signerCount: number;
  estimatedBundleBytes: number;
  ceilingBytes: number;
}

/**
 * Estimate the completed-bundle size and decide whether it fits the ceiling.
 * estimate = canonical + signers × (canonical × base64 + perSignerOverhead)
 *            + fixedOverhead,  where canonical = document + coverOverhead.
 */
export function estimateBundleSize(
  documentBytes: number,
  signerCount: number,
  config: SizeGuardConfig = {},
): SizeEstimate {
  const c = { ...SIZE_GUARD_DEFAULTS, ...config };
  const canonical = documentBytes + c.coverOverheadBytes;
  const perSigner = canonical * c.base64Inflation + c.perSignerOverheadBytes;
  const estimatedBundleBytes = Math.ceil(
    canonical + Math.max(0, signerCount) * perSigner + c.fixedOverheadBytes,
  );
  return {
    ok: estimatedBundleBytes <= c.ceilingBytes,
    documentBytes,
    signerCount,
    estimatedBundleBytes,
    ceilingBytes: c.ceilingBytes,
  };
}

/** Human-readable MB (1 decimal) for error copy. */
function mb(bytes: number): string {
  return `${(bytes / MiB).toFixed(1)} MB`;
}

/**
 * The rejection message naming all four AC-7 quantities: document size, signer
 * count, estimated bundle size, and the ceiling.
 */
export function sizeRejectionMessage(est: SizeEstimate): string {
  return (
    `Envelope too large: a ${mb(est.documentBytes)} document with ${est.signerCount} ` +
    `signer${est.signerCount === 1 ? '' : 's'} would produce an estimated ` +
    `${mb(est.estimatedBundleBytes)} signing record, over the ${mb(est.ceilingBytes)} limit. ` +
    `Reduce the document size or the number of signers.`
  );
}
