/**
 * timestampSchedule — F-29 / F-6.6 OpenTimestamps upgrade as a SELF-RESCHEDULING
 * durable run (one chain per artifact), replacing the hourly upgrade sweep.
 *
 * An OTS proof starts `pending` (the calendar holds the commitment) and becomes
 * `complete` once Bitcoin confirms (~hours). When a signature artifact is recorded
 * pending, we schedule ONE deferred `timestamp_upgrade` run. Each run tries to
 * advance the proof; if it's still pending it schedules the NEXT attempt (a fresh
 * run, so idempotency = artifactId + attempt keeps the chain going instead of
 * deduping), until `complete` (terminal) or a safety cap.
 *
 * `upgradeOneArtifact` is the per-artifact advance (shared with the legacy batch
 * sweep so both behave identically); `scheduleTimestampUpgrade` enqueues the next
 * link in the chain.
 */
import { Buffer } from 'node:buffer';
import type { DbPool } from '../../db/pool.js';
import { updateArtifactTimestamps } from '../../db/signatureArtifacts.js';
import type { SignatureArtifact } from '../../db/types.js';
import type { TimestampProvider } from '../../timestamp/contract.js';
import type { CreateRun } from '../../functions/runs.js';

export type UpgradeAction = 'upgraded' | 'restamped' | 'still_pending' | 'error';

/** Delay between self-reschedule attempts — OTS/Bitcoin confirmation is ~hours. */
export const TIMESTAMP_UPGRADE_DELAY = '2h';
/** Safety cap on the reschedule chain (~15 days at 2h) so a never-confirming proof
 *  can't self-reschedule forever; the proof stays persisted as `pending` (the
 *  verifier shows a grey pending anchor, never red). */
export const TIMESTAMP_UPGRADE_MAX_ATTEMPTS = 180;

/**
 * F-6.6 — advance ONE pending artifact's OTS proof. Normal case: `upgrade(proof)`;
 * recovery case (a prior stamp outage left `ots_proof` null): re-stamp from the
 * stored `sha256_eml`. Persists the refreshed/complete proof. Fail-proof: a
 * provider error is isolated (returns `'error'`), leaving the artifact pending.
 */
export async function upgradeOneArtifact(
  pool: DbPool,
  artifact: SignatureArtifact,
  provider: TimestampProvider,
): Promise<UpgradeAction> {
  try {
    const hadProof = artifact.ots_proof != null;
    let proof = artifact.ots_proof;
    if (!proof) {
      const digest = Uint8Array.from(Buffer.from(artifact.sha256_eml, 'hex'));
      proof = await provider.stamp(digest);
    } else if (provider.upgrade) {
      proof = await provider.upgrade(proof);
    }
    if (proof.status === 'complete') {
      await updateArtifactTimestamps(pool, artifact.id, { otsProof: proof, tsStatus: 'complete' });
      return hadProof ? 'upgraded' : 'restamped';
    }
    await updateArtifactTimestamps(pool, artifact.id, { otsProof: proof });
    return 'still_pending';
  } catch {
    return 'error';
  }
}

/**
 * Schedule the next `timestamp_upgrade` attempt for an artifact (idempotency =
 * `<artifactId>:tsup:<attempt>`, so each link in the chain is a distinct run).
 * Best-effort: a create failure is swallowed (the /verify anchor just stays
 * pending). No-op when `createRun` is unwired.
 */
export async function scheduleTimestampUpgrade(
  createRun: CreateRun | undefined,
  artifactId: string,
  attempt: number,
): Promise<void> {
  if (!createRun) return;
  try {
    await createRun({
      eventType: 'timestamp_upgrade',
      idempotencyKey: `${artifactId}:tsup:${attempt}`,
      payload: { artifactId, attempt },
      delay: TIMESTAMP_UPGRADE_DELAY,
    });
  } catch (err) {
    console.error(`timestamp_upgrade schedule failed (${artifactId} #${attempt}):`, err);
  }
}
