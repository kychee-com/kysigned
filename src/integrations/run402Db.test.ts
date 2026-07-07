/**
 * run402Db.test.ts — HttpDbPool over @run402/functions adminDb().sql() (14.5).
 *
 * kysigned's prod DB pool: the `DbPool` interface over run402's HTTP SQL surface.
 *
 * ⚠️ The REAL run402 `/projects/v1/admin/:id/sql` endpoint returns a WRAPPER
 * object `{ status, schema, rows, row_count, fields }` — NOT a bare rows array
 * (despite the SDK typing `.sql()` as an array). An earlier version of this test
 * mocked `.sql()` as a bare array, which hid a prod-breaking bug: the pool
 * consumed the whole wrapper as `rows`, so `rows[0]` was `undefined` for EVERY
 * query (sessions never resolved, the dashboard was empty, …). The fake now
 * returns the real wrapper, and the pool unwraps `.rows`/`.row_count`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpDbPool, type Run402AdminDb } from './run402Db.js';

/** A fake that returns the REAL run402 `/sql` wrapper shape. */
function fakeAdminDb(
  rows: Record<string, unknown>[] = [],
  capture?: (q: string, p?: unknown[]) => void,
  rowCount?: number,
): Run402AdminDb {
  return {
    async sql(q, p) {
      capture?.(q, p);
      return { status: 'ok', schema: 'p0', rows, row_count: rowCount ?? rows.length, fields: [] };
    },
  };
}

describe('createHttpDbPool — over run402 /sql wrapper', () => {
  it('UNWRAPS the {status, rows, row_count} wrapper (not the wrapper itself as rows)', async () => {
    const pool = createHttpDbPool(fakeAdminDb([{ id: 'a' }, { id: 'b' }]));
    const res = await pool.query('SELECT id FROM envelopes');
    // The regression: res.rows must be the ACTUAL rows, not the wrapper object.
    assert.deepEqual(res.rows, [{ id: 'a' }, { id: 'b' }]);
    assert.equal((res.rows[0] as { id: string }).id, 'a');
    assert.equal(res.rowCount, 2);
  });

  it('forwards the SQL text + positional params to adminDb.sql verbatim', async () => {
    let seen: { q?: string; p?: unknown[] } = {};
    const pool = createHttpDbPool(fakeAdminDb([], (q, p) => (seen = { q, p })));
    await pool.query('SELECT $1::int AS n', [7]);
    assert.equal(seen.q, 'SELECT $1::int AS n');
    assert.deepEqual(seen.p, [7]);
  });

  it('uses the wrapper row_count for a no-RETURNING write (rows empty, count > 0)', async () => {
    // An UPDATE with no RETURNING returns rows:[] but row_count = affected rows.
    // Guarded writes (e.g. markSignerSignedByEmail) depend on this count.
    const pool = createHttpDbPool(fakeAdminDb([], undefined, 3));
    const res = await pool.query('UPDATE envelope_signers SET status = $1 WHERE id = $2', ['signed', 'x']);
    assert.equal(res.rowCount, 3);
    assert.deepEqual(res.rows, []);
  });

  it('rowCount is 0 for a genuinely empty result', async () => {
    const pool = createHttpDbPool(fakeAdminDb([]));
    const res = await pool.query('SELECT id FROM envelopes WHERE 1=0');
    assert.equal(res.rowCount, 0);
    assert.deepEqual(res.rows, []);
  });

  it('defensively still works if a future SDK hands back a bare rows array', async () => {
    const bareArray: Run402AdminDb = { async sql() { return [{ id: 'z' }]; } };
    const pool = createHttpDbPool(bareArray);
    const res = await pool.query('SELECT id FROM envelopes');
    assert.deepEqual(res.rows, [{ id: 'z' }]);
    assert.equal(res.rowCount, 1);
  });

  it('end() resolves without error (HTTP pool — nothing to close)', async () => {
    const pool = createHttpDbPool(fakeAdminDb());
    await pool.end();
  });
});

// AC-58 — run402's HTTP wire is lower_snake_case (the org-only cleanup). The
// HttpDbPool must map snake_case column keys through verbatim.
describe('createHttpDbPool — AC-58 lower_snake_case wire contract', () => {
  it('passes snake_case column keys through verbatim (never camelCases them)', async () => {
    const pool = createHttpDbPool(
      fakeAdminDb([{ sender_email: 'a@x.com', document_hash: 'd'.repeat(64) }]),
    );
    const res = await pool.query('SELECT sender_email, document_hash FROM envelopes');
    const row = res.rows[0] as Record<string, unknown>;
    assert.equal(row.sender_email, 'a@x.com');
    assert.equal(row.document_hash, 'd'.repeat(64));
    // A consumer assuming run402 returns pg-style camelCase would read undefined.
    assert.equal('senderEmail' in row, false);
  });
});
