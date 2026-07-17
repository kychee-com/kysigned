/**
 * adminAnalytics — F-34 operator-console analytics DAOs.
 *
 * These power the operator console's aggregate pages (overview, accounts,
 * envelopes, signals). Per DD-40/DD-41 they fetch the (small) tables and do all
 * window / band / classification arithmetic in JS — read-time at kysigned's scale
 * (a cached rollup is the deferred optimization), which keeps the aggregation
 * directly unit-testable. Internal-test envelopes (F-3.7) are excluded in SQL.
 *
 * `now`/`since` are injected by the caller (from `parseWindow`) so the arithmetic
 * is deterministic. Credit sums are micros returned as decimal strings (bigint).
 */
import type { DbPool } from './pool.js';

const H = 3_600_000;
const D = 24 * H;

/** In-window iff there is no lower bound, or the timestamp is at/after it. */
function inWindow(ts: string | Date | null | undefined, since: Date | null): boolean {
  if (since === null) return true;
  if (ts == null) return false;
  return new Date(ts).getTime() >= since.getTime();
}

const IN_PROCESS = new Set(['active', 'awaiting_seal']);
const PAID_SOURCES = new Set(['x402', 'stripe']);

export interface OverviewResult {
  accountsOpened: number;
  envelopes: { created: number; completed: number; inProcess: number };
  credits: { paidInUsdMicros: string; grantedUsdMicros: string; consumedUsdMicros: string };
  activeUsers: { dau: number; wau: number; mau: number };
}

interface CreditRow { email: string; source: string; delta_usd_micros: number | string; created_at: string | Date }
interface EnvRow { sender_email: string; status: string; created_at: string | Date; completed_at?: string | Date | null }
interface SessionRow { email: string; last_used_at: string | Date }
interface UserRow { email: string; balance_usd_micros: number | string; created_at: string | Date }

export async function getOverview(
  pool: DbPool,
  opts: { since: Date | null; now: Date },
): Promise<OverviewResult> {
  const { since, now } = opts;
  const [users, envelopes, ledger, sessions] = await Promise.all([
    pool.query('SELECT email, balance_usd_micros, created_at FROM user_credits'),
    pool.query('SELECT sender_email, status, created_at, completed_at FROM envelopes WHERE internal_test = false'),
    pool.query('SELECT email, source, delta_usd_micros, created_at FROM credit_ledger'),
    pool.query('SELECT email, last_used_at FROM auth_sessions'),
  ]);
  const userRows = users.rows as UserRow[];
  const envRows = envelopes.rows as EnvRow[];
  const ledgerRows = ledger.rows as CreditRow[];
  const sessionRows = sessions.rows as SessionRow[];

  const accountsOpened = userRows.filter((u) => inWindow(u.created_at, since)).length;

  const cohort = envRows.filter((e) => inWindow(e.created_at, since));
  const envelopeCounts = {
    created: cohort.length,
    completed: cohort.filter((e) => e.status === 'completed').length,
    inProcess: cohort.filter((e) => IN_PROCESS.has(e.status)).length,
  };

  let paidIn = 0n;
  let granted = 0n;
  let consumed = 0n;
  for (const row of ledgerRows) {
    if (!inWindow(row.created_at, since)) continue;
    const delta = BigInt(row.delta_usd_micros);
    if (PAID_SOURCES.has(row.source) && delta > 0n) paidIn += delta;
    else if (row.source === 'signup_grant') granted += delta;
    else if (row.source === 'envelope') consumed += -delta; // debits are negative → positive consumed
  }

  const activeInBand = (bandMs: number): number => {
    const floor = now.getTime() - bandMs;
    const emails = new Set<string>();
    for (const s of sessionRows) if (new Date(s.last_used_at).getTime() >= floor) emails.add(s.email);
    for (const e of envRows) if (new Date(e.created_at).getTime() >= floor) emails.add(e.sender_email);
    return emails.size;
  };

  return {
    accountsOpened,
    envelopes: envelopeCounts,
    credits: {
      paidInUsdMicros: paidIn.toString(),
      grantedUsdMicros: granted.toString(),
      consumedUsdMicros: consumed.toString(),
    },
    activeUsers: { dau: activeInBand(24 * H), wau: activeInBand(7 * D), mau: activeInBand(30 * D) },
  };
}
