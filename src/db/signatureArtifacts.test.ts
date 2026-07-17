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
  listOutstandingArchiveConfirmations,
} from './signatureArtifacts.js';
import { createSignatureArtifactsMemoryPool } from './signatureArtifacts.testpool.js';
import type { TimestampProof } from '../timestamp/contract.js';
import type { DbPool } from './pool.js';

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

  it('outstanding list (dashboard, #148/F-33.3): every non-clean artifact across the FULL backlog (no window), newest first; confirmed + selector-less excluded', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    // Insertion order fixes created_at (testpool assigns increasing timestamps by seq).
    await upsertSignatureArtifact(pool, baseInput({ signer_email: 'unconfirmed@x.com', archive_confirmation: 'unconfirmed' })); // seq1 (oldest)
    await upsertSignatureArtifact(pool, baseInput({ signer_email: 'outage@x.com', archive_confirmation: 'outage' }));          // seq2
    await upsertSignatureArtifact(pool, baseInput({ signer_email: 'unknown@x.com' }));                                        // seq3 (null state)
    await upsertSignatureArtifact(pool, baseInput({ signer_email: 'confirmed@x.com', archive_confirmation: 'confirmed' }));   // excluded
    await upsertSignatureArtifact(pool, baseInput({ signer_email: 'noselector@x.com', archive_confirmation: 'outage', dkim_selector: null })); // excluded

    const out = await listOutstandingArchiveConfirmations(pool);
    // confirmed + selector-less excluded; the three non-clean present, NEWEST FIRST.
    assert.deepEqual(
      out.map((a) => a.signer_email),
      ['unknown@x.com', 'outage@x.com', 'unconfirmed@x.com'],
    );
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

describe('listOutstandingArchiveConfirmations — F-35.3 exclude-internal (AC-190)', () => {
  // A dedicated pool: the reconciliation query returns three outstanding rows — one
  // whose envelope creator is internal (@kychee.com), one internal_test, one external.
  // The DAO filters on the joined creator_email / internal_test.
  const NOW = '2026-07-17T00:00:00.000Z';
  const baseRow = (over: Record<string, unknown>) => ({
    id: 'sa', envelope_id: 'env', signer_email: 's@ext.com', sha256_eml: 'h',
    message_id: null, spf_verdict: null, dkim_verdict: null, dmarc_verdict: null,
    dkim_domain: 'ext.com', dkim_selector: 'sel', dkim_key: null, dkim_observed_at: null,
    ots_proof: null, tsa_token: null, key_obs_proof: null, key_obs_ots_proof: null,
    archive_status: null, archive_confirmation: null,
    archive_confirmation_checked_at: null, archive_confirmation_healed_at: null,
    ts_status: 'complete', created_at: NOW, updated_at: NOW,
    creator_email: 'ext@customer.com', internal_test: false,
    ...over,
  });
  const seededRows = [
    baseRow({ id: 'sa-ext', envelope_id: 'e-ext', creator_email: 'ext@customer.com' }),
    baseRow({ id: 'sa-staff', envelope_id: 'e-staff', creator_email: 'staff@kychee.com' }), // internal identity
    baseRow({ id: 'sa-itest', envelope_id: 'e-itest', creator_email: 'ext2@customer.com', internal_test: true }), // internal_test
  ];
  const pool = {
    async query(text: string) {
      if (text.includes('created_at DESC') && text.includes('archive_confirmation IS NULL OR')) {
        return { rows: seededRows.map((r) => ({ ...r })), rowCount: seededRows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  } as unknown as DbPool;
  const RULES = ['@kychee.com'];

  it('toggle ON → drops the internal-creator + internal_test rows, keeps external', async () => {
    const out = await listOutstandingArchiveConfirmations(pool, { excludeInternal: true, internalIdentities: RULES });
    assert.deepEqual(out.map((a) => a.id).sort(), ['sa-ext']);
  });

  it('toggle OFF → keeps every outstanding row', async () => {
    const out = await listOutstandingArchiveConfirmations(pool, { excludeInternal: false, internalIdentities: RULES });
    assert.deepEqual(out.map((a) => a.id).sort(), ['sa-ext', 'sa-itest', 'sa-staff']);
  });

  it('defaults to ON when no opts are passed (matches the console default)', async () => {
    const out = await listOutstandingArchiveConfirmations(pool, { internalIdentities: RULES });
    assert.deepEqual(out.map((a) => a.id).sort(), ['sa-ext']);
  });
});
