import pg from 'pg';

/**
 * Narrow HTTP-compatible pool interface.
 *
 * Per DD-10 (run402/docs/plans/kysigned-plan.md), kysigned runs on run402's
 * existing HTTP DB surfaces (`@run402/functions` `db.sql()`) rather than
 * waiting for a direct-pg platform feature. HTTP-based DB access cannot hold
 * a cross-call pg transaction, so the interface only exposes `query()` +
 * `end()` — no `connect()`, no `pg.PoolClient`, no cross-call BEGIN/COMMIT.
 *
 * Local development still uses node-`pg`'s real `Pool`, which satisfies this
 * interface structurally. Production (deployed run402 Lambda) uses
 * `HttpDbPool` from the operator's private repo, a ~20-line adapter over
 * `@run402/functions.db.sql()`.
 *
 * Operations that formerly relied on cross-call transactions (notably
 * `createEnvelope`, which used `BEGIN → INSERT → INSERT → COMMIT`) are now
 * expressed as single multi-CTE statements — the run402 gateway wraps each
 * `db.sql()` call in its own server-side BEGIN/COMMIT, preserving atomicity
 * for any work that fits in one call.
 */
export interface DbPool {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>;
  end(): Promise<void>;
}

let _pool: DbPool | null = null;

export function initPool(config?: pg.PoolConfig): DbPool {
  const pool = new pg.Pool({
    host: config?.host ?? process.env.DB_HOST ?? 'localhost',
    port: config?.port ?? parseInt(process.env.DB_PORT ?? '5432', 10),
    database: config?.database ?? process.env.DB_NAME ?? 'kysigned',
    user: config?.user ?? process.env.DB_USER ?? 'postgres',
    password: config?.password ?? process.env.DB_PASSWORD ?? 'postgres',
    max: config?.max ?? 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...config,
  });

  pool.on('error', (err) => {
    console.error('Unexpected pool error:', err.message);
  });

  _pool = pool;
  return pool;
}

export function getPool(): DbPool {
  if (!_pool) throw new Error('Database pool not initialized. Call initPool() first.');
  return _pool;
}
