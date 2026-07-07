/**
 * runHandlers — the durable-run event handlers (F-29).
 *
 * `buildRunHandlers(deps)` maps each run `event_type` to a handler that performs
 * ONE unit of app-owned background work — the work the deleted cron sweeps used
 * to POLL for, now delivered event-by-event by run402's durable runs. Pure +
 * `@run402/*`-free so every handler is unit-tested against fakes; the deployed
 * entry (`runtime.ts`) adapts these into `defineFunctionRuns` and translates the
 * two marker errors below into run402's retry protocol.
 *
 * Retry contract (the cron's polling, expressed as run402 retries):
 *   - RETURN a value        → success / terminal (run succeeds, no retry).
 *   - throw RetryableRunError → transient; run402 retries per the run's policy.
 *   - throw PermanentRunError → terminal failure; run402 does NOT retry.
 * `runtime.ts` maps these to `retryableFunctionRunError` / `permanentFunctionRunError`.
 */
import type { DbPool } from '../db/pool.js';
import type { EmailProvider } from '../email/types.js';
import { getEnvelope, getEnvelopeSigners, getSignerById, claimExpiredEnvelope, markEnvelopePdfDeleted } from '../db/envelopes.js';
import { distributeEnvelopeBundle, type DistributeBundleDeps } from '../api/distributeBundle.js';
import { shouldDeletePdf } from '../pdf/retention.js';
import { sweepRetention } from '../pdf/sweep.js';
import { purgeEnvelopeBlobs } from '../pdf/blobPurge.js';
import { handleCompletionDelivered, handleCompletionBounced } from '../api/emailWebhook.js';
import { scheduleCompletionRetention, RETENTION_RETRY_DELAY, RETENTION_MAX_FAST_ATTEMPTS } from '../api/retentionSchedule.js';
import { notifyEnvelopeAwaitingSeal } from '../api/sealEnvelope.js';
import { handleReplyReceived, handleBounce, type InboundEmailCtx } from '../api/signing/inboundEmail.js';
import { remindSigner, notifyEnvelopeExpired, handleUndeliverableSigningRequest, type ReminderSendCtx, type ExpirationStorage } from '../api/envelope.js';
import { runSignupGrantMonitor } from '../api/signupGrantMonitor.js';
import { getSignatureArtifactById } from '../db/signatureArtifacts.js';
import { upgradeOneArtifact, scheduleTimestampUpgrade, TIMESTAMP_UPGRADE_MAX_ATTEMPTS } from '../api/signing/timestampSchedule.js';
import type { TimestampProvider } from '../timestamp/contract.js';
import { RetryableRunError, PermanentRunError, type CreateRun } from './runs.js';

// Re-exported so existing importers (runtime.ts, tests) keep their import site.
export { RetryableRunError, PermanentRunError };

/** A run handler: does one unit of work; returns a summary or throws a marker. */
export type RunHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The subset of `AppDeps` the run handlers consume (AppDeps satisfies it). */
export interface RunHandlerDeps {
  pool: DbPool;
  distributeDeps: () => DistributeBundleDeps;
  inboundEmailCtx: () => InboundEmailCtx;
  reminderSendCtx: () => ReminderSendCtx;
  emailProvider: EmailProvider;
  operatorDomain: string;
  expirationStorage: () => ExpirationStorage;
  timestampProvider: () => TimestampProvider;
  createRun: CreateRun;
  /** F-16.6 / AC-97 — grants-per-24h above which the monitor alerts the operator. */
  signupGrantAlertThreshold: number;
}

/**
 * Injectable operations, defaulting to the real ones — lets a unit test drive a
 * handler's branching + retry mapping without re-exercising the (already-tested)
 * distribute / seal-notify / reconcile / notify / reminder internals.
 */
export interface RunHandlerOverrides {
  distribute?: typeof distributeEnvelopeBundle;
  notifySeal?: typeof notifyEnvelopeAwaitingSeal;
  remind?: typeof remindSigner;
  loadSigner?: typeof getSignerById;
  claimExpired?: typeof claimExpiredEnvelope;
  notifyExpired?: typeof notifyEnvelopeExpired;
  loadArtifact?: typeof getSignatureArtifactById;
  upgradeArtifact?: typeof upgradeOneArtifact;
  handleUndeliverable?: typeof handleUndeliverableSigningRequest;
}

