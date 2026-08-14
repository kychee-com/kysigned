/**
 * timestampSchedule — F-29 / F-6.6. The self-rescheduling OTS-upgrade run's two
 * building blocks: the per-artifact advance + scheduling the next chain link.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleTimestampUpgrade, upgradeOneArtifact, TIMESTAMP_UPGRADE_DELAY } from './timestampSchedule.js';
import type { CreateRunOptions } from '../../functions/runs.js';
import type { DbPool } from '../../db/pool.js';

const complete = { status: 'complete' } as never;
const pending = { status: 'pending' } as never;

function recordingPool() {
  const updates: unknown[][] = [];
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      if (text.includes('UPDATE signature_artifacts')) updates.push((values ?? []) as unknown[]);
      return { rows: [], rowCount: 1 } as never;
    },
    async end() {},
  };
  return { pool, updates };
}

describe('scheduleTimestampUpgrade (F-29 / F-6.6)', () => {
  it('schedules the next attempt (idempotency = artifactId:tsup:attempt, delay, payload)', async () => {
    const calls: CreateRunOptions[] = [];
    await scheduleTimestampUpgrade(async (o) => { calls.push(o); return { runId: 'r', deduplicated: false }; }, 'art-1', 3);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].eventType, 'timestamp_upgrade');
    assert.equal(calls[0].idempotencyKey, 'art-1:tsup:3');
    assert.equal(calls[0].delay, TIMESTAMP_UPGRADE_DELAY);
    assert.deepEqual(calls[0].payload, { artifactId: 'art-1', attempt: 3 });
  });

  it('is a no-op when createRun is unwired', async () => {
    await scheduleTimestampUpgrade(undefined, 'a', 1);
  });

  it('swallows a createRun failure (best-effort)', async () => {
    await scheduleTimestampUpgrade(async () => { throw new Error('run402 down'); }, 'a', 1);
  });
});

describe('upgradeOneArtifact — every pending OTS proof advances in one pass (the AC-169 fix + F-32.9, spec 0.71.0)', () => {
  it('a pending key_obs_ots_proof and archive_statement_ots upgrade alongside the .eml proof', async () => {
    const { pool, updates } = recordingPool();
    const provider = { stamp: async () => pending, upgrade: async () => complete } as never;
    const action = await upgradeOneArtifact(
      pool,
      { id: 'art-1', ots_proof: pending, key_obs_ots_proof: pending, archive_statement_ots: pending, sha256_eml: 'ab' } as never,
      provider,
    );
    assert.equal(action, 'upgraded');
    const params = updates[0];
    // UPDATE params: [id, otsProof, keyObsProof, tsStatus, keyObsOtsProof, archiveStatementOts]
    assert.ok(String(params[4] ?? '').includes('complete'), 'key_obs_ots_proof advanced (the never-upgraded AC-169 defect)');
    assert.ok(String(params[5] ?? '').includes('complete'), 'archive_statement_ots advanced');
  });

  it('the chain stays alive while an aux anchor is pending even after the .eml proof completes', async () => {
    const { pool, updates } = recordingPool();
    const emlPending = { status: 'pending', data: 'EML' } as never;
    const auxPending = { status: 'pending', data: 'AUX' } as never;
    const provider = {
      stamp: async () => emlPending,
      upgrade: async (p: { data?: string }) => (p.data === 'EML' ? complete : auxPending),
    } as never;
    const action = await upgradeOneArtifact(
      pool,
      { id: 'art-1', ots_proof: emlPending, key_obs_ots_proof: auxPending, sha256_eml: 'ab' } as never,
      provider,
    );
    assert.equal(action, 'still_pending', 'not terminal — the key-obs anchor is still pending');
    assert.equal(updates[0]?.[3], 'complete', 'ts_status still completes for the .eml proof');
  });

  it('artifactHasPendingOts drives the handler entry: ts complete + aux pending is still pending work', async () => {
    const mod = (await import('./timestampSchedule.js')) as Record<string, unknown>;
    const artifactHasPendingOts = mod.artifactHasPendingOts as ((a: unknown) => boolean) | undefined;
    assert.ok(artifactHasPendingOts, 'artifactHasPendingOts is exported');
    assert.equal(artifactHasPendingOts!({ ts_status: 'complete', key_obs_ots_proof: pending }), true);
    assert.equal(artifactHasPendingOts!({ ts_status: 'complete', archive_statement_ots: pending }), true);
    assert.equal(artifactHasPendingOts!({ ts_status: 'complete', key_obs_ots_proof: complete, archive_statement_ots: null }), false);
    assert.equal(artifactHasPendingOts!({ ts_status: 'pending' }), true);
  });
});

describe('upgradeOneArtifact (F-6.6)', () => {
  it('upgrades a pending proof that now confirms → upgraded + persists complete', async () => {
    const { pool, updates } = recordingPool();
    const provider = { stamp: async () => pending, upgrade: async () => complete } as never;
    const action = await upgradeOneArtifact(pool, { id: 'art-1', ots_proof: pending, sha256_eml: 'ab' } as never, provider);
    assert.equal(action, 'upgraded');
    assert.equal(updates.length, 1);
  });

  it('re-stamps a null proof (recovery) that confirms → restamped', async () => {
    const { pool } = recordingPool();
    const provider = { stamp: async () => complete } as never;
    const action = await upgradeOneArtifact(pool, { id: 'art-1', ots_proof: null, sha256_eml: 'ab' } as never, provider);
    assert.equal(action, 'restamped');
  });

  it('stays still_pending when Bitcoin has not yet confirmed', async () => {
    const { pool } = recordingPool();
    const provider = { stamp: async () => pending, upgrade: async () => pending } as never;
    const action = await upgradeOneArtifact(pool, { id: 'art-1', ots_proof: pending, sha256_eml: 'ab' } as never, provider);
    assert.equal(action, 'still_pending');
  });

  it('isolates a provider error → error', async () => {
    const { pool } = recordingPool();
    const provider = { stamp: async () => { throw new Error('ots down'); }, upgrade: async () => { throw new Error('ots down'); } } as never;
    const action = await upgradeOneArtifact(pool, { id: 'art-1', ots_proof: pending, sha256_eml: 'ab' } as never, provider);
    assert.equal(action, 'error');
  });
});
