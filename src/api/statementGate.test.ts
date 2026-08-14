/**
 * statementGate tests — F-32.10 / AC-269 / AC-270 (spec 0.71.0).
 *
 * The bounded-wait matrix, offline: ready-at-receipt (zero latency), the wait
 * (re-attempt now → interim email once → re-check scheduled), the bound expiry
 * (waive once → ONE aggregated operator alert → proceed), and the guards (email
 * at most once; waive alert exactly once; a non-capturable artifact never holds
 * sealing). Uses the shared artifacts testpool wrapped with the envelope
 * wait-column branches.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStatementGate, capturableMissing, type StatementGateDeps } from './statementGate.js';
import { createSignatureArtifactsMemoryPool } from '../db/signatureArtifacts.testpool.js';
import { upsertSignatureArtifact } from '../db/signatureArtifacts.js';
import { createFakeProvider } from '../timestamp/fake.js';
import type { DbPool } from '../db/pool.js';
import type { Envelope } from '../db/types.js';
import type { EmailMessage } from '../email/types.js';

const ENV_ID = '18267982-ca76-45dc-a294-e86039a6343d';
const OBSERVED_KEY = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqTESTKEY';

/** Wrap the artifacts pool with the envelope wait-column UPDATE branches. */
function makePool(envRow: Record<string, unknown>) {
  const base = createSignatureArtifactsMemoryPool();
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as unknown[];
      if (text.includes('SET finalizing_since')) {
        envRow.finalizing_since = envRow.finalizing_since ?? v[1];
        return { rows: [{ finalizing_since: envRow.finalizing_since }], rowCount: 1 } as never;
      }
      if (text.includes('SET finalizing_email_sent_at')) {
        if (envRow.finalizing_email_sent_at != null) return { rows: [], rowCount: 0 } as never;
        envRow.finalizing_email_sent_at = new Date();
        return { rows: [{ id: v[0] }], rowCount: 1 } as never;
      }
      if (text.includes('SET statement_waived_at')) {
        if (envRow.statement_waived_at != null) return { rows: [], rowCount: 0 } as never;
        envRow.statement_waived_at = new Date();
        return { rows: [{ id: v[0] }], rowCount: 1 } as never;
      }
      return base.pool.query(text, values);
    },
    async end() {},
  };
  return { pool, envRow, artifactRows: base.rows };
}

function envelope(over: Partial<Envelope> = {}): Envelope {
  return {
    id: ENV_ID,
    sender_email: 'creator@example.com',
    document_name: 'Test Waiver',
    finalizing_since: null,
    finalizing_email_sent_at: null,
    statement_waived_at: null,
    ...over,
  } as Envelope;
}

async function seedArtifact(pool: DbPool, over: Record<string, unknown> = {}) {
  const { artifact } = await upsertSignatureArtifact(pool, {
    envelope_id: ENV_ID,
    signer_email: (over.signer_email as string) ?? 'alice@example.com',
    sha256_eml: 'a'.repeat(64),
    dkim_domain: 'example.com',
    dkim_selector: 'sel',
    dkim_key: OBSERVED_KEY,
    ...over,
  } as never);
  return artifact;
}

/** Sign a matching statement with a throwaway key (the assembly-test pattern). */
async function makeStatement() {
  const { CompactSign, generateKeyPair, exportJWK } = await import('jose');
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-arch-1', alg: 'EdDSA', use: 'sig' };
  const record = {
    id: '1', domain: 'example.com', selector: 'sel', value: OBSERVED_KEY,
    source: 'live_dns', first_seen_at: '2026-06-01T00:00:00Z', last_seen_at: '2026-08-09T00:00:00Z',
  };
  const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify({ v: 1, iss: 'archive.zk.email', iat: 1789000000, record })))
    .setProtectedHeader({ alg: 'EdDSA', kid: 'test-arch-1' })
    .sign(privateKey);
  return { jws, jwks: { keys: [jwk] } };
}

function gateDeps(over: Partial<StatementGateDeps> & { statements?: string[] } = {}): {
  deps: StatementGateDeps;
  sentEmails: EmailMessage[];
  scheduled: Array<Record<string, unknown>>;
} {
  const sentEmails: EmailMessage[] = [];
  const scheduled: Array<Record<string, unknown>> = [];
  const statements = over.statements ?? [];
  const deps: StatementGateDeps = {
    timestampProvider: createFakeProvider(),
    tsaProvider: createFakeProvider(),
    archive: {
      fetchFn: (async (url: string) => ({
        ok: true, status: 200,
        headers: { get: () => null },
        json: async () => (String(url).includes('/api/key/statement') ? statements : { records: 0 }),
      })) as unknown as typeof fetch,
    },
    statementJwks: over.statementJwks ?? { keys: [] },
    emailProvider: { send: async (m: EmailMessage) => { sentEmails.push(m); return { messageId: `m-${sentEmails.length}` }; } },
    operatorDomain: 'kysigned.com',
    createRun: (async (req: Record<string, unknown>) => { scheduled.push(req); return { runId: `r-${scheduled.length}` }; }) as never,
    timeoutsMs: { statement: 500, stamp: 500 },
    ...over,
  };
  return { deps, sentEmails, scheduled };
}

