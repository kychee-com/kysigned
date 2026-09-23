/**
 * Provider no-DKIM diagnosis — F-45.1 (spec 0.72.0, #166; unsigned Microsoft 0.73.0, DD-71).
 *
 * When a Google Workspace or Microsoft 365 organization never switched on DKIM for
 * its own domain, the provider signs that domain's outgoing mail under its OWN
 * fallback identity (Google: `‹domain›.‹date›.gappssmtp.com`; Microsoft:
 * `‹tenant›.onmicrosoft.com`). The gate (F-6.2) correctly rejects such a forward as
 * `misaligned`, forever, until the organization's admin turns DKIM on. This module
 * only DIAGNOSES that case so the signer and creator get messaging that does not
 * suggest a retry. It never changes the gate verdict (DD-69).
 *
 * A provider is named only when BOTH hold: every signature on the forward is under
 * that one provider's fallback domain and at least one verifies (only that provider's
 * servers hold keys there), and the sender's own address is not itself under that
 * domain (so no signature can be "for the signer's own domain").
 *
 * Microsoft 365, unsigned (spec 0.73.0): Microsoft documents a no-DKIM custom domain's
 * mail as carrying NO signature at all. Such a forward is named Microsoft 365 when the
 * caller's verified ARC first sealer (`verifiedFirstArcSealer`) is `microsoft.com`:
 * Exchange Online seals everything it sends and only Microsoft holds that key. A
 * signed forward is judged by the fallback rules alone, whatever sealed it.
 */
import type { DkimVerifyOutcome } from './dkimVerify.js';

export type ProviderNoDkim = 'google_workspace' | 'microsoft_365';

/** Each provider's fallback signing domain (empirical; spec Constraints, F-45.1). */
const FALLBACK_DOMAINS: ReadonlyArray<readonly [ProviderNoDkim, string]> = [
  ['google_workspace', 'gappssmtp.com'],
  ['microsoft_365', 'onmicrosoft.com'],
];

/** The ARC sealer Exchange Online stamps on every message it sends (spec Constraints). */
const MICROSOFT_ARC_SEALER = 'microsoft.com';

function isUnder(domain: string, suffix: string): boolean {
  const d = domain.toLowerCase().replace(/\.$/, '');
  return d === suffix || d.endsWith(`.${suffix}`);
}

/**
 * No real DKIM signature: nothing at all, or only mailauth's "message not signed"
 * placeholder, which carries no signing domain.
 */
export function isUnsignedForward(outcome: Pick<DkimVerifyOutcome, 'signatures'>): boolean {
  return outcome.signatures.every((s) => !s.signingDomain);
}

export interface ProviderNoDkimHints {
  /** The verified first ARC sealer of an UNSIGNED forward; ignored for a signed one. */
  arcFirstSealer?: string | null;
}

export function diagnoseProviderNoDkim(
  outcome: Pick<DkimVerifyOutcome, 'fromDomain' | 'signatures'>,
  hints: ProviderNoDkimHints = {},
): ProviderNoDkim | null {
  const { fromDomain, signatures } = outcome;
  if (isUnsignedForward(outcome)) {
    // A sender on onmicrosoft.com itself is always signed by Microsoft, so no admin setting applies.
    const sealedByMicrosoft = hints.arcFirstSealer === MICROSOFT_ARC_SEALER;
    return sealedByMicrosoft && !isUnder(fromDomain, 'onmicrosoft.com') ? 'microsoft_365' : null;
  }
  if (!signatures.some((s) => s.result === 'pass')) return null;
  for (const [provider, suffix] of FALLBACK_DOMAINS) {
    if (isUnder(fromDomain, suffix)) continue;
    if (signatures.every((s) => isUnder(s.signingDomain, suffix))) return provider;
  }
  return null;
}
