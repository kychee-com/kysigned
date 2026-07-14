/**
 * signature_artifacts DAO tests — F-6.5/6.6/6.7 (migration 020).
 *
 * Round-trip against the in-memory pool: idempotent upsert, JSON proof round-trip,
 * pending-list for the upgrade reconciler, and the pending→complete update.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  upsertSignatureArtifact,
  getSignatureArtifact,
  listPendingTimestampArtifacts,
  updateArtifactTimestamps,
  listArtifactsForArchiveReconciliation,
  updateArtifactArchiveConfirmation,
} from './signatureArtifacts.js';
import { createSignatureArtifactsMemoryPool } from './signatureArtifacts.testpool.js';
import type { TimestampProof } from '../timestamp/contract.js';

const ENV = '18267982-ca76-45dc-a294-e86039a6343d';
const OTS_PENDING: TimestampProof = { provider: 'ots', version: 1, status: 'pending', data: 'AAEC', meta: { calendars: ['https://a.pool.opentimestamps.org'] } };
const OTS_COMPLETE: TimestampProof = { provider: 'ots', version: 1, status: 'complete', data: 'AAED' };

function baseInput(over: Record<string, unknown> = {}) {
  return {
    envelope_id: ENV,
    signer_email: 'alice@example.com',
    message_id: 'msg-1',
    sha256_eml: 'a'.repeat(64),
    spf_verdict: 'PASS',
    dkim_verdict: 'PASS',
    dmarc_verdict: 'PASS',
    dkim_domain: 'example.com',
    dkim_selector: 'sel',
    dkim_key: 'v=DKIM1; k=rsa; p=AAAA',
    dkim_observed_at: new Date('2026-06-14T10:00:00Z'),
    ots_proof: OTS_PENDING,
    archive_status: 'contributed',
    ...over,
  };
}

describe('signature_artifacts DAO', () => {
  it('creates an artifact and round-trips its fields (incl. the JSON OTS proof)', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    const { artifact, created } = await upsertSignatureArtifact(pool, baseInput());
    assert.equal(created, true);
    assert.equal(artifact.envelope_id, ENV);
    assert.equal(artifact.signer_email, 'alice@example.com');
    assert.equal(artifact.sha256_eml, 'a'.repeat(64));
    assert.equal(artifact.spf_verdict, 'PASS');
    assert.equal(artifact.dkim_domain, 'example.com');
    assert.equal(artifact.archive_status, 'contributed');
    assert.equal(artifact.ts_status, 'pending'); // defaulted
    assert.deepEqual(artifact.ots_proof, OTS_PENDING); // JSON survived the round-trip
    assert.equal(artifact.tsa_token, null);
  });

  it('is idempotent — a second upsert for the same (envelope, signer) returns the existing row', async () => {
    const { pool, rows } = createSignatureArtifactsMemoryPool();
    const first = await upsertSignatureArtifact(pool, baseInput());
    const second = await upsertSignatureArtifact(pool, baseInput({ sha256_eml: 'b'.repeat(64) }));
    assert.equal(second.created, false);
    assert.equal(second.artifact.id, first.artifact.id);
    assert.equal(second.artifact.sha256_eml, 'a'.repeat(64)); // unchanged — first assembly wins
    assert.equal(rows.length, 1);
  });

  it('fetches by (envelope, signer) case-insensitively; null when absent', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    await upsertSignatureArtifact(pool, baseInput());
    const found = await getSignatureArtifact(pool, ENV, 'ALICE@EXAMPLE.COM');
    assert.equal(found?.signer_email, 'alice@example.com');
    assert.equal(await getSignatureArtifact(pool, ENV, 'nobody@example.com'), null);
  });

  it('lists pending-timestamp artifacts (excludes complete), respecting the limit', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    await upsertSignatureArtifact(pool, baseInput({ signer_email: 'a@x.com' }));
    await upsertSignatureArtifact(pool, baseInput({ signer_email: 'b@x.com' }));
    await upsertSignatureArtifact(pool, baseInput({ signer_email: 'c@x.com', ts_status: 'complete' }));

    const pending = await listPendingTimestampArtifacts(pool, 10);
    assert.equal(pending.length, 2);
    assert.ok(pending.every((p) => p.ts_status === 'pending'));

    const limited = await listPendingTimestampArtifacts(pool, 1);
    assert.equal(limited.length, 1);
  });

  it('advances a pending artifact to complete (OTS upgrade)', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    const { artifact } = await upsertSignatureArtifact(pool, baseInput());
    const updated = await updateArtifactTimestamps(pool, artifact.id, {
      otsProof: OTS_COMPLETE,
      tsStatus: 'complete',
    });
    assert.equal(updated?.ts_status, 'complete');
    assert.deepEqual(updated?.ots_proof, OTS_COMPLETE);
    // a later pending scan no longer returns it
    assert.equal((await listPendingTimestampArtifacts(pool, 10)).length, 0);
  });

  it('COALESCE preserves existing proofs when an update omits them', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    const { artifact } = await upsertSignatureArtifact(pool, baseInput());
    const updated = await updateArtifactTimestamps(pool, artifact.id, { tsStatus: 'complete' });
    assert.deepEqual(updated?.ots_proof, OTS_PENDING); // unchanged
    assert.equal(updated?.ts_status, 'complete');
  });
});

describe('archive-confirmation state (F-32.6/F-32.7, migration 010)', () => {
  const CHECKED = new Date('2026-07-14T12:00:00Z');

  it('round-trips archive_confirmation + checked_at on create; defaults are null', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    const withState = await upsertSignatureArtifact(
      pool,
      baseInput({ archive_confirmation: 'unconfirmed', archive_confirmation_checked_at: CHECKED }),
    );
    assert.equal(withState.artifact.archive_confirmation, 'unconfirmed');
    assert.ok(withState.artifact.archive_confirmation_checked_at);
    assert.equal(withState.artifact.archive_confirmation_healed_at, null);

    const bare = await upsertSignatureArtifact(pool, baseInput({ signer_email: 'bare@x.com' }));
    assert.equal(bare.artifact.archive_confirmation, null);
    assert.equal(bare.artifact.archive_confirmation_checked_at, null);
  });

  it('sweep list: picks 24-48h-old NON-clean artifacts with a selector; excludes confirmed and out-of-window rows (AC-165)', async () => {
    const { pool, rows } = createSignatureArtifactsMemoryPool();
    const NOW = new Date('2026-07-14T12:00:00Z');
    const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

    await upsertSignatureArtifact(pool, baseInput({ signer_email: 'in-unconfirmed@x.com', archive_confirmation: 'unconfirmed' }));
    await upsertSignatureArtifact(pool, baseInput({ signer_email: 'in-outage@x.com', archive_confirmation: 'outage' }));
    await upsertSignatureArtifact(pool, baseInput({ signer_email: 'in-null@x.com' })); // null state, selector present
    await upsertSignatureArtifact(pool, baseInput({ signer_email: 'in-confirmed@x.com', archive_confirmation: 'confirmed' }));
    await upsertSignatureArtifact(pool, baseInput({ signer_email: 'too-fresh@x.com', archive_confirmation: 'unconfirmed' }));
    await upsertSignatureArtifact(pool, baseInput({ signer_email: 'too-old@x.com', archive_confirmation: 'unconfirmed' }));
    await upsertSignatureArtifact(pool, baseInput({ signer_email: 'no-selector@x.com', archive_confirmation: 'unconfirmed', dkim_selector: null }));

    for (const r of rows) {
      if (r.signer_email === 'too-fresh@x.com') r.created_at = hoursAgo(2);
      else if (r.signer_email === 'too-old@x.com') r.created_at = hoursAgo(72);
      else r.created_at = hoursAgo(30);
    }

    const due = await listArtifactsForArchiveReconciliation(pool, NOW);
    const who = due.map((a) => a.signer_email).sort();
    assert.deepEqual(who, ['in-null@x.com', 'in-outage@x.com', 'in-unconfirmed@x.com']);
  });

  it('updateArtifactArchiveConfirmation heals a row: confirmed + healed_at set, checked_at advanced', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    const { artifact } = await upsertSignatureArtifact(
      pool,
      baseInput({ archive_confirmation: 'outage', archive_confirmation_checked_at: CHECKED }),
    );
    const healed = await updateArtifactArchiveConfirmation(pool, artifact.id, {
      confirmation: 'confirmed',
      checkedAt: new Date('2026-07-15T12:00:00Z'),
      healedAt: new Date('2026-07-15T12:00:00Z'),
    });
    assert.equal(healed?.archive_confirmation, 'confirmed');
    assert.ok(healed?.archive_confirmation_healed_at);

    const still = await updateArtifactArchiveConfirmation(pool, artifact.id, {
      confirmation: 'unconfirmed',
      checkedAt: new Date('2026-07-16T12:00:00Z'),
    });
    assert.equal(still?.archive_confirmation, 'unconfirmed');
    assert.ok(still?.archive_confirmation_healed_at, 'healed_at is preserved when the update omits it');
  });
});
