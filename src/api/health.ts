/**
 * GET /v1/health — unauthenticated liveness probe (F-11 / AC-32).
 *
 * Pure: returns a 200 with a small JSON body. No auth, no DB. The run402 Lambda
 * router maps `GET /v1/health` → this handler (route wiring lands in Phase 14);
 * the shipping smoke check (Phase 20) curls it. The BARE body never changes —
 * the forker-manifest `verify.http` path pins it (#146 keeps it liveness-only).
 */
export interface HealthResult {
  status: 200;
  body: { status: 'ok'; service: 'kysigned'; ts: string };
}

export function handleHealth(now: Date = new Date()): HealthResult {
  return { status: 200, body: { status: 'ok', service: 'kysigned', ts: now.toISOString() } };
}

/**
 * GET /v1/health?deep=1 — readiness (#146): one bounded DB probe (`SELECT 1`
 * via the admin pool) + a signing-mailbox settings read. A dead DB or a
 * suspended signing mailbox must NOT serve a green 200 (the orphan-cron storm
 * and the #134 suspension both hid behind the liveness ping).
 *
 * Public + unauthenticated, so check results are ONLY 'ok' | 'fail' |
 * 'timeout' — internal error detail goes to the server log, never the body.
 * Each check races a timeout (default 2s) so the probe is bounded and a hang
 * degrades to a named 503 instead of blocking the endpoint.
 */
export type DeepCheckState = 'ok' | 'fail' | 'timeout';

export interface DeepHealthDeps {
  checkDb: () => Promise<void>;
  checkMailbox: () => Promise<void>;
  timeoutMs?: number;
  now?: Date;
  /** Server-side detail sink (defaults to console.error). Never reaches the body. */
  logError?: (check: string, err: unknown) => void;
}

export interface DeepHealthResult {
  status: 200 | 503;
  body: {
    status: 'ok' | 'degraded';
    service: 'kysigned';
    ts: string;
    checks: { db: DeepCheckState; mailbox: DeepCheckState };
  };
}

async function runCheck(
  name: string,
  check: () => Promise<void>,
  timeoutMs: number,
  logError: (check: string, err: unknown) => void,
): Promise<DeepCheckState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const outcome = await Promise.race([check().then(() => 'ok' as const), timeout]);
    if (outcome === 'timeout') {
      logError(name, new Error(`check timed out after ${timeoutMs}ms`));
      return 'timeout';
    }
    return 'ok';
  } catch (err) {
    logError(name, err);
    return 'fail';
  } finally {
    clearTimeout(timer);
  }
}

export async function handleDeepHealth(deps: DeepHealthDeps): Promise<DeepHealthResult> {
  const timeoutMs = deps.timeoutMs ?? 2_000;
  const logError =
    deps.logError ?? ((check, err) => console.error(`[health?deep=1] ${check} check failed:`, (err as Error)?.message ?? err));
  const [db, mailbox] = await Promise.all([
    runCheck('db', deps.checkDb, timeoutMs, logError),
    runCheck('mailbox', deps.checkMailbox, timeoutMs, logError),
  ]);
  const ok = db === 'ok' && mailbox === 'ok';
  return {
    status: ok ? 200 : 503,
    body: {
      status: ok ? 'ok' : 'degraded',
      service: 'kysigned',
      ts: (deps.now ?? new Date()).toISOString(),
      checks: { db, mailbox },
    },
  };
}
