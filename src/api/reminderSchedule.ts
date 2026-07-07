/**
 * reminderSchedule — F-29 / F-5.5 automated reminders as deferred durable runs.
 *
 * When a signer's signing request is SENT (envelope creation + add-signer), we
 * schedule the whole reminder sequence up front as run402 durable runs — one
 * deferred `reminder_send` per interval (default +3d then +7d) — instead of a
 * cron polling for "due" reminders every hour. The `reminder_send` handler
 * (runHandlers.ts) re-checks the live state at fire time and no-ops if the signer
 * has signed / the envelope is no longer active.
 *
 * Idempotency = signer id + reminder number, so re-scheduling the same signer (a
 * re-run of the create path, or a webhook replay) dedups instead of doubling reminders.
 */
import type { EnvelopeSigner } from '../db/types.js';
import type { CreateRun } from '../functions/runs.js';

/** F-5.5 default schedule: reminders 3 days then 7 days after send (max 2). */
export const REMINDER_INTERVALS_DAYS = [3, 7] as const;

/**
 * Schedule this signer's automated reminders as deferred durable runs. Best-effort:
 * a create failure is swallowed (reminders are non-critical nudges, and the creator
 * can always send them manually via `handleRemind`) so it never breaks the create
 * that already persisted the envelope + sent the signing request. No-op when the
 * signer isn't pending or `createRun` is unwired.
 */
export async function scheduleSignerReminders(
  createRun: CreateRun | undefined,
  envelopeId: string,
  signer: Pick<EnvelopeSigner, 'id' | 'status'>,
  intervalsDays: readonly number[] = REMINDER_INTERVALS_DAYS,
): Promise<void> {
  if (!createRun) return; // forker without runs / unit test
  if (signer.status !== 'pending') return; // already signed / undeliverable — no reminders
  for (let i = 0; i < intervalsDays.length; i++) {
    const reminderNumber = i + 1;
    try {
      await createRun({
        eventType: 'reminder_send',
        idempotencyKey: `${signer.id}:reminder:${reminderNumber}`,
        payload: { envelopeId, signerId: signer.id, reminderNumber },
        delay: `${intervalsDays[i]}d`,
      });
    } catch (err) {
      console.error(`reminder schedule failed (${signer.id} #${reminderNumber}):`, err);
    }
  }
}
