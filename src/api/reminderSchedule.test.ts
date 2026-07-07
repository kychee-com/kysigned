/**
 * reminderSchedule — F-29 / F-5.5. Scheduling the two automated reminders as
 * deferred durable runs at send time (replaces the reminder-sweep cron poll).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleSignerReminders, REMINDER_INTERVALS_DAYS } from './reminderSchedule.js';
import type { CreateRunOptions } from '../functions/runs.js';

describe('scheduleSignerReminders (F-29 / F-5.5)', () => {
  it('schedules one deferred reminder_send run per interval (idempotency = signer id + reminder number)', async () => {
    const calls: CreateRunOptions[] = [];
    await scheduleSignerReminders(
      async (opts) => { calls.push(opts); return { runId: 'r', deduplicated: false }; },
      'env-1',
      { id: 'sig-1', status: 'pending' },
    );
    assert.equal(calls.length, REMINDER_INTERVALS_DAYS.length);
    assert.equal(calls[0].eventType, 'reminder_send');
    assert.equal(calls[0].idempotencyKey, 'sig-1:reminder:1');
    assert.equal(calls[0].delay, '3d');
    assert.deepEqual(calls[0].payload, { envelopeId: 'env-1', signerId: 'sig-1', reminderNumber: 1 });
    assert.equal(calls[1].idempotencyKey, 'sig-1:reminder:2');
    assert.equal(calls[1].delay, '7d');
    assert.equal(calls[1].payload?.reminderNumber, 2);
  });

  it('schedules nothing for a non-pending signer', async () => {
    const calls: CreateRunOptions[] = [];
    await scheduleSignerReminders(
      async (o) => { calls.push(o); return { runId: 'r', deduplicated: false }; },
      'e',
      { id: 's', status: 'signed' },
    );
    assert.equal(calls.length, 0);
  });

  it('is a no-op when createRun is unwired (forker without runs / unit test)', async () => {
    await scheduleSignerReminders(undefined, 'e', { id: 's', status: 'pending' }); // must not throw
  });

  it('swallows a createRun failure — reminders are best-effort, creation must not break', async () => {
    await scheduleSignerReminders(
      async () => { throw new Error('run402 unavailable'); },
      'e',
      { id: 's', status: 'pending' },
    ); // must resolve, not reject
  });
});
