/**
 * signupGrantMonitor — trial-credit abuse monitor + operator alert (F-16.6 /
 * AC-97, Phase 25).
 *
 * The new-account grant (F-13.4) deliberately relaxes the credit-gate for
 * first-time creators, so it is MONITORED rather than fully Sybil-defended (DD-14):
 * a daily cron reads grant issuance + grant-funded envelope volume from the
 * credit_ledger over a rolling window and emails the operator when issuance
 * exceeds a configured rate. That gives a visible signal to disable the grant
 * (set KYSIGNED_SIGNUP_GRANT_CREDITS=0 + redeploy) — there is no runtime
 * kill-switch by design (Barry 2026-06-29). The ledger IS the metric store, so
 * "recorded in operator usage metrics" is the queryable ledger plus the cron's
 * logged JSON summary; no kysigned-owned CloudWatch (run402-only architecture).
 *
 * The alert is internal operator mail (notifications@ → info@, the human inbox,
 * F-19.1), not customer-facing.
 */
import type { DbPool } from '../db/pool.js';
import type { EmailProvider } from '../email/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface SignupGrantStats {
  /** signup_grant ledger rows issued inside the window. */
  issuanceCount: number;
  /**
   * Envelope debits inside the window by accounts that hold a signup_grant
   * (grant-funded volume, distinguished from pure-purchaser envelopes). Fungible
   * credits mean this is a proxy — a grant-recipient who also purchased is
   * included — but it is the abuse-relevant slice.
   */
  grantFundedEnvelopeCount: number;
}

export interface SignupGrantMonitorDeps {
  emailProvider: EmailProvider;
  operatorDomain: string;
  /** Alert when issuance in the window exceeds this. <= 0 disables alerting (the metric is still computed/logged). */
  alertThreshold: number;
  /** Rolling window in ms. Default 24h. */
  windowMs?: number;
  /** Injected for tests; defaults to the call time. */
  now?: Date;
}

export interface SignupGrantMonitorResult {
  stats: SignupGrantStats;
  windowHours: number;
  threshold: number;
  alerted: boolean;
}

/** Read grant issuance + grant-funded envelope volume since `since`. */
export async function getSignupGrantStats(pool: DbPool, since: Date): Promise<SignupGrantStats> {
  const issuance = await pool.query(
    `SELECT count(*)::int AS n FROM credit_ledger
       WHERE source = 'signup_grant' AND created_at >= $1`,
    [since.toISOString()],
  );
  const granted = await pool.query(
    `SELECT count(*)::int AS n FROM credit_ledger
       WHERE source = 'envelope' AND created_at >= $1
         AND email IN (SELECT email FROM credit_ledger WHERE source = 'signup_grant')`,
    [since.toISOString()],
  );
  const n = (r: { rows: unknown[] }) => Number((r.rows[0] as { n: number } | undefined)?.n ?? 0);
  return { issuanceCount: n(issuance), grantFundedEnvelopeCount: n(granted) };
}

/** Pure: does issuance breach a positive threshold? A threshold <= 0 disables alerting. */
export function exceedsGrantRate(stats: SignupGrantStats, threshold: number): boolean {
  return threshold > 0 && stats.issuanceCount > threshold;
}

/**
 * Read the window's stats and, on a breach, email the operator. Returns the
 * stats + verdict so the cron can log them (the "usage metric"). Alerting is
 * best-effort from the caller's perspective; a send failure throws and the next
 * tick retries (the cron wraps it).
 */
export async function runSignupGrantMonitor(
  pool: DbPool,
  deps: SignupGrantMonitorDeps,
): Promise<SignupGrantMonitorResult> {
  const windowMs = deps.windowMs ?? DAY_MS;
  const now = deps.now ?? new Date();
  const since = new Date(now.getTime() - windowMs);
  const windowHours = Math.round(windowMs / HOUR_MS);

  const stats = await getSignupGrantStats(pool, since);
  const alerted = exceedsGrantRate(stats, deps.alertThreshold);

  if (alerted) {
    const text =
      `New-account trial-credit grants in the last ${windowHours}h: ${stats.issuanceCount} ` +
      `(alert threshold ${deps.alertThreshold}). Grant-funded envelopes in the same window: ` +
      `${stats.grantFundedEnvelopeCount}. If this is abuse, disable the grant by setting ` +
      `KYSIGNED_SIGNUP_GRANT_CREDITS=0 and redeploying.`;
    await deps.emailProvider.send({
      to: `info@${deps.operatorDomain}`,
      from: `notifications@${deps.operatorDomain}`,
      subject: `kysigned: trial-credit issuance spike (${stats.issuanceCount} in ${windowHours}h)`,
      text,
      html: `<p>${text}</p>`,
    });
  }

  return { stats, windowHours, threshold: deps.alertThreshold, alerted };
}