export function buildRunHandlers(
  deps: RunHandlerDeps,
  overrides: RunHandlerOverrides = {},
): Record<string, RunHandler> {
  const distribute = overrides.distribute ?? distributeEnvelopeBundle;
  const notifySeal = overrides.notifySeal ?? notifyEnvelopeAwaitingSeal;
  const remind = overrides.remind ?? remindSigner;
  const loadSigner = overrides.loadSigner ?? getSignerById;
  const claimExpired = overrides.claimExpired ?? claimExpiredEnvelope;
  const notifyExpired = overrides.notifyExpired ?? notifyEnvelopeExpired;
  const loadArtifact = overrides.loadArtifact ?? getSignatureArtifactById;
  const upgradeArtifact = overrides.upgradeArtifact ?? upgradeOneArtifact;
  const markUndeliverable = overrides.handleUndeliverable ?? handleUndeliverableSigningRequest;

  return {
    /**
     * F-24 / F-9.1 — finalize ONE all-signed envelope (enqueued when its last
     * signer reaches `signed`, idempotency = envelope id). Auto-close → assemble
     * + distribute the bundle; manual → email "review & seal" + park in
     * `awaiting_seal`. Both underlying ops are idempotent, so a run402 retry (or
     * a duplicate enqueue that deduped to this run) never double-sends.
     */
    completion_distribute: async (payload) => {
      const envelopeId = typeof payload.envelopeId === 'string' ? payload.envelopeId : '';
      if (!envelopeId) throw new PermanentRunError('completion_distribute: payload.envelopeId is required');

      const envelope = await getEnvelope(deps.pool, envelopeId);
      if (!envelope) return { envelopeId, action: 'gone' }; // envelope removed — nothing to finalize (terminal)

      if (envelope.auto_close === false) {
        const r = await notifySeal(deps.pool, envelopeId, deps.distributeDeps());
        if (r.action === 'deferred') throw new RetryableRunError(`seal-notify deferred for ${envelopeId}`);
        return { envelopeId, mode: 'manual', action: r.action };
      }

      const r = await distribute(deps.pool, envelopeId, deps.distributeDeps());
      if (r.action === 'deferred' || r.action === 'partial') {
        throw new RetryableRunError(`distribute ${r.action} for ${envelopeId}`);
      }
      return { envelopeId, mode: 'auto', action: r.action, recipients: r.recipients, sent: r.sent };
    },

    /**
     * F-6.9 / F-29.6 — an inbound signing forward, delivered by run402's
     * `reply_received` EMAIL TRIGGER (run402 creates this run on the email event;
     * idempotency = message id; retry/redrive replace the reconciler). The handler
     * validates + records the signature and acks/bounces inline. See inboundEmail.ts.
     */
    reply_received: (payload) => handleReplyReceived(deps.inboundEmailCtx(), payload),

    /**
     * F-9.8 / F-29.6 — a hard-bounced signing request, delivered by run402's
     * `bounced` EMAIL TRIGGER: mark the signer undeliverable + notify the creator.
     */
    bounced: (payload) => handleBounce(deps.inboundEmailCtx(), payload),

    /**
     * F-9.9 / AC-124 — the bounded delivery-confirmation BACKSTOP. A deferred run
     * scheduled at +window (deliveryBackstop.ts) when a signing-request send failed
     * with an ambiguous/unclassifiable error — so no `bounced` event will ever confirm
     * it (a misclassified-permanent send was never accepted). Re-checks live state at
     * fire time: no-op if the envelope isn't active, the signer already signed / isn't
     * pending, or it's already undeliverable; otherwise the window closed with neither a
     * delivered nor a signed signal → mark the signer undeliverable + notify the creator
     * (the same F-9.8 path). Idempotency = signer id; a re-run just re-reads the state.
     */
    delivery_backstop: async (payload) => {
      const envelopeId = typeof payload.envelopeId === 'string' ? payload.envelopeId : '';
      const signerId = typeof payload.signerId === 'string' ? payload.signerId : '';
      if (!envelopeId || !signerId) {
        throw new PermanentRunError('delivery_backstop: envelopeId + signerId are required');
      }

      const envelope = await getEnvelope(deps.pool, envelopeId);
      if (!envelope || envelope.status !== 'active') return { signerId, action: 'skipped_inactive' };
      const signer = await loadSigner(deps.pool, signerId);
      if (!signer) return { signerId, action: 'skipped_gone' };
      if (signer.status !== 'pending') return { signerId, action: 'skipped_not_pending' }; // signed / superseded / declined
      if (signer.undeliverable_at) return { signerId, action: 'already_undeliverable' };

      // Window closed, signer still pending with no delivery/signature signal → mark
      // undeliverable + notify the creator "anyway" (F-9.9), so a misclassified send
      // can never leave a signer silently stuck.
      const ic = deps.inboundEmailCtx();
      const r = await markUndeliverable(
        { pool: ic.pool, emailProvider: ic.emailProvider, baseUrl: ic.baseUrl, operatorDomain: ic.operatorDomain },
        envelopeId,
        signer.email,
      );
      return { signerId, action: r.body.marked ? 'undeliverable_timeout' : 'noop' };
    },

    /**
     * F-5.5 — send ONE automated reminder (a deferred run scheduled at +3d/+7d when
     * the signing request went out; idempotency = signer id + reminder number).
     * Re-checks live state at fire time: no-op if the envelope isn't active or the
     * signer already signed / isn't pending, and idempotent within a reminder number
     * (`reminder_count >= reminderNumber` → already sent). A send failure retries.
     */
    reminder_send: async (payload) => {
      const envelopeId = typeof payload.envelopeId === 'string' ? payload.envelopeId : '';
      const signerId = typeof payload.signerId === 'string' ? payload.signerId : '';
      const reminderNumber = typeof payload.reminderNumber === 'number' ? payload.reminderNumber : 0;
      if (!envelopeId || !signerId || !reminderNumber) {
        throw new PermanentRunError('reminder_send: envelopeId, signerId, reminderNumber are required');
      }

      const envelope = await getEnvelope(deps.pool, envelopeId);
      if (!envelope || envelope.status !== 'active') return { signerId, action: 'skipped_inactive' };
      const signer = await loadSigner(deps.pool, signerId);
      if (!signer || signer.status !== 'pending') return { signerId, action: 'skipped_not_pending' };
      // F-9.9 / 36.2 — a signer marked undeliverable (by the F-9.8 bounce path or the
      // delivery backstop) keeps status:pending, so guard here or reminders would still
      // nudge a known-dead address.
      if (signer.undeliverable_at) return { signerId, action: 'skipped_undeliverable' };
      if (signer.reminder_count >= reminderNumber) return { signerId, action: 'already_sent' };

      const ctx = deps.reminderSendCtx();
      const senderName = envelope.sender_email ?? ctx.operatorDomain ?? 'kysigned.com';
      try {
        await remind(ctx, envelope, signer, senderName); // sends + bumps reminder_count
      } catch (err) {
        throw new RetryableRunError(`reminder send failed for ${signerId}: ${(err as Error).message}`);
      }
      return { signerId, reminderNumber, action: 'reminded' };
    },

    /**
     * DD-16 — expire ONE envelope at its deadline (a deferred run scheduled at
     * creation with runAt = expiry_at, idempotency = envelope id). Atomically
     * claims it (active + actually past deadline → expired) then notifies all
     * parties. A no-longer-active / not-yet-due envelope self-cancels (`skipped`).
     * The notice is best-effort (matches the old sweep): a send failure is logged,
     * not retried — a retry can't re-claim an already-expired row.
     */
    envelope_expire: async (payload) => {
      const envelopeId = typeof payload.envelopeId === 'string' ? payload.envelopeId : '';
      if (!envelopeId) throw new PermanentRunError('envelope_expire: payload.envelopeId is required');

      const claimed = await claimExpired(deps.pool, envelopeId);
      if (!claimed) return { envelopeId, action: 'skipped' }; // completed / voided / not yet due / gone

      try {
        await notifyExpired(deps.pool, claimed, deps.emailProvider, deps.expirationStorage(), deps.operatorDomain);
      } catch (err) {
        console.error(`envelope_expire: notice failed for ${envelopeId}:`, err);
      }
      return { envelopeId, action: 'expired' };
    },

    /**
     * F-6.6 — advance ONE artifact's OpenTimestamps proof; SELF-RESCHEDULE until
     * Bitcoin confirms (the deferred chain replaces the hourly upgrade sweep).
     * Terminal once the proof is `complete` (or the artifact vanished / already
     * completed). Still pending → schedule the next attempt (bounded by
     * TIMESTAMP_UPGRADE_MAX_ATTEMPTS; a never-confirming proof stays pending — the
     * verifier shows a grey anchor, never red).
     */
    timestamp_upgrade: async (payload) => {
      const artifactId = typeof payload.artifactId === 'string' ? payload.artifactId : '';
      const attempt = typeof payload.attempt === 'number' ? payload.attempt : 1;
      if (!artifactId) throw new PermanentRunError('timestamp_upgrade: payload.artifactId is required');

      const artifact = await loadArtifact(deps.pool, artifactId);
      if (!artifact || artifact.ts_status !== 'pending') return { artifactId, action: 'done' }; // gone / already complete

      const action = await upgradeArtifact(deps.pool, artifact, deps.timestampProvider());
      if (action === 'upgraded' || action === 'restamped') return { artifactId, action }; // complete → terminal

      // still_pending / error → keep the self-reschedule chain going, bounded.
      if (attempt < TIMESTAMP_UPGRADE_MAX_ATTEMPTS) {
        await scheduleTimestampUpgrade(deps.createRun, artifactId, attempt + 1);
        return { artifactId, action: 'rescheduled', attempt: attempt + 1 };
      }
      return { artifactId, action: 'gave_up', attempt };
    },

    /**
     * F-16.6 / AC-97 — the daily trial-credit abuse monitor: the ONE genuinely-
     * periodic concern. Delivered by a run402 SCHEDULE TRIGGER (deploy.ts) that
     * enqueues this run daily; it emails the operator on an issuance spike (so they
     * can disable the grant via config + redeploy). Stats land in run402's run logs.
     */
    signup_grant_monitor: async () => ({
      ...(await runSignupGrantMonitor(deps.pool, {
        emailProvider: deps.emailProvider,
        operatorDomain: deps.operatorDomain,
        alertThreshold: deps.signupGrantAlertThreshold,
      })),
    }),

    /**
     * F-9.3 / F-013 — ephemeral retention for ONE completed envelope; SELF-
     * RESCHEDULE until deletable (the deferred chain replaces the removed cron).
     * Scheduled when the bundle is distributed (retentionSchedule.ts). Re-evaluates
     * shouldDeletePdf: eligible (all completion emails delivered, or the 30-day cap)
     * → stamp pdf_deleted_at + purge the stored document + covers at their REAL keys
     * (NOT the always-null pdf_storage_key — the F-013 bug); not eligible → schedule
     * the next fast attempt, bounded by RETENTION_MAX_FAST_ATTEMPTS, after which the
     * daily retention_sweep owns the 7-day / 30-day tail. Idempotent: already-purged
     * or gone → terminal no-op.
     */
    completion_retention: async (payload) => {
      const envelopeId = typeof payload.envelopeId === 'string' ? payload.envelopeId : '';
      const attempt = typeof payload.attempt === 'number' ? payload.attempt : 1;
      if (!envelopeId) throw new PermanentRunError('completion_retention: payload.envelopeId is required');

      const envelope = await getEnvelope(deps.pool, envelopeId);
      if (!envelope) return { envelopeId, action: 'gone' };
      if (envelope.pdf_deleted_at) return { envelopeId, action: 'already_purged' };

      const signers = await getEnvelopeSigners(deps.pool, envelopeId);
      if (shouldDeletePdf(envelope, signers, new Date())) {
        // Stamp first (the shared-document guard in purgeEnvelopeBlobs reads it),
        // then free the real blobs.
        await markEnvelopePdfDeleted(deps.pool, envelopeId, new Date());
        const r = await purgeEnvelopeBlobs(deps.pool, deps.expirationStorage(), envelope, signers);
        return { envelopeId, action: 'purged', deleted: r.deleted, failed: r.failed };
      }
      // Not yet deletable (awaiting delivery confirmations). Keep the fast chain
      // going; once exhausted, the daily retention_sweep takes over.
      if (attempt < RETENTION_MAX_FAST_ATTEMPTS) {
        await scheduleCompletionRetention(deps.createRun, envelopeId, attempt + 1, RETENTION_RETRY_DELAY);
        return { envelopeId, action: 'rescheduled', attempt: attempt + 1 };
      }
      return { envelopeId, action: 'deferred_to_sweep', attempt };
    },

    /**
     * F-9.3 / F-013 — the daily retention BACKSTOP (a run402 SCHEDULE trigger,
     * deploy.ts). Sweeps every non-purged terminal-state envelope and purges the
     * ones shouldDeletePdf says are due — catching the 7-day bounce fallback, the
     * 30-day hard cap, and any envelope a deferred completion_retention chain missed
     * (a lost schedule, or a rare shared-document race). Belt-and-suspenders for the
     * privacy guarantee that no document blob outlives its retention window.
     */
    retention_sweep: async () => ({ ...(await sweepRetention(deps.pool, deps.expirationStorage(), new Date())) }),

    /**
     * F-9.3 / F-013 — a completion email was DELIVERED (run402 `delivery` EMAIL
     * TRIGGER on the notifications mailbox): stamp that signer's delivery marker so
     * the "everyone got their copy → delete the blob" happy path can fire fast.
     */
    completion_delivery: (payload) => handleCompletionDelivered(deps.pool, payload),

    /**
     * F-9.3 / F-013 — a completion email hard-BOUNCED (run402 `bounced` EMAIL
     * TRIGGER on the notifications mailbox): stamp the bounce marker, arming the
     * 7-day bounce-fallback deletion in shouldDeletePdf.
     */
    completion_bounced: (payload) => handleCompletionBounced(deps.pool, payload),
  };
}
