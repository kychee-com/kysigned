/**
 * Shared verifier verdict types (F-10.3) — imported by BOTH the Node engine
 * (`verify.ts`, mailauth) and the browser engine (`verifyWeb.ts`, WebCrypto), so
 * the two produce the identical verdict shape and can be differential-tested. Pure
 * types (TimestampProof/VerifyResult are type-only imports), so importing this
 * pulls no runtime Node deps into the browser bundle.
 */
import type { TimestampProof, VerifyResult } from '../timestamp/contract.js';
import type { AssuranceTier, AssuranceDimensions } from './assuranceTier.js';

// Key-archive presence (F-10.7): `archive-confirmed` (green — the exact signing key
// is present in the public archive) or `pending-online` (grey — not yet checked /
// archive unreachable / offline). There is deliberately NO `failed`/red state: the
// key check is additive and never gates `proven` (DD-16 presence-not-window, DD-17).
export type KeyAuthStatus = 'archive-confirmed' | 'pending-online';

export type BitcoinAnchorStatus = 'confirmed' | 'pending' | 'absent';

/**
 * The OpenTimestamps Bitcoin anchor's status (F-10.6), surfaced distinctly from
 * the RFC-3161 TSA time. **Additive** — it NEVER affects `proven`. `confirmed` =
 * the `.ots` verifies against a real Bitcoin block; `pending` = a proof exists but
 * is not (yet) confirmed (calendar-only, offline, or — in the offline-first web
 * verifier — not checked until the user explicitly confirms); `absent` = no
 * OpenTimestamps proof for this signer.
 */
export interface BitcoinAnchor {
  status: BitcoinAnchorStatus;
  /** Bitcoin block height, when confirmed. */
  blockHeight?: number;
  /** Block time (Unix seconds), when confirmed. */
  timeSec?: number;
}

export interface SignerVerdict {
  index: number;
  /**
   * Backward-compatible integrity flag = the tier is INTEGRITY VERIFIED or
   * better (i.e. `tier !== 'FAILED'`). The honest, granular result is `tier`
   * + `assurance` (F-32.1); consumers that need to know provider-key vs durable
   * assurance MUST read those, not `proven`.
   */
  proven: boolean;
  /** F-32.1 assurance tier: FAILED / INTEGRITY_VERIFIED / PROVIDER_KEY_CONFIRMED / PROVEN_DURABLE. */
  tier: AssuranceTier;
  /** The three evidence dimensions behind the tier (key provenance, timestamp durability, key validity). */
  assurance: AssuranceDimensions;
  /** Signer email parsed from the `.eml` From header. */
  email: string | null;
  signingDomain: string | null;
  verbatimIntent: string | null;
  /** Proven signing time (Unix seconds) from the timestamp, when available. */
  signingTimeSec: number | null;
  /**
   * SHA-256 (hex) of the shared original document `A` this signer signed (F-10.9):
   * the `document-original.pdf` their reconstruction (`cover-<n> ++ document-original`)
   * is checked against. Identical across signers (one shared `document-original`);
   * `null` if the bundle has none. The attachment check (AC-71) is what binds the
   * signer to `A` — a reconstruction that does not resolve to `A` fails `attachment`.
   */
  originalDocSha256: string | null;
  checks: {
    dkim: boolean;
    attachment: boolean;
    intent: boolean;
    timestamp: boolean;
    keyAuthenticity: KeyAuthStatus;
  };
  /** OpenTimestamps Bitcoin anchor status (F-10.6) — additive, never gates `proven`. */
  bitcoinAnchor: BitcoinAnchor;
  /**
   * Archive observation/registration time (ISO-8601) for the signer's key (F-10.7),
   * set by the ONLINE key-archive confirmation when `checks.keyAuthenticity` becomes
   * `archive-confirmed`. Undefined offline (the offline engine never sets it).
   */
  keyObservedAt?: string | null;
  reasons: string[];
}

export interface BundleVerdict {
  /** Backward-compatible integrity flag = `tier !== 'FAILED'` (see SignerVerdict.proven). */
  proven: boolean;
  /** F-32.1 bundle tier = the WEAKEST signer's tier (FAILED if any signer failed). */
  tier: AssuranceTier;
  fingerprint: { computed: string; matchesPrinted: boolean };
  /**
   * SHA-256 (hex) of the shared original document `A` = `document-original.pdf`
   * (F-10.9). Every signer signed this same document (each reconstructs against it);
   * `null` if the bundle has no `document-original.pdf`.
   */
  originalDocSha256: string | null;
  signers: SignerVerdict[];
  errors: string[];
}

export interface VerifyBundleDeps {
  /** Verify a timestamp proof commits to a hash (default: real OTS/RFC providers). */
  verifyTimestamp?: (proof: TimestampProof, hash: Uint8Array) => Promise<VerifyResult>;
}
