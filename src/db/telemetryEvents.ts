/**
 * telemetryEvents — F-38 pre-signin funnel telemetry store (spec 0.59.0, DD-50).
 *
 * Append-only, identifier-free by construction: a record is EXACTLY the seven
 * F-38.1 fields — occurrence time, event name, page, element, country, source
 * bucket, per-page-load seq. No account/visitor id, no cookie state, no click-id
 * value, no referrer, no user agent, no IP — those must never even reach this
 * module. Migration 015 ships the schema. Rows prune after 90 days (F-38.7,
 * housekeeping not compliance — nothing here is personal data); the prune rides
 * the existing retention_sweep schedule, no new cron (AC-121 posture).
 */
import type { DbPool } from './pool.js';

/** F-38.7: telemetry rows prune after 90 days. */
export const TELEMETRY_RETENTION_DAYS = 90;

/** The exhaustive F-38.1 record shape — the schema mirrors it 1:1. */
export interface TelemetryEventRow {
  occurredAt: Date;
  event: string;
  page: string;
  /** Named element / catch-all destination / step detail; null when the event has none. */
  element: string | null;
  /** ISO 3166-1 alpha-2 code the platform provided, or the explicit 'unknown'. */
  country: string;
  /** Coarse traffic-source bucket: paid | organic | referral | direct | unknown. */
  source: string;
  /**
   * The operator's own campaign tag from the arriving link (`utm_campaign`),
   * normalized to a bounded token — a cohort name shared by every visitor the
   * campaign brings, never a per-visitor value. 'none' when absent.
   */
  campaign: string;
  /** Per-page-load sequence id — orders records within ONE page view only. */
  pageSeq: number;
}

/**
 * Append a batch of telemetry records in one statement. The column list is the
 * exhaustive seven — the shape lock in the test suite fails if it ever grows.
 * Values are picked field-by-field so an unexpected property on a row object
 * can never reach the database.
 */
export async function insertTelemetryEvents(pool: DbPool, rows: TelemetryEventRow[]): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples: string[] = [];
  for (const r of rows) {
    const base = values.length;
    values.push(r.occurredAt, r.event, r.page, r.element, r.country, r.source, r.campaign, r.pageSeq);
    tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`);
  }
  await pool.query(
    `INSERT INTO telemetry_events (occurred_at, event, page, element, country, source, campaign, page_seq)
     VALUES ${tuples.join(', ')}`,
    values,
  );
}

/** Delete rows older than the retention window; returns the pruned count. */
export async function pruneTelemetryEvents(pool: DbPool, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - TELEMETRY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const res = await pool.query(`DELETE FROM telemetry_events WHERE occurred_at < $1`, [cutoff]);
  return res.rowCount ?? 0;
}

// ── F-38.6 — the operator funnel summary ────────────────────────────────────

/** The eight funnel steps, in order (AC-219). */
export const TELEMETRY_FUNNEL_STEPS: ReadonlyArray<{ step: string; event: string }> = [
  { step: 'landed', event: 'page_view' },
  { step: 'clicked_create', event: 'click' }, // click on a cta_create element
  { step: 'prompt_shown', event: 'signin_prompt' },
  { step: 'email_touched', event: 'signin_email_focus' },
  { step: 'link_requested', event: 'signin_submit' },
  { step: 'link_sent', event: 'send_ok' },
  { step: 'link_opened', event: 'link_opened' },
  { step: 'session_created', event: 'session_created' },
];

export interface TelemetryFunnelSummary {
  window_days: number;
  steps: Array<{ step: string; event: string; count: number }>;
  /** Per-bucket eight-step counts, in TELEMETRY_FUNNEL_STEPS order. */
  by_source: Record<string, number[]>;
  /** Per-country eight-step counts, in TELEMETRY_FUNNEL_STEPS order. */
  by_country: Record<string, number[]>;
  /** Per-campaign eight-step counts (AC-219 0.60.0 — the cohort read). */
  by_campaign: Record<string, number[]>;
  /** Home-page per-element click counts (F-38.2's named + catch-all buckets). */
  home_clicks: Record<string, number>;
}

interface SummaryRow {
  event: string;
  page: string;
  element: string | null;
  country: string;
  source: string;
  campaign: string;
}

/** True when a row lands the given funnel step. */
function isStep(row: SummaryRow, stepIndex: number): boolean {
  const def = TELEMETRY_FUNNEL_STEPS[stepIndex];
  if (row.event !== def.event) return false;
  // Step 2 is specifically a create-envelope click, wherever it sits.
  if (def.step === 'clicked_create') return (row.element ?? '').startsWith('cta_create');
  return true;
}

/**
 * The operator funnel view (F-38.6): fetch the window's rows and aggregate in
 * JS (the DD-40 read-time posture — rows are bounded by the caps + the 90-day
 * prune). Answers: how many visitors reached each step, in order, split by
 * source bucket and by country, plus the home page's per-element clicks.
 */
export async function summarizeTelemetry(
  pool: DbPool,
  opts: { windowDays: number; now?: Date },
): Promise<TelemetryFunnelSummary> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.windowDays * 24 * 60 * 60 * 1000);
  const res = await pool.query(
    `SELECT event, page, element, country, source, campaign FROM telemetry_events WHERE occurred_at >= $1`,
    [since],
  );
  const rows = (res.rows ?? []) as SummaryRow[];

  const stepCounts = TELEMETRY_FUNNEL_STEPS.map(() => 0);
  const bySource: Record<string, number[]> = {};
  const byCountry: Record<string, number[]> = {};
  const byCampaign: Record<string, number[]> = {};
  const homeClicks: Record<string, number> = {};

  const bump = (map: Record<string, number[]>, key: string, stepIndex: number) => {
    if (!map[key]) map[key] = TELEMETRY_FUNNEL_STEPS.map(() => 0);
    map[key][stepIndex] += 1;
  };

  for (const row of rows) {
    for (let i = 0; i < TELEMETRY_FUNNEL_STEPS.length; i++) {
      if (!isStep(row, i)) continue;
      stepCounts[i] += 1;
      bump(bySource, row.source, i);
      bump(byCountry, row.country, i);
      bump(byCampaign, row.campaign ?? 'none', i);
    }
    if (row.event === 'click' && row.page === 'home' && row.element) {
      homeClicks[row.element] = (homeClicks[row.element] ?? 0) + 1;
    }
  }

  return {
    window_days: opts.windowDays,
    steps: TELEMETRY_FUNNEL_STEPS.map((s, i) => ({ ...s, count: stepCounts[i] })),
    by_source: bySource,
    by_country: byCountry,
    by_campaign: byCampaign,
    home_clicks: homeClicks,
  };
}
