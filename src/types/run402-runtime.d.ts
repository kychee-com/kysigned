/**
 * Minimal ambient types for the run402 RUNTIME packages the deployed-function
 * entry imports (`src/functions/api.ts`, `crons.ts`). These declare ONLY the
 * tiny surface kysigned consumes so:
 *
 *   - tsc (`npm run build`) resolves the dynamic `import('@run402/functions')`
 *     / `import('@run402/sdk')` in the function entries WITHOUT either package
 *     being installed locally, and
 *   - the public, forkable template carries NO `@run402/*` entry in its
 *     `dependencies` (those releases are too fresh for the local npmrc age-gate
 *     to `npm install` cleanly, and `@run402/functions` is auto-bundled into the
 *     deployed function by the run402 build anyway).
 *
 * At deploy, `scripts/deploy.mjs` bundles the entries with esbuild, which
 * resolves the REAL packages (the human installs them with `--min-release-age=0`
 * per the documented recipe). Mirrors the `mailauth.d.ts` ambient-shim pattern.
 *
 * Keep these in lock-step with the real package signatures
 * (`@run402/functions@3.5.0`, `@run402/sdk@2.47.1`). Add to the shim only when a
 * non-test module imports a new symbol.
 */
declare module '@run402/functions' {
  /** Service-role HTTP SQL client (BYPASSRLS). */
  export interface AdminDbClient {
    sql(query: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  }
  export function adminDb(): AdminDbClient;

  export type VerifyWebhookResult =
    | { valid: true; timestamp: number; secret_used: 'current' | 'previous' }
    | { valid: false; reason: string };

  export interface VerifyWebhookOptions {
    toleranceSeconds?: number;
    previousSecret?: string | null;
    nowSeconds?: () => number;
  }

  /** Verify a run402-signed webhook over the EXACT raw body bytes. */
  export function verifyWebhook(
    headers: Headers | Record<string, string | string[] | undefined> | { get(name: string): string | null },
    rawBody: string,
    secret: string,
    options?: VerifyWebhookOptions,
  ): VerifyWebhookResult;

  // ── F-29 durable function runs ──────────────────────────────────────────────
  // The runtime creates runs (`functions.runs.create`) + dispatches them
  // (`defineFunctionRuns`); `runtime.ts` is the only importer. Structural subset.
  export interface FunctionRunCreateOptions {
    eventType: string;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
    runAt?: string | Date;
    delay?: string | number;
    delaySeconds?: number;
    expiresAt?: string | Date;
    expiresAfter?: string | number;
    retry?: Record<string, unknown>;
  }
  export interface FunctionRunHandle {
    run_id: string;
    deduplicated?: boolean;
    [key: string]: unknown;
  }
  /** Create a durable function run. Requires an active run402 invocation context. */
  export const functions: {
    runs: { create(functionName: string, options: FunctionRunCreateOptions): Promise<FunctionRunHandle> };
  };
  /** Build the run-envelope dispatcher (event_type → handler). */
  export function defineFunctionRuns(
    handlers: Record<string, (ctx: unknown, payload: Record<string, unknown>, envelope: unknown) => unknown>,
  ): (input: unknown) => Promise<Response>;
  /** Throw to signal a transient failure — run402 retries per the run's policy. */
  export function retryableFunctionRunError(message: string): Error;
  /** Throw to signal a terminal failure — run402 does NOT retry. */
  export function permanentFunctionRunError(message: string): Error;
}

declare module '@run402/sdk' {
  export interface Run402Options {
    apiBase: string;
    credentials: unknown;
    fetch?: typeof globalThis.fetch;
  }
  /** The constructed client (its `.email` namespace is what kysigned uses). */
  export interface Run402 {
    readonly email: {
      send(
        projectId: string,
        opts: {
          to: string;
          subject: string;
          html: string;
          text?: string;
          attachments?: Array<{ filename: string; content_base64: string; content_type: string }>;
          mailbox?: string;
        },
      ): Promise<{ message_id: string }>;
      getRaw(
        projectId: string,
        messageId: string,
        opts?: { mailbox?: string },
      ): Promise<{ content_type: string; bytes: Uint8Array }>;
    };
  }
  export function run402(opts: Run402Options): Run402;
}
