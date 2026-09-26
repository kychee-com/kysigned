/**
 * The `kysigned` package (the reference verifier as a library, F-47.1, DD-77) ships
 * no type declarations yet. This declares the one entry the local server uses
 * (verify_bundle, DD-78). The verdict document passes through to the caller as
 * structured content, so its shape stays opaque here.
 */
declare module 'kysigned' {
  /** The package version. */
  export const VERSION: string;
  /** The schema tag of the verdict document. */
  export const VERDICT_SCHEMA: 'kysigned.verdict.v1';

  export interface VerdictJson {
    schema: 'kysigned.verdict.v1';
    kysigned: string;
    offline: boolean;
    [field: string]: unknown;
  }

  export interface VerifyOutcome {
    /** 0 = the bundle verifies at a satisfied assurance tier, 1 = FAILED. */
    exitCode: 0 | 1;
    /** The human-first verdict (F-10.4). */
    report: string;
    verdict: Record<string, unknown>;
    /** The document `kysigned verify --json` prints. */
    json: VerdictJson;
  }

  /** Verify a bundle PDF's bytes on this machine; `offline` skips the two network indicators. */
  export function verifyBundleBytes(bytes: Uint8Array, opts?: { offline?: boolean }): Promise<VerifyOutcome>;
}
