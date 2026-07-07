/**
 * Classical DKIM verification — F-6.2 / AC-17 (spec v0.4.0, evidence-bundle model).
 *
 * The cryptographic seam: this wraps `mailauth` (MIT, the mainstream Node DKIM/SPF/
 * DMARC implementation), which performs the actual signature + body-hash verification
 * against the live DNS key. The math is NOT self-rolled (trust-model rule); this
 * module only adapts mailauth's output into the {@link DkimSignatureDescriptor}s the
 * pure {@link evaluateDkimPolicy} consumes, and scans the raw headers for an `l=`
 * tag (F-6.2(c)). Swapping mailauth for another verifier (e.g. a WASM verifier the
 * browser bundle-verifier shares) is a one-file change behind this seam.
 *
 * In production `resolver` is omitted so mailauth queries live DNS (F-6.2 "live DNS
 * key"); tests inject a resolver to verify offline against a generated key.
 */
import { dkimVerify } from 'mailauth';
import { extractFrom } from './mimeHeaders.js';
import type { DkimSignatureDescriptor } from './dkimPolicy.js';

/** A DNS resolver compatible with `dns.promises.resolve(name, rrtype)`. */
export type DkimResolver = (name: string, rrtype: string) => Promise<unknown>;

export interface DkimVerifyOutcome {
  /** Bare From-header domain (lowercased) — the alignment reference for the policy. */
  fromDomain: string;
  /** One descriptor per DKIM-Signature mailauth evaluated. */
  signatures: DkimSignatureDescriptor[];
  /** True if ANY DKIM-Signature header carries an l= body-length tag (F-6.2(c)). */
  anyBodyLengthTag: boolean;
}

const HEADER_BODY_SEP = /\r\n\r\n|\n\n/;

/**
 * Normalize mailauth's per-signature verdict into our descriptor result.
 *
 * mailauth reports BOTH a missing DNS key and a body-hash mismatch as `neutral`
 * (distinguished only by a free-text comment). A body-hash mismatch is a definite
 * tampering signal, not a key problem — detect it structurally via
 * bodyHash ≠ bodyHashExpecting and coerce to a hard `fail` so the policy logs
 * `invalid_signature`, never `missing_key`. A bad header signature is already
 * `fail`. Everything else (no key, temperror/permerror) passes through unchanged.
 */
function normalizeResult(entry: {
  status?: { result?: string };
  bodyHash?: string;
  bodyHashExpecting?: string;
}): DkimSignatureDescriptor['result'] {
  const raw = (entry.status?.result ?? 'none') as DkimSignatureDescriptor['result'];
  if (raw === 'pass') return 'pass';
  const { bodyHash, bodyHashExpecting } = entry;
  if (bodyHash && bodyHashExpecting && bodyHash !== bodyHashExpecting) return 'fail';
  return raw;
}

/** Does any DKIM-Signature header in the raw message carry an `l=` body-length tag? */
export function hasBodyLengthTag(rawMime: string): boolean {
  const headerSection = rawMime.split(HEADER_BODY_SEP, 1)[0] ?? '';
  const unfolded = headerSection.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    if (!/^dkim-signature\s*:/i.test(line)) continue;
    const value = line.slice(line.indexOf(':') + 1);
    for (const tag of value.split(';')) {
      const eq = tag.indexOf('=');
      if (eq > 0 && tag.slice(0, eq).trim().toLowerCase() === 'l') return true;
    }
  }
  return false;
}

/**
 * Verify the DKIM signatures of a raw RFC-822 message.
 *
 * @param rawMime the raw forward.
 * @param opts.resolver optional DNS resolver (tests); omit for live DNS in prod.
 */
export async function verifyDkim(
  rawMime: string,
  opts: { resolver?: DkimResolver } = {},
): Promise<DkimVerifyOutcome> {
  const result = await dkimVerify(rawMime, opts.resolver ? { resolver: opts.resolver } : undefined);

  const signatures: DkimSignatureDescriptor[] = (result.results ?? []).map(entry => ({
    signingDomain: (entry.signingDomain ?? '').toLowerCase(),
    selector: entry.selector,
    result: normalizeResult(entry),
    alignedDomain: entry.status?.aligned ? String(entry.status.aligned).toLowerCase() : null,
    algorithm: (entry.algo ?? '').toLowerCase(),
  }));

  const fromDomain = (extractFrom(rawMime).split('@')[1] ?? '').toLowerCase();

  return { fromDomain, signatures, anyBodyLengthTag: hasBodyLengthTag(rawMime) };
}
