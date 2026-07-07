/**
 * Signature-artifact assembly tests — F-6.5/6.6 (timestamp wiring).
 *
 * Offline against the artifacts pool + the module's deterministic providers.
 * Asserts: sha256(.eml) is what's stamped + stored; the OTS proof + verdicts land;
 * ts_status tracks pending/complete; and a stamp outage NEVER throws (fail-proof).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assembleSignatureArtifact, sha256Eml } from './artifactAssembly.js';
import { createSignatureArtifactsMemoryPool } from '../../db/signatureArtifacts.testpool.js';
import { createFakeProvider } from '../../timestamp/fake.js';
import type { TimestampProof, TimestampProvider } from '../../timestamp/contract.js';

const RAW_EML = ['From: alice@example.com', 'Subject: Fwd: [ksgn-x]', '', 'I sign this document', ''].join('\r\n');
const VERDICTS = { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' };

function baseInput() {
  return {
    envelopeId: '18267982-ca76-45dc-a294-e86039a6343d',
    signerEmail: 'alice@example.com',
    messageId: 'msg-1',
    rawEml: RAW_EML,
    signingDomain: 'example.com',
    selector: 'sel',
    verdicts: VERDICTS,
  };
}

/** A provider that returns a PENDING proof (mimics a fresh OTS stamp). */
const pendingProvider: TimestampProvider = {
  id: 'ots',
  trustModel: 'bitcoin-math',
  async stamp() {
    return { provider: 'ots', version: 1, status: 'pending', data: 'AAEC' } as TimestampProof;
  },
  async verify() {
    return { ok: false, timeSec: 0, anchor: '' };
  },
};

/** A provider whose stamp throws (calendar outage). */
const throwingProvider: TimestampProvider = {
  id: 'ots',
  async stamp() {
    throw new Error('calendar unreachable');
  },
  async verify() {
    return { ok: false, timeSec: 0, anchor: '' };
  },
};

describe('assembleSignatureArtifact — F-6.6 timestamps', () => {
  it('stamps sha256(.eml) and persists the artifact with proof + verdicts', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    const fake = createFakeProvider();
    const artifact = await assembleSignatureArtifact(pool, baseInput(), { timestampProvider: fake });

    const expectedHex = createHash('sha256').update(RAW_EML).digest('hex');
    assert.equal(artifact.sha256_eml, expectedHex);
    assert.equal(artifact.dkim_domain, 'example.com');
    assert.equal(artifact.spf_verdict, 'PASS');
    assert.equal(artifact.dmarc_verdict, 'PASS');
    assert.equal(artifact.ots_proof?.provider, 'fake');
    assert.equal(artifact.ts_status, 'complete'); // the fake proof is complete

    // the stored proof genuinely verifies against sha256(.eml)
    const { digest } = sha256Eml(RAW_EML);
    assert.equal((await fake.verify(artifact.ots_proof!, digest)).ok, true);
  });

  it('marks ts_status pending for a fresh (pending) OTS proof', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    const artifact = await assembleSignatureArtifact(pool, baseInput(), { timestampProvider: pendingProvider });
    assert.equal(artifact.ts_status, 'pending');
    assert.equal(artifact.ots_proof?.status, 'pending');
  });

  it('records the optional TSA token alongside the OTS proof', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    const artifact = await assembleSignatureArtifact(pool, baseInput(), {
      timestampProvider: pendingProvider,
      tsaProvider: createFakeProvider({ timeSec: 1_800_000_000 }),
    });
    assert.equal(artifact.ots_proof?.status, 'pending');
    assert.equal(artifact.tsa_token?.provider, 'fake');
  });

  it('is fail-proof: a stamp outage never throws — null proof, ts_status pending', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    const artifact = await assembleSignatureArtifact(pool, baseInput(), { timestampProvider: throwingProvider });
    assert.equal(artifact.ots_proof, null);
    assert.equal(artifact.ts_status, 'pending'); // so the upgrade reconciler re-stamps later
    assert.equal(artifact.sha256_eml, createHash('sha256').update(RAW_EML).digest('hex')); // still recorded
  });

  it('is idempotent — re-assembling the same signer keeps the first artifact', async () => {
    const { pool, rows } = createSignatureArtifactsMemoryPool();
    await assembleSignatureArtifact(pool, baseInput(), { timestampProvider: createFakeProvider() });
    await assembleSignatureArtifact(pool, baseInput(), { timestampProvider: createFakeProvider() });
    assert.equal(rows.length, 1);
  });

  it('records + timestamps + archives the observed DKIM key (F-6.7)', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    const resolveDkimKey = async () => ({
      value: 'v=DKIM1; k=rsa; p=AAAA',
      observedAt: new Date('2026-06-14T10:00:00Z'),
    });
    // archive GET returns the record → already archived (no contribute).
    const archiveFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ domain: 'example.com', selector: 'sel', value: 'v=DKIM1; k=rsa; p=AAAA' }),
    })) as unknown as typeof fetch;

    const artifact = await assembleSignatureArtifact(pool, baseInput(), {
      timestampProvider: createFakeProvider(),
      tsaProvider: createFakeProvider({ timeSec: 1_800_000_000 }),
      resolveDkimKey,
      archive: { fetchFn: archiveFetch },
    });
    assert.equal(artifact.dkim_selector, 'sel');
    assert.equal(artifact.dkim_key, 'v=DKIM1; k=rsa; p=AAAA');
    assert.ok(artifact.dkim_observed_at);
    assert.equal(artifact.key_obs_proof?.provider, 'fake'); // TSA-stamped observation
    assert.equal(artifact.archive_status, 'archived');
  });

  it('is fail-proof when the DKIM key cannot be resolved (DNS hiccup)', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    const artifact = await assembleSignatureArtifact(pool, baseInput(), {
      timestampProvider: createFakeProvider(),
      tsaProvider: createFakeProvider(),
      resolveDkimKey: async () => null, // resolution failed
    });
    assert.equal(artifact.dkim_selector, 'sel'); // selector still recorded
    assert.equal(artifact.dkim_key, null);
    assert.equal(artifact.key_obs_proof, null);
    assert.ok(artifact.ots_proof); // the signature + .eml timestamp still persisted
  });

  it('records archive contribution outcome when the key was absent (AC-60)', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    // GET → records:0 (absent); POST → 201 added.
    const archiveFetch = (async (url: string) => {
      if (String(url).includes('/api/dsp')) {
        return { ok: true, status: 201, json: async () => ({ addResult: { added: true, already_in_db: false } }) };
      }
      return { ok: true, status: 200, json: async () => ({ records: 0 }) };
    }) as unknown as typeof fetch;

    const artifact = await assembleSignatureArtifact(pool, baseInput(), {
      timestampProvider: createFakeProvider(),
      archive: { fetchFn: archiveFetch },
    });
    assert.equal(artifact.archive_status, 'contributed');
  });
});

