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
import { lookupArchivedKey, type DkimArchiveDeps } from '../api/signing/dkimArchive.js';
import { extractEmbeddedFileMapWeb } from './extractWeb.js';
import { signerIndices } from './evidenceOrder.js';
import type { KeysJson } from './keysJson.js';
import type { KeyAuthStatus } from './verifyTypes.js';

export type ConfirmKeyArchiveDeps = DkimArchiveDeps;

export interface KeyArchiveConfirmation {
  /** `archive-confirmed` = the exact key is present in the public archive; else `pending-online`. */
  keyAuthenticity: KeyAuthStatus;
  /** The archive's observation/registration time (ISO-8601), when confirmed; else null. */
  observedAt: string | null;
}

const PENDING: KeyArchiveConfirmation = { keyAuthenticity: 'pending-online', observedAt: null };

/** The base64 `p=` public key from a DKIM TXT value (`v=DKIM1; k=rsa; p=<b64>`) or a bare `p=<b64>`, whitespace-stripped. */
function extractPublicKey(value: string | null | undefined): string {
  if (!value) return '';
  const m = /p=([^;]*)/i.exec(value);
  return (m ? m[1] : '').replace(/\s+/g, '');
}

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
    if (!found) return PENDING;
    // Require the EXACT key (the archive may hold an older/rotated key at the same
    // selector); comparing the `p=` public key never yields a false confirm.
    const match = records.find((r) => extractPublicKey(r.value) === want);
    if (!match) return PENDING;
    return { keyAuthenticity: 'archive-confirmed', observedAt: match.firstSeenAt ?? match.lastSeenAt ?? null };
  } catch {
    return PENDING; // archive unreachable / offline → pending, never an error (additive)
  }
}

/** Confirm every signer's key in a bundle PDF → `{ signerIndex: KeyArchiveConfirmation }`. Never throws. */
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
    for (const n of signerIndices(files)) {
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
