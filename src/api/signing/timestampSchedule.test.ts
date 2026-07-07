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
