/**
 * Default timestamp composition for the signing event (F-6.6).
 *
 * kysigned applies BOTH timestamps over `sha256(raw .eml)`, because they are
 * complementary rather than interchangeable (the verifier grades durability from both,
 * see bundle/assuranceTier.ts):
 *   - OpenTimestamps — Bitcoin/math, trustless (the durable anchor). Pending until
 *     Bitcoin confirms; the OTS-upgrade reconciler advances it. Its block confirmation
 *     is what lets a record reach the PROVEN (DURABLE) tier.
 *   - RFC 3161 / freeTSA — a trusted-timestamp-authority token (the court/eIDAS
 *     convention). Synchronous — complete on creation, but authority-trusted, so alone
 *     it supports only a provisional time (INTEGRITY VERIFIED, not durable).
 *
 * Note: the RFC 3161 TSA's certificate chains to a CA, but it attests the TIME over
 * a hash — it is NOT a document-signing certificate. It does not sign the bundle PDF
 * or certify the signer, so it does not reintroduce the PAdES/AATL "certify the
 * middleman" red-X the project deliberately avoids (the bundle PDF stays unsigned).
 *
 * Operators/forkers can override the calendars / TSA URL, or build their own
 * `ArtifactAssemblyDeps` to drop a provider.
 */
import { createOtsProvider } from '../../timestamp/ots/provider.js';
import { createRfc3161Provider } from '../../timestamp/rfc3161/provider.js';
import type { ArtifactAssemblyDeps } from './artifactAssembly.js';
import { resolveDkimKeyViaDns } from './dkimKeyResolver.js';

export interface DefaultTimestampOptions {
  /** Override the OTS calendar URLs (default: the public pool, ≥2). */
  calendars?: string[];
  /** Override the RFC 3161 TSA URL (default: freeTSA). */
  tsaUrl?: string;
}

/** kysigned's default: BOTH OpenTimestamps (Bitcoin) AND RFC 3161 (freeTSA). */
export function createDefaultTimestampAssemblyDeps(
  opts: DefaultTimestampOptions = {},
): ArtifactAssemblyDeps {
  return {
    timestampProvider: createOtsProvider(opts.calendars ? { calendars: opts.calendars } : {}),
    tsaProvider: createRfc3161Provider(opts.tsaUrl ? { tsaUrl: opts.tsaUrl } : {}),
    // F-6.7 observed-key log: live DNS read of the key + contribute to the public
    // archive (archive.prove.email, default base URL + global fetch).
    resolveDkimKey: resolveDkimKeyViaDns(),
    archive: {},
  };
}