describe('statement gate — F-32.10 bounded wait', () => {
  it('every statement captured at receipt → ready, no email, no schedule, no wait clock', async () => {
    const { pool, envRow } = makePool({});
    await seedArtifact(pool, { archive_statement: 'eyJ.captured.already', archive_statement_captured_at: new Date() });
    const { deps, sentEmails, scheduled } = gateDeps();
    const r = await evaluateStatementGate(pool, envelope(), deps);
    assert.equal(r.action, 'ready');
    assert.equal(r.missing, 0);
    assert.equal(sentEmails.length, 0);
    assert.equal(scheduled.length, 0);
    assert.equal(envRow.finalizing_since, undefined);
  });

  it('a missing statement that captures on the re-attempt NOW → ready (persisted with both proofs)', async () => {
    const { pool, artifactRows } = makePool({});
    await seedArtifact(pool);
    const { jws, jwks } = await makeStatement();
    const { deps, sentEmails } = gateDeps({ statements: [jws], statementJwks: jwks });
    const r = await evaluateStatementGate(pool, envelope(), deps);
    assert.equal(r.action, 'ready');
    assert.equal(artifactRows[0].archive_statement, jws);
    assert.ok(artifactRows[0].archive_statement_tsa, 'TSA proof persisted by the wait-path capture');
    assert.equal(sentEmails.length, 0, 'no interim email on a same-call capture');
  });

  it('capture still blocked, bound open → waiting: clock set once, ONE interim email, a re-check scheduled', async () => {
    const { pool, envRow } = makePool({});
    await seedArtifact(pool);
    const { deps, sentEmails, scheduled } = gateDeps(); // no statements servable
    const r = await evaluateStatementGate(pool, envelope(), deps);
    assert.equal(r.action, 'waiting');
    assert.equal(r.missing, 1);
    assert.ok(envRow.finalizing_since, 'wait clock started');
    assert.equal(sentEmails.length, 1, 'exactly one interim email');
    assert.equal(sentEmails[0].to, 'creator@example.com');
    assert.match(sentEmails[0].subject, /finalizing/i);
    assert.equal(scheduled.length, 1, 'one re-check scheduled');
    assert.equal(scheduled[0].eventType, 'statement_wait_recheck');
    assert.match(String(scheduled[0].idempotencyKey), new RegExp(`^${ENV_ID}:stmt-wait:`));
  });

  it('a second waiting evaluation sends NO second email (the once-guard holds)', async () => {
    const { pool } = makePool({});
    await seedArtifact(pool);
    const { deps, sentEmails } = gateDeps();
    await evaluateStatementGate(pool, envelope(), deps);
    const envAfter = envelope({ finalizing_since: new Date() });
    await evaluateStatementGate(pool, envAfter, deps);
    assert.equal(sentEmails.length, 1, 'interim email at most once per envelope');
  });

  it('bound expired → waived: ONE aggregated operator alert naming the envelope/signer, then proceed', async () => {
    const since = new Date(Date.now() - 25 * 3_600_000); // 25h ago > 24h bound
    const { pool, envRow } = makePool({});
    await seedArtifact(pool);
    const { deps, sentEmails, scheduled } = gateDeps();
    const r = await evaluateStatementGate(pool, envelope({ finalizing_since: since }), deps);
    assert.equal(r.action, 'waived');
    assert.ok(envRow.statement_waived_at, 'waive recorded');
    assert.equal(sentEmails.length, 1, 'exactly one operator alert');
    assert.equal(sentEmails[0].to, 'info@kysigned.com');
    assert.match(String(sentEmails[0].text), new RegExp(ENV_ID));
    assert.match(String(sentEmails[0].text), /alice@example\.com/);
    assert.equal(scheduled.length, 0, 'no further re-checks after the waive');
  });

  it('an already-waived envelope is ready immediately (no second alert)', async () => {
    const { pool } = makePool({ statement_waived_at: new Date() });
    await seedArtifact(pool);
    const { deps, sentEmails } = gateDeps();
    const r = await evaluateStatementGate(pool, envelope({ statement_waived_at: new Date() }), deps);
    assert.equal(r.action, 'ready');
    assert.equal(sentEmails.length, 0);
  });

  it('a non-capturable artifact (no observed key) never holds sealing', async () => {
    const { pool } = makePool({});
    await seedArtifact(pool, { dkim_key: null, dkim_selector: null });
    const { deps, sentEmails, scheduled } = gateDeps();
    const r = await evaluateStatementGate(pool, envelope(), deps);
    assert.equal(r.action, 'ready');
    assert.equal(sentEmails.length, 0);
    assert.equal(scheduled.length, 0);
  });

  it('capturableMissing: statement-less artifacts with selector+key only', async () => {
    const { pool } = makePool({});
    const a = await seedArtifact(pool);
    const b = await seedArtifact(pool, { signer_email: 'bob@example.com', archive_statement: 'eyJ.x.y' });
    const c = await seedArtifact(pool, { signer_email: 'carol@example.com', dkim_key: null });
    assert.deepEqual(capturableMissing([a, b, c]).map((x) => x.id), [a.id]);
  });
});
