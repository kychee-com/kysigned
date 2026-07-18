/**
 * appEvents — the F-36 app-events seam (DD-43): the ONE path kysigned emits
 * run402 app events through.
 *
 * Business transitions report facts into the hosting project's run402 event
 * feed (console project page, `run402 events --source app`, the operator's
 * Telegram rules). The seam owns the three disciplines every emit site would
 * otherwise have to copy:
 *
 *  - **Never gate the transition (AC-196).** `emitAppEvent` never throws and
 *    never rejects: a failing/quota-denied/hanging runtime surface degrades to
 *    one log line (type + subject ids + the platform's structural
 *    `code`/`status` when present). Platform errors are read structurally —
 *    the deployed runtime bundles its own `@run402/functions` copy, so a
 *    cross-copy `instanceof` is unreliable. The wait is time-bounded; a late
 *    settlement after the bound is swallowed, never an unhandled rejection.
 *    There is deliberately NO kysigned-side retry queue (spec F-36.3): the
 *    gateway's forever-dedup makes the next real occurrence the recovery path.
 *  - **Stable idempotency keys (AC-194).** The key is the event type plus the
 *    subject's domain ids, component-encoded and colon-joined. The gateway
 *    dedupes `(project_id, idempotency_key)` FOREVER, so a durable-run retry
 *    or webhook redelivery replays the stored event instead of duplicating it.
 *  - **Flat payloads (AC-195).** `AppEventPayload` admits only string/number/
 *    boolean values — ids, counts, ISO timestamps, fixed enums. No nested
 *    structures, and (enforced by the 60.4 wire-shape suite) no PII and
 *    nothing document-derived: events leave kysigned's trust boundary.
 */

/** `events.emit` from the platform-injected `@run402/functions` (3.9.0+). */
export type RuntimeEventEmitter = (
  type: string,
  payload?: Record<string, unknown>,
  opts?: { idempotencyKey?: string },
) => Promise<unknown>;

/** The F-36.1 signing-lifecycle facts + the F-36.4/F-36.5 growth/revenue facts.
 *  Flat snake_case per the gateway grammar. */
export type AppEventType =
  | 'signature_completed'
  | 'signer_declined'
  | 'envelope_completed'
  | 'envelope_undeliverable'
  | 'sweep_anomaly'
  | 'creator_signed_up'
  | 'credit_purchase';

/** Flat fact values: opaque ids, counts, ISO timestamps, fixed enums. */
export type AppEventPayloadValue = string | number | boolean;
/** F-36.2 — ids/counts/enums only; never PII, never document-derived values. */
export type AppEventPayload = Record<string, AppEventPayloadValue>;

export interface AppEventsSeamDeps {
  /** Absent on a runtime predating the events surface → logged no-op. */
  emitRuntimeEvent?: RuntimeEventEmitter;
  log: (message: string) => void;
  /** Bound on the emit wait; a hang must never pin a business transition. */
  timeoutMs?: number;
}

/** The AppDeps-facing shape: type + subject ids + flat payload, never throws. */
export type EmitAppEvent = (
  type: AppEventType,
  subjectIds: readonly string[],
  payload: AppEventPayload,
) => Promise<void>;

const DEFAULT_TIMEOUT_MS = 3_000;

/** `<type>:<id>[:<id>…]` with component-encoded ids — the durable fact identity. */
export function buildAppEventKey(type: AppEventType, subjectIds: readonly string[]): string {
  return [type as string, ...subjectIds.map((id) => encodeURIComponent(id))].join(':');
}

export async function emitAppEvent(
  deps: AppEventsSeamDeps,
  type: AppEventType,
  subjectIds: readonly string[],
  payload: AppEventPayload,
): Promise<void> {
  const subject = subjectIds.join(':');
  try {
    const emit = deps.emitRuntimeEvent;
    if (typeof emit !== 'function') {
      deps.log(`app-event ${type} [${subject}] skipped: no runtime events surface`);
      return;
    }
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const attempt = Promise.resolve().then(() =>
      emit(type, { ...payload }, { idempotencyKey: buildAppEventKey(type, subjectIds) }),
    );
    // A settlement landing after the timeout already resolved this call must
    // never surface as an unhandled rejection.
    attempt.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        attempt.then(() => 'emitted' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
        }),
      ]);
      if (outcome === 'timeout') {
        deps.log(`app-event ${type} [${subject}] emit timed out after ${timeoutMs}ms`);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch (err) {
    deps.log(`app-event ${type} [${subject}] emit failed: ${describeEmitError(err)}`);
  }
}

function describeEmitError(err: unknown): string {
  const parts: string[] = [];
  if (err !== null && typeof err === 'object') {
    const { code, status } = err as { code?: unknown; status?: unknown };
    if (typeof code === 'string' && code.length > 0) parts.push(code);
    if (typeof status === 'number') parts.push(String(status));
  }
  parts.push(err instanceof Error ? err.message : String(err));
  return parts.join(' ');
}
