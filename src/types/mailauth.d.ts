/**
 * Minimal ambient types for the part of `mailauth` (MIT) that kysigned consumes:
 * classical DKIM verification (the evidence-bundle trust anchor, F-6.2) and, for the
 * F-45.1 Microsoft 365 diagnosis (DD-71), ARC chain verification. This ambient shim
 * (which TypeScript uses in place of the typings newer mailauth releases bundle)
 * declares only the `dkimVerify` + `arc` surface used by `src/api/signing/dkimVerify.ts`
 * and `src/api/signing/arcSealer.ts`. The signing/SPF/DMARC exports are real but
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
  /** One parsed ARC header: its tags, as mailauth's DKIM-header parser returns them. */
  export interface ArcParsedHeader {
    parsed?: Record<string, { value?: string } | undefined>;
  }
  /** One ARC set (instance i=N) as mailauth parses it. */
  export interface ArcChainEntry {
    i: number;
    'arc-seal'?: ArcParsedHeader;
    'arc-message-signature'?: ArcParsedHeader;
    'arc-authentication-results'?: ArcParsedHeader;
  }
  /** The ARC chain `dkimVerify` parsed on the way; `chain` is false when absent or malformed. */
  export interface ArcChainData {
    chain: ArcChainEntry[] | false;
    lastEntry?: ArcChainEntry;
    error?: Error;
  }
  export interface DkimVerifyResult {
    headerFrom?: string | string[];
    envelopeFrom?: string | false;
    results: DkimVerifyResultEntry[];
    arc?: ArcChainData;
  }
  export function dkimVerify(
    input: string | Buffer,
    opts?: { resolver?: (name: string, rrtype: string) => Promise<unknown> },
  ): Promise<DkimVerifyResult>;
  /** ARC chain verification: `status.result` is 'pass' only when every seal and the latest message signature verify. */
  export function arc(
    data: ArcChainData,
    opts?: { resolver?: (name: string, rrtype: string) => Promise<unknown>; minBitLength?: number },
  ): Promise<{ status: { result: string; comment?: string } }>;
}
