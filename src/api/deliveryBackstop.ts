/**
 * deliveryBackstop — F-29 / F-9.9 / AC-124. A bounded delivery-confirmation
 * backstop, scheduled as a deferred durable run.
 *
 * When a signing-request send fails with an AMBIGUOUS / unclassifiable error (the
 * transient branch — no hard-bounce signal, `isUndeliverableRecipientError` false),
 * we cannot tell whether it will ever arrive. A MISCLASSIFIED-permanent failure is
 * the danger: the send was never accepted by the provider, so no `bounced` event
 * will ever come (the F-9.8 async path can't fire), and the signer would sit
 * `pending` forever. This schedules ONE deferred `delivery_backstop` run at +window
 * (operator-config `KYSIGNED_DELIVERY_BACKSTOP_HOURS`, default 24h): if the window
 * closes with the signer still `pending` — neither a `delivered`/signed signal nor
 * an already-recorded `undeliverable` — the handler (runHandlers.ts) marks the
 * signer undeliverable and notifies the creator "anyway" (F-9.9). It is scoped to
 * the transient-send-failure population ONLY; a successfully-sent, still-unsigned
 * signer is never a backstop target.
 *
 * Best-effort: a create failure is swallowed (the envelope is already persisted; the
 * F-9.8 sync path + reminders still recover the common cases). No-op when `createRun`
 * is unwired (forker without runs / unit test). Idempotency = the signing-request
 * (signer) id, so a re-run of the send path dedups instead of double-scheduling.
 */
import type { CreateRun } from '../functions/runs.js';

/** F-9.9 default delivery-confirmation window when the operator configures none. */
export const DEFAULT_DELIVERY_BACKSTOP_DELAY = '24h';

export async function scheduleDeliveryBackstop(
  createRun: CreateRun | undefined,
  envelopeId: string,
  signerId: string,
  delay: string | number = DEFAULT_DELIVERY_BACKSTOP_DELAY,
): Promise<void> {
  if (!createRun) return; // forker without runs / unit test
  try {
    await createRun({
      eventType: 'delivery_backstop',
      idempotencyKey: `${signerId}:delivery-backstop`,
      payload: { envelopeId, signerId },
      delay,
    });
  } catch (err) {
    console.error(`delivery-backstop schedule failed (${signerId}):`, err);
  }
}
