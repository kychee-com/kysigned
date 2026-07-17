/**
 * Seeded in-memory DbPool for the F-34 operator-console analytics DAOs.
 *
 * NOT a test file (`.testpool.ts`) — a helper, excluded from the runner glob. The
 * analytics DAOs (`adminAnalytics.ts`) deliberately fetch small whole tables and
 * do all window / band / classification arithmetic in JS (DD-40/DD-41 — read-time
 * at kysigned's scale, rollup deferred), so this pool only has to return the
 * seeded rows for each table's `SELECT`. That keeps the AGGREGATION under test
 * (the prod code runs it, not a re-implementation here) and the pool trivial.
 */
import type { DbPool } from './pool.js';

export interface AdminAnalyticsSeed {
  userCredits?: Array<{ email: string; balance_usd_micros: number | string; created_at: string | Date }>;
  envelopes?: Array<{
    sender_email: string;
    status: string;
    created_at: string | Date;
    completed_at?: string | Date | null;
    internal_test?: boolean;
  }>;
  creditLedger?: Array<{ email: string; source: string; delta_usd_micros: number | string; created_at: string | Date }>;
  authSessions?: Array<{ email: string; last_used_at: string | Date }>;
  apiKeys?: Array<{ creator_email: string; revoked_at?: string | Date | null }>;
  signers?: Array<{
    envelope_id: string;
    status: string;
    undeliverable_at?: string | Date | null;
    created_at?: string | Date;
  }>;
}

export function createAdminAnalyticsMemoryPool(seed: AdminAnalyticsSeed = {}) {
  const clone = (r: unknown) => ({ ...(r as object) });
  const rows = (arr: unknown[] | undefined) => (arr ?? []).map(clone);

  const pool: DbPool = {
    async query(text: string) {
      if (text.includes('FROM user_credits')) return ok(rows(seed.userCredits));
      if (text.includes('FROM credit_ledger')) return ok(rows(seed.creditLedger));
      if (text.includes('FROM auth_sessions')) return ok(rows(seed.authSessions));
      if (text.includes('FROM api_keys')) return ok(rows(seed.apiKeys));
      if (text.includes('FROM envelope_signers')) return ok(rows(seed.signers));
      // F-35: the envelopes SELECT no longer carries a WHERE — the DAO fetches ALL
      // rows (incl. internal_test) and applies the exclude-internal filter in JS, so
      // return every seeded row and let the DAO's own predicate decide.
      if (text.includes('FROM envelopes')) {
        return ok(rows(seed.envelopes ?? []));
      }
      return ok([]);
    },
    async end() {},
  };
  return { pool };
}

function ok(rowsOut: unknown[]) {
  return { rows: rowsOut, rowCount: rowsOut.length, command: '', oid: 0, fields: [] } as never;
}
