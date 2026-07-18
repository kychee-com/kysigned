/**
 * Minimal ambient types for the run402 RUNTIME packages the deployed-function
 * entry imports (`src/functions/api.ts`, `crons.ts`). These declare ONLY the
 * tiny surface kysigned consumes so:
 *
 *   - tsc (`npm run build`) resolves the dynamic `import('@run402/functions')`
 *     in the function entries WITHOUT the package being installed locally
 *     (`@run402/functions` is runtime-provided: the run402 platform injects it
 *     into the deployed function; it is never in `dependencies`), and
 *   - the `@run402/sdk` surface stays declared even where the installed
 *     package's own types are absent (fresh checkouts hitting the npmrc
 *     release-age gate). The SDK itself IS a normal `dependencies` entry.
 *
 * At deploy, `scripts/deploy.mjs` bundles the entries with esbuild, which
 * resolves the REAL packages (the human installs them with `--min-release-age=0`
 * per the documented recipe). Mirrors the `mailauth.d.ts` ambient-shim pattern.
 *
 * Keep these in lock-step with the real package signatures
 * (`@run402/functions@3.9.0`, `@run402/sdk@4.8.0`). Add to the shim only when a
 * non-test module imports a new symbol. (The 3.7.1 caller idempotency key rides
 * the `x-run402-idempotency-key` request header — read directly, no new import.)
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

  // ── F-30.2 tenant x402 payment context (priced routed function routes) ─────
  /** Gateway-confirmed tenant x402 payment facts, forwarded to the function
   *  after the gateway verified + settled a priced route payment. Mirrors
   *  `@run402/functions@3.7.0` `RoutedHttpPaymentContextV1`. */
  export interface RoutedHttpPaymentContextV1 {
    scheme: 'x402';
    paymentId: string;
    amountUsdMicros: number;
    payer: string | null;
    network: string;
    asset: string | null;
    payTo: string;
    transaction: string | null;
    settledAt: string;
  }
  /** Extract the confirmed payment context from a routed request (the runtime
   *  hands user code a Web `Request`; the context rides the platform-owned
   *  `x-run402-payment-*` headers). Returns `null` on unpriced routes or when
   *  any required field is absent/malformed (strict: positive safe-integer
   *  amount, scheme `x402`, non-empty id/network/payTo/settledAt). */
  export function getRoutedPaymentContext(
    source: Request | { headers: { get(name: string): string | null } },
  ): RoutedHttpPaymentContextV1 | null;

  // ── F-36 app events (project event feed) ───────────────────────────────────
  // `events.emit` writes a business fact into the project's cursored event
  // feed (class/source `"app"`). Gateway owns type grammar
  // (`/^[a-z][a-z0-9_]{2,63}$/`, platform names reserved), the 8 KiB payload
  // bound (truncates, never rejects), and FOREVER dedup on
  // `(project_id, idempotency_key)` — a replay returns the original event
  // with `deduplicated: true`. Mirrors `@run402/functions@3.9.0` `events.d.ts`.
  // On non-2xx it throws (Run402EventsPlatformError — carries structural
  // `code`/`status`); kysigned's seam catches structurally (the platform
  // bundles its own copy at deploy, so cross-copy `instanceof` is unreliable).
  export interface EventEmitOptions {
    idempotencyKey?: string;
  }
  export interface EventEmitResult {
    cursor: string;
    event_type: string;
    payload: Record<string, unknown>;
    payload_truncated?: true;
    occurred_at: string;
    deduplicated: boolean;
    [key: string]: unknown;
  }
  export const events: {
    emit(type: string, payload?: Record<string, unknown>, opts?: EventEmitOptions): Promise<EventEmitResult>;
  };
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
