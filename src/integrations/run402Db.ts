/**
 * run402Db — kysigned's prod `DbPool` over run402's HTTP SQL surface (14.5).
 *
 * Production runs as a run402 function; the DB is reached through
 * `@run402/functions` `adminDb().sql(query, params)` (service_role, BYPASSRLS),
 * NOT a kysigned-managed Postgres. The run402 gateway wraps each `sql()` call in
 * its own server-side BEGIN/COMMIT, so a single multi-CTE statement (e.g.
 * `createEnvelope`) is atomic — which is why the `DbPool` interface only needs
 * `query()` + `end()` (no cross-call transactions; see db/pool.ts / DD-10).
 *
 * `adminDb().sql` is captured here as a STRUCTURAL type so the core library carries
 * no `@run402/functions` runtime dependency and this is unit-tested against a fake;
 * the real `adminDb()` is injected at the run402-function entry.
 */
import type pg from 'pg';
import type { DbPool } from '../db/pool.js';

/**
 * The subset of `@run402/functions` `adminDb()` kysigned uses: raw SQL → result.
 *
 * ⚠️ run402's `/projects/v1/admin/:id/sql` endpoint returns a WRAPPER object
 * `{ status, schema, rows, row_count, fields }`, NOT a bare rows array — even
 * though the SDK types `.sql()` as `Promise<Record<string,unknown>[]>`. We type
 * the result `unknown` so that SDK lie can't make the pool consume the wrapper
 * as if it were the rows; `createHttpDbPool` unwraps `.rows` / `.row_count`.
 */
export interface Run402AdminDb {
  sql(query: string, params?: unknown[]): Promise<unknown>;
}

/** The real run402 `/sql` response wrapper. */
interface Run402SqlResult {
  rows?: Record<string, unknown>[];
  row_count?: number;
}

/**
 * Build a `DbPool` backed by run402's HTTP SQL. run402's `/sql` returns the
 * `{ status, rows, row_count, fields }` wrapper, so we extract `.rows` +
 * `.row_count` (with a defensive fall-back to a bare-array shape, so a future SDK
 * that unwraps still works). The DAO layer reads `.rows` and — for RETURNING /
 * guarded writes — `.rowCount`.
 */
export function createHttpDbPool(adminDb: Run402AdminDb): DbPool {
  return {
    async query(text: string, values?: unknown[]) {
      const result = (await adminDb.sql(text, values)) as Run402SqlResult | Record<string, unknown>[];
      const rows = Array.isArray(result) ? result : (result.rows ?? []);
      const rowCount = Array.isArray(result) ? result.length : (result.row_count ?? rows.length);
      // Only `rows` + `rowCount` are consumed by the DAO layer; the rest of
      // pg.QueryResult is filled to satisfy the type without a real pg round-trip.
      return {
        rows,
        rowCount,
        command: '',
        oid: 0,
        fields: [],
      } as unknown as pg.QueryResult;
    },
    async end() {
      // HTTP-backed pool — no sockets to close.
    },
  };
}
