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
import type { TimestampProof, TimestampProvider } from '../../timestamp/contract.js';
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
/**
 * True while ANY of the artifact's OTS anchors is still pending — the `.eml`
 * proof (`ts_status`), the AC-169 key-observation anchor, or the F-32.9
 * statement anchor. Drives the upgrade chain's entry/terminal condition so the
 * aux anchors keep advancing even after the `.eml` proof completes (before this,
 * they were written once at receipt and never advanced — the AC-169 defect).
 */
export function artifactHasPendingOts(artifact: Pick<SignatureArtifact, 'ts_status' | 'key_obs_ots_proof' | 'archive_statement_ots'>): boolean {
  return (
    artifact.ts_status === 'pending' ||
    artifact.key_obs_ots_proof?.status === 'pending' ||
    artifact.archive_statement_ots?.status === 'pending'
  );
}

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

    // The SAME pass advances every other pending OTS anchor on the artifact
    // (AC-169 key-observation + F-32.9 statement). Best-effort per proof; an
    // advance failure leaves that anchor pending for the next link.
    const advanceAux = async (p: TimestampProof | null): Promise<TimestampProof | undefined> => {
      if (!p || p.status !== 'pending' || !provider.upgrade) return undefined;
      try {
        return await provider.upgrade(p);
      } catch {
        return undefined;
      }
    };
    const keyObsOts = await advanceAux(artifact.key_obs_ots_proof);
    const stmtOts = await advanceAux(artifact.archive_statement_ots);
    const aux = {
      ...(keyObsOts ? { keyObsOtsProof: keyObsOts } : {}),
      ...(stmtOts ? { archiveStatementOts: stmtOts } : {}),
    };
    const auxStillPending =
      (keyObsOts ?? artifact.key_obs_ots_proof)?.status === 'pending' ||
      (stmtOts ?? artifact.archive_statement_ots)?.status === 'pending';

    if (proof.status === 'complete') {
      // ts_status tracks the `.eml` anchor (unchanged semantics); the chain stays
      // alive (`still_pending`) while an aux anchor has not confirmed yet.
      await updateArtifactTimestamps(pool, artifact.id, { otsProof: proof, tsStatus: 'complete', ...aux });
      if (auxStillPending) return 'still_pending';
      return hadProof ? 'upgraded' : 'restamped';
    }
    await updateArtifactTimestamps(pool, artifact.id, { otsProof: proof, ...aux });
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
