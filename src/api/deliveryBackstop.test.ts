/**
 * deliveryBackstop — F-29 / F-9.9 / AC-124. The bounded delivery-confirmation
 * backstop scheduled as a deferred durable run when a signing-request send fails
 * with an ambiguous/unclassifiable error.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleDeliveryBackstop, DEFAULT_DELIVERY_BACKSTOP_DELAY } from './deliveryBackstop.js';
import type { CreateRunOptions } from '../functions/runs.js';

describe('scheduleDeliveryBackstop (F-29 / F-9.9 / AC-124)', () => {
  it('schedules ONE deferred delivery_backstop run keyed to the signing-request, at the given window', async () => {
    const calls: CreateRunOptions[] = [];
    await scheduleDeliveryBackstop(
      async (opts) => { calls.push(opts); return { runId: 'r', deduplicated: false }; },
      'env-1',
      'sig-1',
      '24h',
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].eventType, 'delivery_backstop');
    assert.equal(calls[0].idempotencyKey, 'sig-1:delivery-backstop');
    assert.equal(calls[0].delay, '24h');
    assert.deepEqual(calls[0].payload, { envelopeId: 'env-1', signerId: 'sig-1' });
  });

  it('uses the default 24h window when the operator sets none', async () => {
    const calls: CreateRunOptions[] = [];
    await scheduleDeliveryBackstop(
      async (o) => { calls.push(o); return { runId: 'r', deduplicated: false }; },
      'e',
      's',
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].delay, DEFAULT_DELIVERY_BACKSTOP_DELAY);
    assert.equal(DEFAULT_DELIVERY_BACKSTOP_DELAY, '24h');
  });

  it('is a no-op when createRun is unwired (forker without runs / unit test)', async () => {
    await scheduleDeliveryBackstop(undefined, 'e', 's'); // must not throw
  });

  it('swallows a createRun failure — the backstop is best-effort, creation must not break', async () => {
    await scheduleDeliveryBackstop(
      async () => { throw new Error('run402 unavailable'); },
      'e',
      's',
    ); // must resolve, not reject
  });
});
