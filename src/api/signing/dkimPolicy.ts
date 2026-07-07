/**
 * DKIM acceptance policy — F-6.2 / AC-17 (spec v0.4.0, evidence-bundle model).
 *
 * The DKIM signature IS the trust anchor ("trust = DKIM + math"), so this policy is
 * security-critical. It sits ON TOP of a cryptographic verdict produced by a
 * mainstream, third-party-tested library (mailauth, via `dkimVerify.ts`) — the
 * signature math is never self-rolled; this layer enforces the spec policy around
 * that verdict and assigns the distinct rejection reasons AC-17 requires.
 *
 * F-6.2 requires, for acceptance: a DKIM signature that (a) cryptographically
 * verifies (full body hash), (b) is aligned with the From domain (the signing
 * `d=` org-domain equals the From org-domain), (c) carries no `l=` body-length
 * tag (which would let unsigned content be appended), and (d) uses a strong
 * algorithm (not rsa-sha1).
 */

export interface DkimSignatureDescriptor {
  /** d= signing domain. */
  signingDomain: string;
  /** s= selector (diagnostics only). */
  selector?: string;
  /** Cryptographic verdict from the library: pass = signature + body hash verified. */
  result: 'pass' | 'fail' | 'neutral' | 'none' | 'temperror' | 'permerror' | (string & {});
  /** The org-domain this signature aligns to (From-relative), or null if not aligned. */
  alignedDomain: string | null;
  /** a= algorithm, e.g. 'rsa-sha256' / 'ed25519-sha256'. */
  algorithm: string;
}

export interface DkimPolicyInput {
  /** Bare From-header domain (lowercased), e.g. 'example.com'. */
  fromDomain: string;
  /** One descriptor per DKIM-Signature the library evaluated. */
  signatures: DkimSignatureDescriptor[];
  /** True if ANY DKIM-Signature in the message carries an l= body-length tag. */
  anyBodyLengthTag: boolean;
}

export type DkimPolicyReason =
  | 'no_signature'
  | 'body_length_tag'
  | 'misaligned'
  | 'weak_algorithm'
  | 'missing_key'
  | 'invalid_signature';

export type DkimPolicyResult =
  | { ok: true; signingDomain: string; selector: string; algorithm: string }
  | { ok: false; reason: DkimPolicyReason };

/** Last two dot-labels — a non-PSL org-domain heuristic (sufficient for alignment). */
function orgDomain(domain: string): string {
  const parts = domain.toLowerCase().split('.').filter(Boolean);
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}

function orgAligned(a: string, b: string): boolean {
  const oa = orgDomain(a);
  return oa.length > 0 && oa === orgDomain(b);
}

const KEYLESS_RESULTS = new Set(['neutral', 'none', 'temperror', 'permerror']);

export function evaluateDkimPolicy(input: DkimPolicyInput): DkimPolicyResult {
  const { fromDomain, signatures, anyBodyLengthTag } = input;

  // F-6.2(c) — reject any l= body-length tag outright (it lets unsigned content
  // be appended below the signed region). Message-level: any signature with l=.
  if (anyBodyLengthTag) {
    return { ok: false, reason: 'body_length_tag' };
  }
  if (signatures.length === 0) {
    return { ok: false, reason: 'no_signature' };
  }

  // F-6.2(a)+(b) — need a cryptographically-passing signature aligned with From.
  const passing = signatures.filter(s => s.result === 'pass');
  const alignedPassing = passing.find(s => s.alignedDomain && orgAligned(s.alignedDomain, fromDomain));
  if (alignedPassing) {
    // F-6.2(d) — strong algorithm only.
    if (/sha1/i.test(alignedPassing.algorithm)) {
      return { ok: false, reason: 'weak_algorithm' };
    }
    return {
      ok: true,
      signingDomain: alignedPassing.signingDomain,
      selector: alignedPassing.selector ?? '',
      algorithm: alignedPassing.algorithm,
    };
  }

  // A signature passed cryptographically but none aligns to From → spoof-shaped.
  if (passing.length > 0) {
    return { ok: false, reason: 'misaligned' };
  }

  // Nothing passed. A genuine verification failure (tampered body / forged sig)
  // outranks a DNS/key problem for the reason we log and bounce.
  if (signatures.some(s => s.result === 'fail')) {
    return { ok: false, reason: 'invalid_signature' };
  }
  if (signatures.some(s => KEYLESS_RESULTS.has(String(s.result)))) {
    return { ok: false, reason: 'missing_key' };
  }
  return { ok: false, reason: 'invalid_signature' };
}

// re-exported so the orchestrator/tests share the alignment notion.
export { orgDomain, orgAligned };