describe('assembleSignatureArtifact — bounded external tail (F-6.9 hang-proofing)', () => {
  // The 2026-07-05 incident: a provider that HANGS (vs errors) held the
  // reply_received durable run past the worker lease (FUNCTION_RUN_LEASE_EXPIRED
  // ×5 attempts), so completion_distribute was never enqueued and auto-close
  // envelopes sat `active` forever. Fail-proof must bound EVERY external call:
  // a hang degrades exactly like an outage (null proof / null key / outage).
  const hangForever = <T>() => new Promise<T>(() => {});
  const hangingProvider: TimestampProvider = {
    id: 'ots',
    trustModel: 'bitcoin-math',
    stamp: () => hangForever(),
    verify: async () => ({ ok: false, timeSec: 0, anchor: '' }),
  };

  /** Fails the test if `p` has not settled within `ms` (the pre-fix hang). */
  async function mustSettle<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<'HUNG'>((r) => {
      timer = setTimeout(() => r('HUNG'), ms);
    });
    const winner = await Promise.race([p, guard]);
    clearTimeout(timer);
    if (winner === 'HUNG') assert.fail(`assembly did not settle within ${ms}ms — unbounded external call`);
    return winner as T;
  }

  it('a HANGING stamp provider degrades like an outage: null proofs, ts_status pending', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    const artifact = await mustSettle(
      assembleSignatureArtifact(pool, baseInput(), {
        timestampProvider: hangingProvider,
        tsaProvider: hangingProvider,
        timeoutsMs: { stamp: 40 },
      }),
      2_000,
    );
    assert.equal(artifact.ots_proof, null);
    assert.equal(artifact.tsa_token, null);
    assert.equal(artifact.ts_status, 'pending'); // upgrade reconciler re-stamps later
    assert.equal(artifact.sha256_eml, createHash('sha256').update(RAW_EML).digest('hex'));
  });

  it('a HANGING resolveDkimKey degrades to a null observed key', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    const artifact = await mustSettle(
      assembleSignatureArtifact(pool, baseInput(), {
        timestampProvider: createFakeProvider(),
        tsaProvider: createFakeProvider(),
        resolveDkimKey: () => hangForever(),
        timeoutsMs: { resolveKey: 40 },
      }),
      2_000,
    );
    assert.equal(artifact.dkim_key, null);
    assert.equal(artifact.key_obs_proof, null);
    assert.ok(artifact.ots_proof); // the signature + .eml timestamp still persisted
  });

  it('a HANGING archive lookup degrades to outage status', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    const artifact = await mustSettle(
      assembleSignatureArtifact(pool, baseInput(), {
        timestampProvider: createFakeProvider(),
        archive: { fetchFn: (() => hangForever()) as unknown as typeof fetch },
        timeoutsMs: { archive: 40 },
      }),
      2_000,
    );
    assert.equal(artifact.archive_status, 'outage');
  });
});
