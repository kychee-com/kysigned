/**
 * telemetryEvents — F-38 pre-signin funnel telemetry store (spec 0.59.0, DD-50).
 *
 * The F-38.1 record shape IS the schema: occurrence time, event name, page,
 * element, country, source bucket, per-page-load seq — and NOTHING else. The
 * insert path is locked exhaustively so a row can never grow an extra field
 * (an email, an ip, a referrer) without failing here first.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DbPool } from './pool.js';
import {
  insertTelemetryEvents,
  pruneTelemetryEvents,
  TELEMETRY_RETENTION_DAYS,
  type TelemetryEventRow,
} from './telemetryEvents.js';

function capturePool() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values: values ?? [] });
      return { rows: [], rowCount: 3, command: '', oid: 0, fields: [] };
    },
    async end() {},
  };
  return { pool, calls };
}

const row = (over: Partial<TelemetryEventRow> = {}): TelemetryEventRow => ({
  occurredAt: new Date('2026-07-23T10:00:00Z'),
  event: 'page_view',
  page: 'home',
  element: null,
  country: 'unknown',
  source: 'direct',
  pageSeq: 1,
  ...over,
});

describe('telemetryEvents — insert (F-38.1 identifier-free shape lock)', () => {
  it('inserts a batch with EXACTLY the seven record columns, nothing else', async () => {
    const { pool, calls } = capturePool();
    await insertTelemetryEvents(pool, [row(), row({ event: 'click', element: 'cta_create', pageSeq: 2 })]);
    assert.equal(calls.length, 1);
    const sql = calls[0].text;
    // Column list is the exhaustive seven — the spec's record shape.
    const colsMatch = sql.match(/INSERT INTO telemetry_events\s*\(([^)]*)\)/i);
    assert.ok(colsMatch, `insert must target telemetry_events with an explicit column list: ${sql}`);
    const cols = colsMatch[1].split(',').map((c) => c.trim()).sort();
    assert.deepEqual(cols, ['country', 'element', 'event', 'occurred_at', 'page', 'page_seq', 'source']);
  });

  it('an extra property smuggled onto a row object never reaches the SQL params', async () => {
    const { pool, calls } = capturePool();
    const dirty = { ...row(), email: 'leak@example.com', ip: '203.0.113.9' } as unknown as TelemetryEventRow;
    await insertTelemetryEvents(pool, [dirty]);
    const flat = JSON.stringify(calls[0].values);
    assert.ok(!flat.includes('leak@example.com'), 'unexpected field leaked into params');
    assert.ok(!flat.includes('203.0.113.9'), 'unexpected field leaked into params');
  });

  it('an empty batch is a no-op (zero queries)', async () => {
    const { pool, calls } = capturePool();
    await insertTelemetryEvents(pool, []);
    assert.equal(calls.length, 0);
  });
});

describe('telemetryEvents — prune (F-38.7, 90-day retention)', () => {
  it('deletes only rows older than the retention window and reports the count', async () => {
    const { pool, calls } = capturePool();
    assert.equal(TELEMETRY_RETENTION_DAYS, 90);
    const now = new Date('2026-07-23T12:00:00Z');
    const pruned = await pruneTelemetryEvents(pool, now);
    assert.equal(pruned, 3);
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /DELETE FROM telemetry_events/i);
    assert.match(calls[0].text, /occurred_at\s*<\s*\$1/i);
    const cutoff = calls[0].values[0] as Date;
    assert.equal(cutoff.toISOString(), new Date('2026-04-24T12:00:00Z').toISOString());
  });
});
