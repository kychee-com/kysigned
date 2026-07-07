/**
 * Minimal ambient types for the part of `mailauth` (MIT) that kysigned consumes:
 * classical DKIM verification (the evidence-bundle trust anchor, F-6.2). mailauth
 * ships no type declarations; this declares only the `dkimVerify` surface used by
 * `src/api/signing/dkimVerify.ts`. The signing/SPF/DMARC/ARC exports are real but
 * untyped here — add to this shim if/when a non-test module imports them.
 */
declare module 'mailauth' {
  export interface DkimVerifyResultEntry {
    /** d= signing domain. */
    signingDomain?: string;
    /** s= selector. */
    selector?: string;
    /** a= algorithm, e.g. 'rsa-sha256'. */
    algo?: string;
    /** c= canonicalization, e.g. 'relaxed/relaxed'. */
    format?: string;
    /** Recomputed body hash (base64). */
    bodyHash?: string;
    /** The bh= value claimed in the signature (base64). Differs from bodyHash iff the body was altered. */
    bodyHashExpecting?: string;
    status?: {
      /** 'pass' | 'fail' | 'neutral' | 'none' | 'temperror' | 'permerror'. */
      result?: string;
      comment?: string;
      /** The From-aligned org-domain when aligned, else false/null. */
      aligned?: string | false | null;
    };
  }
  export interface DkimVerifyResult {
    headerFrom?: string | string[];
    envelopeFrom?: string | false;
    results: DkimVerifyResultEntry[];
  }
  export function dkimVerify(
    input: string | Buffer,
    opts?: { resolver?: (name: string, rrtype: string) => Promise<unknown> },
  ): Promise<DkimVerifyResult>;
}
