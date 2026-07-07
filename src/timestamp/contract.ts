/**
 * timestamp-module — the TimestampProvider contract (the one swappable seam).
 *
 * Spec: the operator's timestamp-module spec (F-1).
 * One interface; interchangeable provider implementations (`ots`, `rfc3161`, a
 * forker's own, plus an in-memory `fake` for tests). A consumer stamps the
 * SHA-256 of its payload, persists the opaque proof, and later verifies it.
 */

/** Result of verifying a proof against ground truth (the chain / the TSA). */
export interface VerifyResult {
  /** The proof is valid for the given hash and resolved to a real attested time. */
  ok: boolean;
  /** Unix seconds of the attested time (0 when `!ok` or unknown). */
  timeSec: number;
  /** Human-readable anchor: a Bitcoin block id, a TSA identity, or '' when `!ok`. */
  anchor: string;
}

/** OTS proofs start `pending` and become `complete` after Bitcoin confirms; RFC 3161 is always `complete`. */
export type ProofStatus = 'pending' | 'complete';

/**
 * How a provider's time is anchored (AC-17 / AC-25) — so a consumer can present
 * each honestly: `bitcoin-math` trusts only Bitcoin + math; `trusted-third-party`
 * trusts a TSA + its CA; `fake` is for tests only.
 */
export type TrustModel = 'bitcoin-math' | 'trusted-third-party' | 'fake';

/**
 * Opaque, JSON-serializable timestamp proof. `data` is base64 of the raw provider
 * artifact (the `.ots` bytes for OTS, the DER `TimeStampResp` token for RFC 3161),
 * so the envelope survives JSON round-trips and storage unchanged.
 */
export interface TimestampProof {
  /** Id of the provider that produced (and can verify) this proof. */
  provider: string;
  /** Envelope schema version. */
  version: number;
  /** Lifecycle state of the proof. */
  status: ProofStatus;
  /** Base64 of the raw provider artifact. */
  data: string;
  /** Optional provider hints (e.g. calendar URLs for a pending OTS proof). */
  meta?: Record<string, unknown>;
}

export interface TimestampProvider {
  /** Stable provider id, e.g. 'ots' | 'rfc3161'. */
  readonly id: string;
  /** How this provider's time is anchored — labelled honestly (AC-17). */
  readonly trustModel?: TrustModel;
  /** Stamp a 32-byte hash; returns an opaque, serializable proof. */
  stamp(hash: Uint8Array): Promise<TimestampProof>;
  /** Verify a proof for the given 32-byte hash against ground truth. */
  verify(proof: TimestampProof, hash: Uint8Array): Promise<VerifyResult>;
  /** Optional: advance a pending proof toward complete (OTS calendar → Bitcoin). */
  upgrade?(proof: TimestampProof): Promise<TimestampProof>;
}

/** Current proof-envelope schema version. */
export const PROOF_VERSION = 1;

/** A verify result meaning "not valid" — the single canonical failure value. */
export const VERIFY_FAILED: VerifyResult = { ok: false, timeSec: 0, anchor: '' };

/**
 * Route a proof to the provider whose `id` matches `proof.provider` and verify it.
 * This is what makes providers interchangeable behind the contract: a consumer
 * holds a set of providers and never branches on which one made a given proof.
 * An unknown provider yields the canonical failure (never throws).
 */
export async function verifyWith(
  providers: readonly TimestampProvider[],
  proof: TimestampProof,
  hash: Uint8Array,
): Promise<VerifyResult> {
  const provider = providers.find((p) => p.id === proof.provider);
  if (!provider) return { ...VERIFY_FAILED };
  return provider.verify(proof, hash);
}
