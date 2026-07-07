/**
 * expirySchedule — F-29 / DD-16 envelope expiry as a deferred durable run.
 *
 * At creation, an envelope with a deadline (`expiry_at`) schedules ONE
 * `envelope_expire` run to fire at that instant (idempotency = envelope id),
 * instead of an hourly cron scanning for past-deadline envelopes. The handler
 * (runHandlers.ts) re-checks at fire time: it only expires an envelope that is
 * still `active` and actually past its deadline, so a completed / voided envelope
 * self-cancels. An envelope with no `expiry_at` never schedules one.
 */
import type { CreateRun } from '../functions/runs.js';

/**
 * Schedule the deferred expiry run at `expiryAt` (absolute `runAt`). Best-effort:
 * a create failure is swallowed (the envelope is created + signing requests are
 * sent regardless). No-op when the envelope has no deadline or `createRun` is
 * unwired.
 */
export async function scheduleEnvelopeExpiry(
  createRun: CreateRun | undefined,
  envelopeId: string,
  expiryAt: Date | null,
): Promise<void> {
  if (!createRun || !expiryAt) return;
  try {
    await createRun({
      eventType: 'envelope_expire',
      // `:expiry`-namespaced: run402 idempotency keys are scoped per function
      // across ALL event types, so a bare envelopeId here collided with the
      // completion enqueue's key and 409'd it — completion_distribute was never
      // created (gh-566 layer 2). Every schedule key must be namespaced.
      idempotencyKey: `${envelopeId}:expiry`,
      payload: { envelopeId },
      runAt: expiryAt.toISOString(),
    });
  } catch (err) {
    console.error(`expiry schedule failed for ${envelopeId}:`, err);
  }
}
