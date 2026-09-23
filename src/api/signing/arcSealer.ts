/**
 * ARC first sealer — F-45.1 "Microsoft 365, unsigned" (spec 0.73.0, AC-279; DD-71).
 *
 * Microsoft sends a no-DKIM custom domain's mail UNSIGNED, but Exchange Online seals
 * every message it sends with an ARC set (i=1, `d=microsoft.com`). This answers one
 * question about a forward: who sealed it FIRST, provided the WHOLE chain verifies
 * (every ARC-Seal plus the latest ARC-Message-Signature). It wraps mailauth's `arc()`,
 * the same library and resolver as the DKIM gate, over the chain mailauth already
 * parsed during `verifyDkim`.
 *
 * Diagnosis only: nothing here can make a forward valid. Every failure (no chain, a
 * seal that does not verify, a missing or undersized key, a malformed header, an
 * unexpected throw inside mailauth) is null.
 */
import { arc, type ArcChainData } from 'mailauth';
import type { DkimResolver } from './dkimVerify.js';

export async function verifiedFirstArcSealer(
  arcData: ArcChainData | undefined,
  opts: { resolver?: DkimResolver } = {},
): Promise<string | null> {
  const chain = arcData?.chain;
  if (!arcData || !Array.isArray(chain) || chain.length === 0) return null;
  try {
    const result = await arc(arcData, { resolver: opts.resolver });
    if (result.status?.result !== 'pass') return null;
    const sealer = chain[0]?.['arc-seal']?.parsed?.d?.value;
    return typeof sealer === 'string' && sealer ? sealer.toLowerCase().replace(/\.$/, '') : null;
  } catch {
    return null;
  }
}
