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
    values.push(r.occurredAt, r.event, r.page, r.element, r.country, r.source, r.pageSeq);
    tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
  }
  await pool.query(
    `INSERT INTO telemetry_events (occurred_at, event, page, element, country, source, page_seq)
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
