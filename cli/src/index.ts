/**
 * The `kysigned` library (F-47.1, DD-77): the reference verifier, bundled. The same
 * function backs the `kysigned verify` command and the local MCP's `verify_bundle`
 * (DD-78), so every surface returns the canonical verdict (F-10.10). Verification
 * runs on the caller's machine: the bundle is never sent anywhere. Online (the
 * default), only the two additive indicators use the network: timestamp-commitment
 * hashes to the public OpenTimestamps calendars and a Bitcoin block source, and the
 * public (domain, selector) straight to the key archive. `offline` skips both and
 * makes no network request (F-47.5).
 */
import { runVerifyCli } from '../../src/bundle/verifyCli.js';
import type { BundleVerdict } from '../../src/bundle/verifyTypes.js';

declare const __KYSIGNED_VERSION__: string;

/** The package version, inlined at build time. */
export const VERSION: string = __KYSIGNED_VERSION__;

/** The schema tag of the JSON verdict document (`kysigned verify --json`). */
export const VERDICT_SCHEMA = 'kysigned.verdict.v1';

export type VerdictJson = { schema: typeof VERDICT_SCHEMA; kysigned: string; offline: boolean } & BundleVerdict;

export interface VerifyOptions {
  /**
   * Make no network request. The Bitcoin anchor then reports pending, and the key archive
   * reports pending unless the bundle carries the archive's signed statement (F-32.9), which
   * confirms the key offline (spec 0.75.1, AC-303).
   */
  offline?: boolean;
}

export interface VerifyOutcome {
  /** 0 = the bundle verifies at a satisfied assurance tier, 1 = FAILED. */
  exitCode: 0 | 1;
  /** The human-first verdict (F-10.4). */
  report: string;
  /** The verifier's verdict object. */
  verdict: BundleVerdict;
  /** The verdict as the JSON document `kysigned verify --json` prints. */
  json: VerdictJson;
}

/** Verify a bundle PDF's bytes on this machine. */
export async function verifyBundleBytes(bytes: Uint8Array, opts: VerifyOptions = {}): Promise<VerifyOutcome> {
  const offline = opts.offline === true;
  const { exitCode, report, verdict } = await runVerifyCli(bytes, { offline });
  return {
    exitCode: exitCode === 0 ? 0 : 1,
    report,
    verdict,
    json: { schema: VERDICT_SCHEMA, kysigned: VERSION, offline, ...verdict },
  };
}
