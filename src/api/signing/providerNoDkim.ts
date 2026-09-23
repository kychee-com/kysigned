/**
 * Provider no-DKIM diagnosis — F-45.1 (spec 0.72.0, #166).
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
 */
import type { DkimVerifyOutcome } from './dkimVerify.js';

export type ProviderNoDkim = 'google_workspace' | 'microsoft_365';

/** Each provider's fallback signing domain (empirical; spec Constraints, F-45.1). */
const FALLBACK_DOMAINS: ReadonlyArray<readonly [ProviderNoDkim, string]> = [
  ['google_workspace', 'gappssmtp.com'],
  ['microsoft_365', 'onmicrosoft.com'],
];

function isUnder(domain: string, suffix: string): boolean {
  const d = domain.toLowerCase().replace(/\.$/, '');
  return d === suffix || d.endsWith(`.${suffix}`);
}

export function diagnoseProviderNoDkim(
  outcome: Pick<DkimVerifyOutcome, 'fromDomain' | 'signatures'>,
): ProviderNoDkim | null {
  const { fromDomain, signatures } = outcome;
  if (signatures.length === 0 || !signatures.some((s) => s.result === 'pass')) return null;
  for (const [provider, suffix] of FALLBACK_DOMAINS) {
    if (isUnder(fromDomain, suffix)) continue;
    if (signatures.every((s) => isUnder(s.signingDomain, suffix))) return provider;
  }
  return null;
}
