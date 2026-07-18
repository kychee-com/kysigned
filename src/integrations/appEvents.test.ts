/**
 * appEvents.test.ts — F-36 app-events seam (60.2, DD-43).
 *
 * The seam is the ONE path business code emits run402 app events through:
 * it never throws or rejects (AC-196 — an emit failure must never gate a
 * business transition), derives a stable idempotency key from the subject's
 * domain ids (AC-194 — the gateway dedupes (project_id, key) forever), and
 * constrains payloads at the type level to flat ids/counts/enums (AC-195).
 * Platform errors are read structurally (`code`/`status`) because the
 * deployed runtime bundles its own `@run402/functions` copy — a cross-copy
 * `instanceof` is unreliable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emitAppEvent,
  buildAppEventKey,
  type AppEventsSeamDeps,
  type AppEventPayload,
} from './appEvents.js';

function collector(): { lines: string[]; log: (message: string) => void } {
  const lines: string[] = [];
  return { lines, log: (message: string) => void lines.push(message) };
}

test('emits once through the runtime emitter with type, payload, and the derived idempotency key', async () => {
  const calls: Array<{
    type: string;
    payload?: Record<string, unknown>;
    opts?: { idempotencyKey?: string };
  }> = [];
  const { lines, log } = collector();
  const deps: AppEventsSeamDeps = {
    emitRuntimeEvent: async (type, payload, opts) => {
      calls.push({ type, payload, opts });
      return { deduplicated: false };
    },
    log,
  };

  await emitAppEvent(deps, 'signature_completed', ['env-1', 'sig-2'], {
    envelope_id: 'env-1',
    signature_artifact_id: 'sig-2',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'signature_completed');
  assert.deepEqual(calls[0].payload, { envelope_id: 'env-1', signature_artifact_id: 'sig-2' });
  assert.equal(calls[0].opts?.idempotencyKey, 'signature_completed:env-1:sig-2');
  assert.equal(lines.length, 0, 'success is silent');
});

test('buildAppEventKey component-encodes ids so the key stays colon-delimited and stable', () => {
  assert.equal(
    buildAppEventKey('sweep_anomaly', ['grant:monitor', '2026-07-18']),
    'sweep_anomaly:grant%3Amonitor:2026-07-18',
  );
});

test('a synchronously-throwing emitter never propagates — resolves and logs type, ids, structural code', async () => {
  const { lines, log } = collector();
  const deps: AppEventsSeamDeps = {
    emitRuntimeEvent: () => {
      throw Object.assign(new Error('daily quota exhausted'), { code: 'QUOTA_EXCEEDED', status: 403 });
    },
    log,
  };

  await assert.doesNotReject(
    emitAppEvent(deps, 'envelope_completed', ['env-9'], { envelope_id: 'env-9' }),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /envelope_completed/);
  assert.match(lines[0], /env-9/);
  assert.match(lines[0], /QUOTA_EXCEEDED/);
  assert.match(lines[0], /403/);
});

test('an async-rejecting emitter never propagates — resolves and logs the message', async () => {
  const { lines, log } = collector();
  const deps: AppEventsSeamDeps = {
    emitRuntimeEvent: async () => {
      throw new Error('socket hang up');
    },
    log,
  };

  await assert.doesNotReject(
    emitAppEvent(deps, 'signer_declined', ['env-3', 'signer-7'], { envelope_id: 'env-3', signer_id: 'signer-7' }),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /signer_declined/);
  assert.match(lines[0], /socket hang up/);
});

test('an absent runtime emitter (lagging platform module) is a logged no-op', async () => {
  const { lines, log } = collector();
  const deps: AppEventsSeamDeps = { log };

  await assert.doesNotReject(
    emitAppEvent(deps, 'signer_declined', ['env-3'], { envelope_id: 'env-3' }),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /signer_declined/);
  assert.match(lines[0], /no runtime events surface/);
});

test('a hanging emitter resolves within the bounded wait and logs a timeout', async () => {
  const { lines, log } = collector();
  const deps: AppEventsSeamDeps = {
    emitRuntimeEvent: () => new Promise(() => {}),
    log,
    timeoutMs: 20,
  };

  const started = Date.now();
  await emitAppEvent(deps, 'envelope_undeliverable', ['env-4'], { envelope_id: 'env-4' });
  assert.ok(Date.now() - started < 5_000, 'resolved well before any default network timeout');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /timed out/);
  assert.match(lines[0], /envelope_undeliverable/);
});

test('a rejection landing after the timeout already resolved is swallowed, not unhandled', async () => {
  const { log } = collector();
  let rejectLate: ((reason: unknown) => void) | undefined;
  const deps: AppEventsSeamDeps = {
    emitRuntimeEvent: () =>
      new Promise((_resolve, reject) => {
        rejectLate = reject;
      }),
    log,
    timeoutMs: 5,
  };

  await emitAppEvent(deps, 'sweep_anomaly', ['archive-reconciliation', '2026-07-18'], {
    monitor: 'archive_reconciliation',
    still_failing: 2,
  });
  rejectLate?.(new Error('late gateway 500'));
  // A leaked rejection would fail the run via node:test's unhandled-rejection
  // propagation; settling one macrotask proves it was attached-and-swallowed.
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(true);
});

// AC-195 compile-time shape: payload values are flat ids/counts/enums —
// nested objects and arrays must not typecheck (verified by `npm run build`).
// @ts-expect-error — AppEventPayload forbids nested objects
const badNested: AppEventPayload = { nested: { a: 1 } };
void badNested;
// @ts-expect-error — AppEventPayload forbids arrays
const badArray: AppEventPayload = { list: ['a'] };
void badArray;
