/**
 * Online DKIM key-archive PRESENCE confirmation (F-10.7 / AC-101 / AC-102) — the
 * /verify page's auto-online key check, mirroring `confirmBitcoin`. Given a signer's
 * `(domain, selector, key)` it looks the key up in the public DKIM archive
 * (archive.prove.email, via the proven `lookupArchivedKey` client) and reports
 * `archive-confirmed` (the EXACT key is present, with its registration time) or
 * `pending-online` (absent, or the archive is unreachable / offline).
 *
 * Additive + DD-17: the real archive lookup is the DEFAULT (global `fetch`, default
 * base URL) — "no deps" runs the real check; tests inject a fake fetch. It NEVER
 * throws and NEVER gates the PROVEN verdict; there is no failed/red key state.
 * Browser-safe (the archive client is fetch-only; the bundle extractor is isomorphic).
 */
import {
  lookupArchivedKey,
  extractPublicKey,
  liveLastSeenAt,
  type DkimArchiveDeps,
} from '../api/signing/dkimArchive.js';
import { extractEmbeddedFileMapWeb } from './extractWeb.js';
import { signerIndices } from './evidenceOrder.js';
import { confirmStatementsOffline } from './statementProvenance.js';
import type { KeysJson } from './keysJson.js';
import type { KeyAuthStatus } from './verifyTypes.js';
import type { DimensionState } from './assuranceTier.js';

export type ConfirmKeyArchiveDeps = DkimArchiveDeps & {
  /** F-32.9 test override; unset = the pinned production statement JWKS. */
  statementJwks?: import('./archiveStatement.js').ArchiveJwks;
};

export interface KeyArchiveConfirmation {
  /** `archive-confirmed` = the exact key is present in the public archive; else `pending-online`. */
  keyAuthenticity: KeyAuthStatus;
  /**
   * The F-32.3 provider-key provenance GATE result (DD-33/DD-35):
   *   - `confirmed`: the archive holds the EXACT `(domain, selector, key)` (independent DNS observation);
   *   - `failed`: the archive holds record(s) for that exact `(domain, selector)` but a DIFFERENT key —
   *     the bundle's key contradicts what the provider actually published (a forgery signal);
   *   - `pending`: no record for that `(domain, selector)`, the archive is unreachable/offline, or no
   *     embedded key to compare (never a failure on mere absence/unreachability).
   */
  keyProvenance: DimensionState;
  /** The archive's observation/registration time (ISO-8601), when confirmed; else null. */
  observedAt: string | null;
  /**
   * The key's last-observed-LIVE time (F-32.4 validity window, live-DNS channel
   * only — #147-A, spec 0.71.0): from the embedded signed statement when one
   * confirmed, else the live API's `live_dns` observations. Null when the archive
   * knows the pair only through key recovery (no usable live window).
   */
  lastSeenAt: string | null;
}

const PENDING: KeyArchiveConfirmation = {
  keyAuthenticity: 'pending-online',
  keyProvenance: 'pending',
  observedAt: null,
  lastSeenAt: null,
};

// extractPublicKey lives in dkimArchive.ts — ONE canonical comparison shared with the
// receipt-time parity check (confirmKeyAtSigning), per F-32.6/DD-36.

/**
 * Confirm ONE signer's key against the public archive. Returns `archive-confirmed`
 * (with the registration time) iff the archive holds the EXACT key for
 * `(domain, selector)`; otherwise `pending-online`. Never throws.
 */
export async function confirmKeyArchive(
  domain: string,
  selector: string,
  expectedKey: string | null,
  deps: ConfirmKeyArchiveDeps = {},
): Promise<KeyArchiveConfirmation> {
  const want = extractPublicKey(expectedKey);
  if (!want) return PENDING; // no embedded key to compare against → cannot confirm
  try {
    const { found, records } = await lookupArchivedKey(domain, selector, deps);
    if (!found) return PENDING; // nothing archived for this (domain, selector) yet
    // Require the EXACT key (the archive may hold an older/rotated key at the same
    // selector); comparing the `p=` public key never yields a false confirm.
    const match = records.find((r) => extractPublicKey(r.value) === want);
    if (match) {
      return {
        keyAuthenticity: 'archive-confirmed',
        keyProvenance: 'confirmed',
        observedAt: match.firstSeenAt ?? match.lastSeenAt ?? null,
        // Live-only window input (#147-A): the live_dns channel bound, or null for
        // a recovery-only record (the validity dimension then goes inconclusive).
        lastSeenAt: liveLastSeenAt(match),
      };
    }
    // Records EXIST for this exact (domain, selector) but none carry the bundle's key:
    // the provider published a DIFFERENT key here → the bundle's key is not the
    // provider's (a forgery signal). Gate the verdict to FAILED (F-32.3, DD-35).
    return { keyAuthenticity: 'pending-online', keyProvenance: 'failed', observedAt: null, lastSeenAt: null };
  } catch {
    return PENDING; // archive unreachable / offline → pending, never an error
  }
}

/**
 * Confirm every signer's key in a bundle PDF → `{ signerIndex: KeyArchiveConfirmation }`.
 * Statement-first (F-32.9): a signer whose EMBEDDED archive statement verifies is
 * confirmed with ZERO network for that signer — the statement is the same
 * authority's signature over the same observation, so the live lookup is only the
 * fallback for signers without one. Never throws.
 */
export async function confirmKeyArchiveWeb(
  pdfBytes: Uint8Array,
  deps: ConfirmKeyArchiveDeps = {},
): Promise<Record<number, KeyArchiveConfirmation>> {
  const out: Record<number, KeyArchiveConfirmation> = {};
  try {
    const files = await extractEmbeddedFileMapWeb(pdfBytes);
    const keysBytes = files.get('keys.json');
    if (!keysBytes) return out;
    const keys = JSON.parse(new TextDecoder().decode(keysBytes)) as KeysJson;
    const fromStatements = await confirmStatementsOffline(files, deps.statementJwks);
    for (const n of signerIndices(files)) {
      if (fromStatements[n]) {
        out[n] = fromStatements[n];
        continue;
      }
      const rec = keys.keys.find((k) => k.signer === n);
      if (rec?.domain && rec.selector) {
        out[n] = await confirmKeyArchive(rec.domain, rec.selector, rec.record, deps);
      }
    }
  } catch {
    /* malformed bundle / keys.json → return whatever resolved; additive, never fatal */
  }
  return out;
}
