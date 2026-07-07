/**
 * expirySchedule — F-29 / DD-16. Scheduling the expiry as a deferred durable run
 * at the envelope deadline (replaces the hourly expiry-sweep cron).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleEnvelopeExpiry } from './expirySchedule.js';
import type { CreateRunOptions } from '../functions/runs.js';

describe('scheduleEnvelopeExpiry (F-29 / DD-16)', () => {
  it('schedules an envelope_expire run at the deadline (runAt = expiry, idempotency = envelope id)', async () => {
    const calls: CreateRunOptions[] = [];
    const expiry = new Date('2026-08-01T12:00:00.000Z');
    await scheduleEnvelopeExpiry(
      async (opts) => { calls.push(opts); return { runId: 'r', deduplicated: false }; },
      'env-1',
      expiry,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].eventType, 'envelope_expire');
    // Namespaced (gh-566 layer 2): a bare envelopeId collided with the completion
    // enqueue's key — run402 idempotency keys are scoped per function, not per event
    // type, so two run kinds sharing one key 409 each other.
    assert.equal(calls[0].idempotencyKey, 'env-1:expiry');
    assert.equal(calls[0].runAt, expiry.toISOString());
    assert.deepEqual(calls[0].payload, { envelopeId: 'env-1' });
  });

  it('schedules nothing when the envelope has no deadline', async () => {
    const calls: CreateRunOptions[] = [];
    await scheduleEnvelopeExpiry(
      async (o) => { calls.push(o); return { runId: 'r', deduplicated: false }; },
      'env-1',
      null,
    );
    assert.equal(calls.length, 0);
  });

  it('is a no-op when createRun is unwired', async () => {
    await scheduleEnvelopeExpiry(undefined, 'env-1', new Date('2026-08-01T12:00:00.000Z'));
  });

  it('swallows a createRun failure (best-effort — creation must not break)', async () => {
    await scheduleEnvelopeExpiry(
      async () => { throw new Error('run402 unavailable'); },
      'env-1',
      new Date('2026-08-01T12:00:00.000Z'),
    );
  });
});
