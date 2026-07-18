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
import type { EmitAppEvent } from '../integrations/appEvents.js';
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
  /**
   * Operator alert recipient (F-32.7-family routing). Default `info@<operatorDomain>`
   * — but the in-project mailboxes are store-only, so kysigned.com configures an
   * external inbox (KYSIGNED_OPERATOR_ALERT_EMAIL; interim until #149).
   */
  alertEmail?: string;
  /** Alert when issuance in the window exceeds this. <= 0 disables alerting (the metric is still computed/logged). */
  alertThreshold: number;
  /** Rolling window in ms. Default 24h. */
  windowMs?: number;
  /** Injected for tests; defaults to the call time. */
  now?: Date;
  /** F-36 — the DD-43 app-events seam (never throws). Prod (runHandlers) wires it. */
  emitAppEvent?: EmitAppEvent;
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
      to: deps.alertEmail ?? `info@${deps.operatorDomain}`,
      from: `notifications@${deps.operatorDomain}`,
      subject: `kysigned: trial-credit issuance spike (${stats.issuanceCount} in ${windowHours}h)`,
      text,
      html: `<p>${text}</p>`,
    });
    // F-36 — sweep_anomaly with a DATED key (each day's breach is its own fact;
    // forever-dedup must not swallow a later real spike). Counts + enum only.
    await deps.emitAppEvent?.('sweep_anomaly', ['signup-grant-monitor', now.toISOString().slice(0, 10)], {
      monitor: 'signup_grant',
      issuance_count: stats.issuanceCount,
      grant_funded_envelopes: stats.grantFundedEnvelopeCount,
      threshold: deps.alertThreshold,
    });
  }

  return { stats, windowHours, threshold: deps.alertThreshold, alerted };
}
