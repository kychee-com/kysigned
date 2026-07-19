/**
 * Test-account reset endpoint tests (F-28 / AC-116).
 *
 * A secret-gated, identity-scoped, test-only purge that clears a single
 * pattern-matched test identity across the four account tables (envelopes,
 * auth_sessions, user_credits, credit_ledger — incl. the signup_grant ledger
 * row) so a fresh trial grant (F-13.4) can re-fire. Guardrails: inert without a
 * reset secret (404), refuses a wrong secret (401), refuses any identity outside
 * the configured pattern with ZERO mutation (403).
 *
 * Identity match is trim+lowercase — the exact form the email/sender_email
 * columns are stored under (userCredits.normalizeEmail); NOT normalizeInbox
 * (which strips gmail-dots/+tags and would miss stored rows). envelope_signers
 * cascade via the ON DELETE CASCADE FK on envelopes, so only the four tables are
 * deleted here.
 *
 * In-memory mock pool matching the pattern from userCredits.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestAccount } from '../db/testReset.js';
import { handleTestResetUser } from './testReset.js';
import type { DbPool } from '../db/pool.js';

function createInMemoryPool(): DbPool & {
  _envelopes: Array<{ id: string; sender_email: string }>;
  _signatureArtifacts: Array<{ envelope_id: string }>;
  _authSessions: Array<{ email: string }>;
  _userCredits: Array<{ email: string }>;
  _creditLedger: Array<{ email: string; source: string }>;
  _attributionCaptures: Array<{ normalized_email: string }>;
  _creatorAttribution: Array<{ normalized_email: string }>;
  _queries: string[];
} {
  const envelopes: Array<{ id: string; sender_email: string }> = [];
  const signatureArtifacts: Array<{ envelope_id: string }> = [];
  const authSessions: Array<{ email: string }> = [];
  const userCredits: Array<{ email: string }> = [];
  const creditLedger: Array<{ email: string; source: string }> = [];
  const attributionCaptures: Array<{ normalized_email: string }> = [];
  const creatorAttribution: Array<{ normalized_email: string }> = [];
  const queries: string[] = [];

  function del(arr: Array<Record<string, unknown>>, col: string, value: string) {
    const before = arr.length;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i]![col] === value) arr.splice(i, 1);
    }
    return { rows: [], rowCount: before - arr.length } as unknown as import('pg').QueryResult;
  }

  return {
    _envelopes: envelopes,
    _signatureArtifacts: signatureArtifacts,
    _authSessions: authSessions,
    _userCredits: userCredits,
    _creditLedger: creditLedger,
    _attributionCaptures: attributionCaptures,
    _creatorAttribution: creatorAttribution,
    _queries: queries,
    async query(text: string, values?: unknown[]) {
      const t = text.trim();
      const v = values ?? [];
      queries.push(t);
      const id = v[0] as string;
      // signature_artifacts references envelopes(id) WITHOUT ON DELETE CASCADE, so the reset
      // deletes it FIRST, scoped to the identity's envelopes (envelope_id IN (SELECT id ...)).
      if (/DELETE FROM signature_artifacts WHERE envelope_id IN \(SELECT id FROM envelopes WHERE sender_email = \$1\)/.test(t)) {
        const envIds = new Set(envelopes.filter((e) => e.sender_email === id).map((e) => e.id));
        const before = signatureArtifacts.length;
        for (let i = signatureArtifacts.length - 1; i >= 0; i--) {
          if (envIds.has(signatureArtifacts[i]!.envelope_id)) signatureArtifacts.splice(i, 1);
        }
        return { rows: [], rowCount: before - signatureArtifacts.length } as unknown as import('pg').QueryResult;
      }
      if (/DELETE FROM envelopes WHERE sender_email = \$1/.test(t)) return del(envelopes as never, 'sender_email', id);
      if (/DELETE FROM auth_sessions WHERE email = \$1/.test(t)) return del(authSessions as never, 'email', id);
      if (/DELETE FROM user_credits WHERE email = \$1/.test(t)) return del(userCredits as never, 'email', id);
      if (/DELETE FROM credit_ledger WHERE email = \$1/.test(t)) return del(creditLedger as never, 'email', id);
      // F-37: attribution rows key by the NORMALIZED inbox (normalizeInbox form).
      if (/DELETE FROM attribution_captures WHERE normalized_email = \$1/.test(t)) return del(attributionCaptures as never, 'normalized_email', id);
      if (/DELETE FROM creator_attribution WHERE normalized_email = \$1/.test(t)) return del(creatorAttribution as never, 'normalized_email', id);
      throw new Error(`Unexpected query: ${t}`);
    },
    async end() {},
  };
}

describe('resetTestAccount — DAO purge across the four tables (F-28 / AC-116)', () => {
  it('purges the identity from all four tables (trim+lowercase match), leaving others', async () => {
    const pool = createInMemoryPool();
    pool._envelopes.push({ id: 'e1', sender_email: 'redteam@kysigned.com' }, { id: 'e2', sender_email: 'other@x.com' });
    // e1 is a COMPLETED redteam envelope → it has a signature_artifact. This is the FK
    // that (without this fix) makes the envelope delete fail — signature_artifacts has no
    // ON DELETE CASCADE, so it must be purged first.
    pool._signatureArtifacts.push({ envelope_id: 'e1' }, { envelope_id: 'e2' });
    pool._authSessions.push({ email: 'redteam@kysigned.com' });
    pool._userCredits.push({ email: 'redteam@kysigned.com' });
    pool._creditLedger.push(
      { email: 'redteam@kysigned.com', source: 'signup_grant' },
      { email: 'redteam@kysigned.com', source: 'envelope' },
      { email: 'other@x.com', source: 'signup_grant' },
    );

    // mixed case + surrounding whitespace → normalizes to the stored form
    const r = await resetTestAccount(pool, '  RedTeam@Kysigned.com ');

    assert.equal(r.identity, 'redteam@kysigned.com');
    assert.equal(r.signatureArtifactsDeleted, 1); // e1's artifact — the FK-cascade gap this fix closes
    assert.equal(r.envelopesDeleted, 1);
    assert.equal(r.authSessionsDeleted, 1);
    assert.equal(r.userCreditsDeleted, 1);
    assert.equal(r.creditLedgerDeleted, 2); // includes the signup_grant row → trap re-opens
    assert.equal(pool._signatureArtifacts.length, 1); // other@x.com's artifact (e2) survives
    assert.equal(pool._envelopes.length, 1); // other@x.com envelope survives
    assert.equal(pool._creditLedger.length, 1); // other@x.com ledger survives
    assert.equal(pool._userCredits.length, 0);
  });

  it('F-37: purges the identity\'s attribution rows keyed by the NORMALIZED inbox (gmail dots/+tags collapse)', async () => {
    const pool = createInMemoryPool();
    pool._attributionCaptures.push(
      { normalized_email: 'redteam@gmail.com' },
      { normalized_email: 'other@x.com' },
    );
    pool._creatorAttribution.push(
      { normalized_email: 'redteam@gmail.com' },
      { normalized_email: 'other@x.com' },
    );
    // The stored key is the normalizeInbox form — a dotted/+tagged sign-in variant
    // must still purge it (trim+lowercase alone would MISS these rows).
    const r = await resetTestAccount(pool, ' Red.Team+probe@GMail.com ');
    assert.equal(r.attributionCapturesDeleted, 1);
    assert.equal(r.creatorAttributionDeleted, 1);
    assert.equal(pool._attributionCaptures.length, 1, "other identity's capture survives");
    assert.equal(pool._creatorAttribution.length, 1, "other identity's stamp survives");
  });

  it('returns zero counts for an identity with no rows (idempotent)', async () => {
    const pool = createInMemoryPool();
    const r = await resetTestAccount(pool, 'nobody@kysigned.com');
    assert.equal(r.signatureArtifactsDeleted, 0);
    assert.equal(r.envelopesDeleted, 0);
    assert.equal(r.authSessionsDeleted, 0);
    assert.equal(r.userCreditsDeleted, 0);
    assert.equal(r.creditLedgerDeleted, 0);
  });
});

describe('handleTestResetUser — secret + identity gating (F-28 / AC-116)', () => {
  const pattern = /^redteam.*@kysigned\.com$/;

  it('with the secret and a pattern-matched identity, purges and returns 200', async () => {
    const pool = createInMemoryPool();
    pool._userCredits.push({ email: 'redteam@kysigned.com' });
    pool._creditLedger.push({ email: 'redteam@kysigned.com', source: 'signup_grant' });

    const r = await handleTestResetUser(
      { pool, resetSecret: 'S3CRET', identityPattern: pattern },
      { email: 'redteam@kysigned.com', secret: 'S3CRET' },
    );

    assert.equal(r.status, 200);
    assert.equal(pool._userCredits.length, 0);
    assert.equal(pool._creditLedger.length, 0);
  });

  it('refuses an identity outside the pattern with 403 and ZERO mutation', async () => {
    const pool = createInMemoryPool();
    pool._userCredits.push({ email: 'realuser@example.com' });

    const r = await handleTestResetUser(
      { pool, resetSecret: 'S3CRET', identityPattern: pattern },
      { email: 'realuser@example.com', secret: 'S3CRET' },
    );

    assert.equal(r.status, 403);
    assert.equal(pool._userCredits.length, 1); // real user untouched
    assert.equal(pool._queries.length, 0); // no DELETE was ever issued
  });

  it('is disabled (404) when no reset secret is configured — cannot reach any data', async () => {
    const pool = createInMemoryPool();
    pool._userCredits.push({ email: 'redteam@kysigned.com' });

    const r = await handleTestResetUser(
      { pool, resetSecret: undefined, identityPattern: pattern },
      { email: 'redteam@kysigned.com', secret: 'anything' },
    );

    assert.equal(r.status, 404);
    assert.equal(pool._userCredits.length, 1); // untouched
    assert.equal(pool._queries.length, 0);
  });

  it('rejects a wrong secret with 401 and zero mutation', async () => {
    const pool = createInMemoryPool();
    pool._userCredits.push({ email: 'redteam@kysigned.com' });

    const r = await handleTestResetUser(
      { pool, resetSecret: 'S3CRET', identityPattern: pattern },
      { email: 'redteam@kysigned.com', secret: 'WRONG' },
    );

    assert.equal(r.status, 401);
    assert.equal(pool._userCredits.length, 1);
    assert.equal(pool._queries.length, 0);
  });

  it('fail-closed: with a secret but NO pattern configured, refuses all (403)', async () => {
    const pool = createInMemoryPool();
    pool._userCredits.push({ email: 'redteam@kysigned.com' });

    const r = await handleTestResetUser(
      { pool, resetSecret: 'S3CRET', identityPattern: undefined },
      { email: 'redteam@kysigned.com', secret: 'S3CRET' },
    );

    assert.equal(r.status, 403);
    assert.equal(pool._userCredits.length, 1);
  });
});
