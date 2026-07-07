/**
 * Retention sweep — F8.6 / F-9.3 (the BACKSTOP, F-013).
 *
 * The per-envelope happy path is a deferred `completion_retention` run scheduled
 * at completion (runHandlers.ts); this sweep is the periodic safety net that
 * catches the slow tail (7-day bounce fallback, 30-day hard cap) and any envelope
 * a deferred run missed (a lost schedule, or the rare shared-document race). It:
 *   1. selects every non-purged terminal-state envelope (voided / expired /
 *      completed) — NOT "has a pdf_storage_key", which is always null (F-013);
 *   2. evaluates shouldDeletePdf for each;
 *   3. when true, stamps pdf_deleted_at and purges the envelope's REAL blobs
 *      (document D + per-signer covers) via purgeEnvelopeBlobs.
 *
 * Stamp-before-purge is deliberate: purgeEnvelopeBlobs only deletes the shared
 * document D when no OTHER envelope still references it, and that guard reads
 * pdf_deleted_at, so the current envelope must already be marked. Failures on
 * individual deletes are counted but do not abort the sweep — the next run retries.
 */
import type { DbPool } from '../db/pool.js';
import { rehydrateEnvelope, rehydrateSigner } from '../db/envelopes.js';
import { shouldDeletePdf } from './retention.js';
import { purgeEnvelopeBlobs } from './blobPurge.js';

export interface RetentionStorage {
  deletePdf(key: string): Promise<void>;
}

export interface SweepResult {
  scanned: number;
  deleted: number;
  failed: number;
}

export async function sweepRetention(
  pool: DbPool,
  storage: RetentionStorage,
  now: Date = new Date()
): Promise<SweepResult> {
  // Candidates: any not-yet-purged envelope in a terminal state. Active /
  // awaiting_seal envelopes still need their document, so they're excluded here
  // (and shouldDeletePdf would keep them anyway).
  const candidates = await pool.query(
    `SELECT * FROM envelopes
     WHERE pdf_deleted_at IS NULL AND status IN ('voided', 'expired', 'completed')`
  );
  // F-014: this is a RAW scan (not a getEnvelope DAO read), so rehydrate the rows
  // through the shared coercion. In production the HttpDbPool returns TIMESTAMPTZ
  // columns as ISO strings; without rehydration `env.completed_at` is a string and
  // shouldDeletePdf's `.getTime()` throws, crashing the whole backstop sweep.
  const envelopes = candidates.rows.map(rehydrateEnvelope);

  let deleted = 0;
  let failed = 0;

  for (const env of envelopes) {
    const signersResult = await pool.query(
      `SELECT * FROM envelope_signers WHERE envelope_id = $1`,
      [env.id]
    );
    // F-014: rehydrate raw signer rows too (string TIMESTAMPTZ → Date), for the
    // delivery/bounce markers shouldDeletePdf inspects.
    const signers = signersResult.rows.map(rehydrateSigner);

    if (!shouldDeletePdf(env, signers, now)) continue;

    // Stamp first (the shared-document guard in purgeEnvelopeBlobs reads
    // pdf_deleted_at), then free the real blobs. Fail-soft per key.
    await pool.query(
      `UPDATE envelopes SET pdf_deleted_at = $2 WHERE id = $1`,
      [env.id, now]
    );
    const r = await purgeEnvelopeBlobs(pool, storage, env, signers);
    if (r.failed > 0) failed++;
    else deleted++;
  }

  return { scanned: envelopes.length, deleted, failed };
}
