/**
 * keys.json — the bundle's observed-DKIM-key record (F-8.1 embedded file).
 *
 * The verifier DKIM-verifies each `signer-<n>.eml` against this file offline
 * (F-10.3): for each signer it carries the public-key record observed from DNS at
 * receipt (F-6.7), when it was observed, and the archive cross-reference outcome
 * (archive.prove.email — the independent third party whose own DNS observation
 * backs the F-32.3 provenance gate and the F-32.4 signing-time-within-window join).
 *
 * Deterministic: signers in index order, fixed object-key order, 2-space JSON.
 */
import type { BundleSignerInput } from './types.js';

export interface KeysJsonKeyRecord {
  signer: number;
  domain: string;
  selector: string;
  /** The full DKIM TXT record value (`v=DKIM1; … p=…`), or null if unresolved. */
  record: string | null;
  /** ISO-8601 DNS observation time, or null. */
  observedAt: string | null;
  archive: {
    /** `archived` / `contributed` / `unavailable` / null. */
    status: string | null;
    source: string;
  };
}

export interface KeysJson {
  version: 1;
  keys: KeysJsonKeyRecord[];
}

/** Build the deterministic keys.json object for a bundle's signers. */
export function buildKeysJson(signers: BundleSignerInput[]): KeysJson {
  return {
    version: 1,
    keys: signers.map((s) => ({
      signer: s.index,
      domain: s.signingDomain,
      selector: s.selector,
      record: s.dkimKey ?? null,
      observedAt: s.dkimObservedAt ? s.dkimObservedAt.toISOString() : null,
      archive: { status: s.archiveStatus ?? null, source: 'archive.prove.email' },
    })),
  };
}

/** Serialize keys.json to deterministic UTF-8 bytes (2-space, trailing newline). */
export function keysJsonBytes(signers: BundleSignerInput[]): Uint8Array {
  const text = JSON.stringify(buildKeysJson(signers), null, 2) + '\n';
  return new TextEncoder().encode(text);
}
