/**
 * runs — the durable-run creation seam (F-29).
 *
 * run402 gained first-class durable function runs, so kysigned models every
 * app-owned background job as a run (not a cron sweep). The pure `src/` layer
 * stays free of `@run402/*` (so it unit-tests against fakes), and creates runs
 * through this injected seam — `AppDeps.createRun`. The deployed entry
 * (`runtime.ts`) provides the real impl over `@run402/functions`'
 * `functions.runs.create('kysigned-api', …)`; tests inject a fake that records
 * the calls.
 *
 * Structurally mirrors run402's create-options contract (idempotencyKey
 * required; runAt XOR delay) without importing the runtime package.
 */

export interface CreateRunOptions {
  /** The run event_type — dispatched to a `runHandlers` handler of the same name. */
  eventType: string;
  /**
   * Dedup key. A second `create` with the same key returns the existing run
   * (`deduplicated: true`) instead of enqueuing a duplicate — this is what makes
   * the event-driven model at-least-once-safe (a retried caller can't double-fire).
   */
  idempotencyKey: string;
  /** JSON payload handed to the handler. */
  payload?: Record<string, unknown>;
  /** Absolute ISO-8601 fire time. Mutually exclusive with `delay`. */
  runAt?: string;
  /** Relative delay — seconds, or a duration string like `"3d"` / `"1h"`. XOR `runAt`. */
  delay?: string | number;
  /** Retry policy, e.g. `{ preset: 'standard', maxAttempts: 8 }`. */
  retry?: Record<string, unknown>;
  /**
   * F-37 — the function that HANDLES the run. Default: the app's own routed
   * function (`kysigned-api`). Cross-function targeting is native to run402
   * (`POST /functions/v1/<target>/runs`, project-scoped) and lets the public
   * app enqueue work for a private `[service]` sibling (the Ads upload
   * handler) without carrying any of its code.
   */
  targetFunction?: string;
}

export interface CreateRunResult {
  runId: string;
  /** True when `idempotencyKey` matched an existing run (no new run was created). */
  deduplicated: boolean;
}

/** Create a run402 durable function run. Injected into the pure layer via AppDeps. */
export type CreateRun = (opts: CreateRunOptions) => Promise<CreateRunResult>;

// ── Run retry-control markers ────────────────────────────────────────────────
// A run handler signals run402's retry protocol by throwing one of these; the
// deployed entry (runtime.ts) maps them to `retryable/permanentFunctionRunError`.
// They live here (the @run402-free seam module) so both the handlers module and
// the inbound-email handlers can throw them without a circular import.

/** Transient failure — run402 retries the run per its retry policy. */
export class RetryableRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableRunError';
  }
}

/** Terminal failure — run402 does NOT retry (a bad payload, an impossible state). */
export class PermanentRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentRunError';
  }
}
