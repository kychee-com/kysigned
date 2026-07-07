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
