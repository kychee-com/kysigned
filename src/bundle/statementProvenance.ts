/**
 * statementProvenance.ts — F-32.9/AC-267 (spec 0.71.0): OFFLINE provider-key
 * provenance from the bundle's EMBEDDED archive statement.
 *
 * A bundle may embed, per signer, the archive's signed observation statement
 * (`proofs/signer-<n>-statement.jws` — the exact bytes captured at receipt) plus
 * the operator's anchors over those bytes. This module verifies the statement
 * against the verifier's PINNED archive key set (never bundle-supplied keys) and,
 * when its record matches the signer's exact key + pair, yields the same
 * confirmation shape the live archive lookup produces — so the F-32.3 provenance
 * dimension confirms and the F-32.4 window gets its live-only bound with ZERO
 * archive contact, long after the archive's own availability.
 *
 * Fail-open toward the live fallback: a missing, unverifiable, mismatched, or
 * non-live statement contributes NOTHING here (the signer stays on the live
 * path); tampering with the statement or its anchor proofs still lands FAILED
 * via the fingerprint + AC-154 evidence rules. Browser-safe.
 */
import { verifyArchiveStatement, type ArchiveJwks } from './archiveStatement.js';
import { ARCHIVE_STATEMENT_JWKS } from './archiveStatementJwks.js';
import { extractPublicKey } from '../api/signing/dkimArchive.js';
import { signerIndices } from './evidenceOrder.js';
import type { KeysJson } from './keysJson.js';
import type { KeyArchiveConfirmation } from './confirmKeyArchive.js';

/**
 * Verify every embedded per-signer statement in a bundle's file map. Returns a
 * confirmation ONLY for signers whose statement verifies (pinned keys), matches
 * the signer's `(domain, selector, exact key bytes)` from keys.json, and attests
 * the `live_dns` channel (the archive signs nothing else; enforced defensively).
 * Never throws; an empty result means "no offline evidence — use the live path".
 */
export async function confirmStatementsOffline(
  files: Map<string, Uint8Array>,
  jwks: ArchiveJwks = ARCHIVE_STATEMENT_JWKS,
): Promise<Record<number, KeyArchiveConfirmation>> {
  const out: Record<number, KeyArchiveConfirmation> = {};
  try {
    const keysBytes = files.get('keys.json');
    if (!keysBytes) return out;
    const keys = JSON.parse(new TextDecoder().decode(keysBytes)) as KeysJson;
    for (const n of signerIndices(files)) {
      const jwsBytes = files.get(`proofs/signer-${n}-statement.jws`);
      if (!jwsBytes) continue;
      const rec = keys.keys.find((k) => k.signer === n);
      const want = extractPublicKey(rec?.record ?? null);
      if (!rec || !want) continue;
      const v = await verifyArchiveStatement(new TextDecoder().decode(jwsBytes), jwks);
      if (!v.ok) continue; // ignored as evidence → live fallback (AC-267)
      if (v.record.domain !== rec.domain.toLowerCase() || v.record.selector !== rec.selector.toLowerCase()) continue;
      if (extractPublicKey(v.record.value) !== want) continue;
      if (v.record.source !== 'live_dns') continue; // live-only by construction; enforced anyway
      out[n] = {
        keyAuthenticity: 'archive-confirmed',
        keyProvenance: 'confirmed',
        observedAt: v.record.firstSeenAt,
        lastSeenAt: v.record.lastSeenAt,
      };
    }
  } catch {
    /* additive, never fatal — the live path stands */
  }
  return out;
}
