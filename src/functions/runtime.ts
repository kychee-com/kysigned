/**
 * runtime — the ONE place the deployed function imports the real `@run402/*`
 * packages (alongside `scripts/`). Builds the production `AppDeps` from
 * `process.env` + the real `@run402/functions` `adminDb()` and a `@run402/sdk`
 * `Run402` client. Both the HTTP entry (`api.ts`) and the cron entries
 * (`crons.ts`) call `getRuntimeDeps()`; it memoizes across invocations (warm
 * Lambda) so the SDK client + pool are built once per cold start.
 *
 * The `@run402/*` imports are dynamic so a UNIT test that imports
 * `handleRequest` / a cron's pure inner sweep never loads those packages (and
 * the ambient `src/types/run402-runtime.d.ts` shim lets tsc resolve them without
 * an install). At deploy, esbuild bundles the real packages.
 */
import { buildAppDeps, type AppDeps, type Run402SdkClient } from './config.js';
import { buildRunHandlers, RetryableRunError, PermanentRunError } from './runHandlers.js';
import type { CreateRun } from './runs.js';
import { parsePaymentContextFromHeaders } from './paymentContextFallback.js';

let _appDeps: AppDeps | null = null;
let _runDispatch: ((input: unknown) => Promise<Response>) | null = null;
let _verifyWebhook: ((headers: Headers, raw: string, secret: string) => { valid: boolean; reason?: string }) | null = null;

/** Build (once) the wired AppDeps from env + the real run402 runtime. */
export async function getRuntimeDeps(): Promise<AppDeps> {
  if (_appDeps) return _appDeps;
  const { adminDb, functions, getRoutedPaymentContext } = await import('@run402/functions');
  const { run402 } = await import('@run402/sdk');
  const env = process.env as Record<string, string | undefined>;

  const apiBase = env.RUN402_API_BASE ?? 'https://api.run402.com';
  const serviceKey = env.RUN402_SERVICE_KEY ?? '';
  const anonKey = env.RUN402_ANON_KEY ?? '';

  // Minimal credentials provider over the function env (there is no local
  // keystore in the deployed Lambda). The SDK request kernel needs only
  // getAuth + getProject; both resolve from the injected service/anon keys.
  const credentials = {
    async getAuth() {
      return { Authorization: `Bearer ${serviceKey}` };
    },
    async getProject(_id: string) {
      return { anon_key: anonKey, service_key: serviceKey };
    },
  };
  const sdk = run402({ apiBase, credentials } as never) as unknown as Run402SdkClient;

  // F-29 — the real durable-run creator. `functions.runs.create` reads the
  // ambient run402 context (project id + service capability) at call time, so it
  // only works from within an invocation — which is exactly when the app creates
  // runs. Target is our single routed function, `kysigned-api` (the run402 run
  // engine invokes it with the run envelope; `default` dispatches — see below).
  const createRun: CreateRun = async (opts) => {
    const handle = await functions.runs.create('kysigned-api', {
      eventType: opts.eventType,
      idempotencyKey: opts.idempotencyKey,
      ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
      ...(opts.runAt !== undefined ? { runAt: opts.runAt } : {}),
      ...(opts.delay !== undefined ? { delay: opts.delay } : {}),
      ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
    });
    return { runId: handle.run_id, deduplicated: handle.deduplicated ?? false };
  };

  _appDeps = buildAppDeps(env, {
    adminDb: adminDb(),
    sdk,
    createRun,
    // F-30.2 — read the gateway-settled payment context. Prefer the platform
    // helper; FALL BACK to parsing the platform-owned headers ourselves when
    // the injected `@run402/functions` predates it (the platform bundles its
    // own copy at deploy time — a stale copy turned a settled $0.25 into a
    // 503 on 2026-07-09). The headers are gateway-injected post-settlement
    // (client x-run402-* stripped), so both paths read the same trust anchor.
    readPaymentContext:
      typeof getRoutedPaymentContext === 'function'
        ? (req: Request) => getRoutedPaymentContext(req)
        : (req: Request) => parsePaymentContextFromHeaders(req.headers),
  });
  return _appDeps;
}

/**
 * F-29 — the durable-run dispatcher, memoized. Adapts the pure `runHandlers`
 * into run402's `defineFunctionRuns` and translates the two marker errors into
 * run402's retry protocol (`RetryableRunError` → retry; `PermanentRunError` →
 * no retry; any other throw defaults to retryable). Called by the entry's
 * `default` when an invocation carries a `{ trigger: "function_run" }` body.
 */
export async function getRunDispatcher(deps: AppDeps): Promise<(input: unknown) => Promise<Response>> {
  if (_runDispatch) return _runDispatch;
  const { defineFunctionRuns, retryableFunctionRunError, permanentFunctionRunError } = await import('@run402/functions');
  const handlers = buildRunHandlers(deps);
  const adapted: Record<string, (ctx: unknown, payload: Record<string, unknown>) => Promise<Record<string, unknown>>> = {};
  for (const [eventType, handler] of Object.entries(handlers)) {
    adapted[eventType] = async (_ctx, payload) => {
      try {
        return await handler(payload);
      } catch (err) {
        if (err instanceof RetryableRunError) throw retryableFunctionRunError(err.message);
        if (err instanceof PermanentRunError) throw permanentFunctionRunError(err.message);
        throw err;
      }
    };
  }
  _runDispatch = defineFunctionRuns(adapted);
  return _runDispatch;
}

/** The run402 webhook verifier (real `@run402/functions.verifyWebhook`), memoized. */
export async function getVerifyWebhook(): Promise<
  (headers: Headers, raw: string, secret: string) => { valid: boolean; reason?: string }
> {
  if (_verifyWebhook) return _verifyWebhook;
  const { verifyWebhook } = await import('@run402/functions');
  _verifyWebhook = (headers, raw, secret) => verifyWebhook(headers, raw, secret);
  return _verifyWebhook;
}
