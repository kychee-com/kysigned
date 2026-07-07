/**
 * Evidence-bundle assembly types (F-8, spec v0.4.0).
 *
 * The bundle assembler is a PURE function over fully-resolved inputs: the
 * canonical PDF bytes, each signer's byte-complete raw `.eml`, and the signature
 * artifact's DKIM/timestamp/archive fields. Resolving those from the DB + run402's
 * inbound store + the blob store is the caller's job (Phase 10 distribution /
 * Phase 14 wiring) — keeping assembly offline-deterministic and unit-testable.
 */
import type { TimestampProof } from '../timestamp/contract.js';

/** One signer's resolved evidence for the bundle. */
export interface BundleSignerInput {
  /** 1-based stable position (signing order) — drives signer-<n> file names. */
  index: number;
  /** Name as claimed (creator-supplied, or the email when blank) — F-22.1. */
  name: string;
  email: string;
  /** Organisation the signer declared signing on behalf of, or null — F-22.2. */
  onBehalfOf?: string | null;
  /** d= of the accepted DKIM signature (the provider domain). */
  signingDomain: string;
  /** s= selector of the accepted DKIM signature. */
  selector: string;
  /** When the signature was recorded (rendered as the signing time). */
  signedAt: Date;
  /** SHA-256 (64-hex) of the raw `.eml` — must re-hash to this in the bundle. */
  emlSha256: string;
  /** Byte-complete raw provider-signed forward (F-8.3 — never re-encoded). */
  rawEml: Uint8Array;
  /**
   * Family B (DD-9): this signer's per-signer cover page bytes → `cover-<n>.pdf`.
   * Embedded so the verifier can reconstruct `P_i = cover-<n> ++ document-original.pdf`
   * and byte-match it to the `.eml`'s attachment (F-10.3). Regenerated
   * deterministically by the caller from the signer fields + envelope metadata.
   */
  cover: Uint8Array;
  /** Observed DKIM public-key record (`v=DKIM1; … p=…`), or null. */
  dkimKey?: string | null;
  /** When the key was read from DNS, or null. */
  dkimObservedAt?: Date | null;
  /** Archive cross-reference outcome (`archived` / `contributed` / …), or null. */
  archiveStatus?: string | null;
  /** OpenTimestamps proof → `proofs/signer-<n>.ots` (omit/null if absent). */
  otsProof?: TimestampProof | null;
  /** RFC 3161 token → `proofs/signer-<n>.tsr` (omit/null if absent). */
  tsaToken?: TimestampProof | null;
  /** SES receipt verdicts (receipt-time metadata, AC-62). */
  verdicts?: { spf?: string; dkim?: string; dmarc?: string };
}

export interface BundleEnvelopeInput {
  id: string;
  documentName: string;
  /** H_D — SHA-256 of the shared document D (Family B docHash, F-3.3). */
  documentHash: string;
  /** Envelope creator's email (Sender in user-facing language). */
  creatorEmail: string;
  /** Completion time — pinned into the bundle's deterministic metadata. */
  completedAt: Date;
}

export interface AssembleBundleInput {
  envelope: BundleEnvelopeInput;
  /**
   * The SHARED document D bytes → `document-original.pdf` (Family B: the document
   * WITHOUT any cover; each signer's cover is embedded separately as `cover-<n>.pdf`,
   * and `P_i = cover-<n> ++ document-original.pdf` is reconstructible).
   */
  documentOriginal: Uint8Array;
  /** Signed signers in stable order. */
  signers: BundleSignerInput[];
  /** Verifier apex (e.g. `https://kysigned.com`) — the signature-page QR + URL. */
  verifierBaseUrl: string;
}

/** One embedded file in the bundle (F-8.1 — the five embedded-file classes). */
export interface EmbeddedFile {
  /** In-bundle path/name, e.g. `document-original.pdf`, `proofs/signer-1.ots`. */
  path: string;
  bytes: Uint8Array;
  mimeType: string;
  /**
   * Whether this file is part of the F-8.2 fingerprint evidence set. True for the
   * document, the `.eml`s, the `proofs/` files, and `keys.json`; false ONLY for
   * `VERIFY-README.txt` (a static doc, not evidence).
   */
  inFingerprint: boolean;
}

export interface AssembledBundle {
  /** The complete bundle PDF bytes (no signature dictionary — F-8.2 / AC-63). */
  bytes: Uint8Array;
  /** SHA-256 (64-hex) over the embedded evidence set, in F-8.4 order (F-8.2). */
  fingerprint: string;
  /** The ordered embedded-file set (five classes). */
  manifest: EmbeddedFile[];
}
