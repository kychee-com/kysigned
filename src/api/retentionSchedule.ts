/**
 * retentionSchedule — F-9.3 / F-013: the ephemeral-retention deletion as a
 * SELF-RESCHEDULING durable run (one chain per completed envelope), replacing the
 * cron the F-29.6 architecture removed.
 *
 * When an envelope's bundle is distributed, we schedule ONE deferred
 * `completion_retention` run. Each run re-evaluates shouldDeletePdf: once every
 * signer's completion email is confirmed delivered (or the 30-day cap passes) it
 * purges the stored document + covers; otherwise it schedules the NEXT attempt (a
 * fresh run, so idempotency = envelopeId + attempt keeps the chain going instead
 * of deduping). The fast chain runs for ~a day to catch the happy path quickly;
 * the daily `retention_sweep` backstop then owns the slow tail (7-day bounce
 * fallback, 30-day hard cap) and any envelope a lost schedule missed.
 *
 * Mirrors timestampSchedule.ts (the OTS-upgrade chain) so the two self-reschedule
 * patterns read the same.
 */
import type { CreateRun } from '../functions/runs.js';

/** Initial wait after distribution — long enough for SES delivery webhooks to land. */
export const RETENTION_INITIAL_DELAY = '30m';
/** Delay between fast self-reschedule attempts. */
export const RETENTION_RETRY_DELAY = '3h';
/** Fast-chain cap (~a day at 3h): after this the daily retention_sweep owns the
 *  7-day / 30-day tail, so the per-envelope chain stays short. */
export const RETENTION_MAX_FAST_ATTEMPTS = 8;

/**
 * Schedule the next `completion_retention` attempt for an envelope (idempotency =
 * `<envelopeId>:retention:<attempt>`, so each link in the chain is a distinct
 * run). Best-effort: a create failure is swallowed (the daily retention_sweep is
 * the backstop). No-op when `createRun` is unwired (e.g. a fork without run402).
 */
export async function scheduleCompletionRetention(
  createRun: CreateRun | undefined,
  envelopeId: string,
  attempt: number,
  delay: string,
): Promise<void> {
  if (!createRun) return;
  try {
    await createRun({
      eventType: 'completion_retention',
      idempotencyKey: `${envelopeId}:retention:${attempt}`,
      payload: { envelopeId, attempt },
      delay,
    });
  } catch (err) {
    console.error(`completion_retention schedule failed (${envelopeId} #${attempt}):`, err);
  }
}
