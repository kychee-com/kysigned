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
  summarizeTelemetry,
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
  campaign: 'none',
  device: 'unknown',
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
    // Spec 0.62.0: the exhaustive record shape is the NINE F-38.1/F-38.9 fields —
    // the campaign label (67.13) and the coarse device class (69.2) joined; still
    // no identifier of any kind.
    assert.deepEqual(cols, ['campaign', 'country', 'device', 'element', 'event', 'occurred_at', 'page', 'page_seq', 'source']);
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

describe('telemetryEvents — operator funnel summary (F-38.6 / AC-219)', () => {
  function seededPool(rows: Array<Record<string, unknown>>) {
    const texts: string[] = [];
    const pool: DbPool = {
      async query(text: string, values?: unknown[]) {
        texts.push(text);
        if (/SELECT/i.test(text) && /FROM telemetry_events/i.test(text)) {
          const since = (values ?? [])[0] as Date;
          return {
            rows: rows.filter((r) => (r.occurred_at as Date) >= since),
            rowCount: rows.length,
            command: '',
            oid: 0,
            fields: [],
          } as never;
        }
        return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as never;
      },
      async end() {},
    };
    return { pool, texts };
  }

  const at = (d: string) => new Date(d);
  const NOW = new Date('2026-07-23T12:00:00Z');
  const r = (event: string, over: Record<string, unknown> = {}) => ({
    occurred_at: at('2026-07-22T10:00:00Z'),
    event,
    page: 'home',
    element: null,
    country: 'IL',
    source: 'paid',
    campaign: 'summer_launch',
    device: 'desktop',
    page_seq: 1,
    ...over,
  });

  it('returns every funnel step in order — landing through session-created incl. the F-39.5 editor steps — split by source and country, plus home per-element clicks (AC-219 0.61.0)', async () => {
    const { pool } = seededPool([
      r('page_view'),
      r('page_view', { country: 'US', source: 'organic', campaign: 'spring_promo', device: 'mobile' }),
      r('click', { element: 'cta_create:hero' }),
      r('click', { element: 'cta_create:header', country: 'US', source: 'organic', campaign: 'spring_promo', device: 'mobile' }),
      r('click', { element: 'other:faq' }), // home click, NOT a create click
      // F-39.5 — the editor steps. The create-page landing counts BOTH as a
      // generic landing and as editor_reached (page-scoped page_view).
      r('page_view', { page: 'create' }),
      r('draft_started', { page: 'create' }),
      r('send_clicked', { page: 'create' }),
      r('signin_prompt', { element: 'send', page: 'create' }),
      r('signin_prompt', { element: 'redirect', page: 'signin' }),
      r('signin_email_focus', { page: 'signin' }),
      r('signin_submit', { page: 'signin' }),
      r('send_ok', { page: 'signin', source: 'paid' }),
      r('link_opened', { page: 'signin', source: 'unknown' }),
      r('session_created', { page: 'signin', source: 'unknown' }),
      // outside the window — must not count
      r('page_view', { occurred_at: at('2026-05-01T00:00:00Z') }),
    ]);
    const s = await summarizeTelemetry(pool, { windowDays: 7, now: NOW });
    assert.deepEqual(
      s.steps.map((x) => [x.step, x.count]),
      [
        ['landed', 3],
        ['clicked_create', 2],
        ['editor_reached', 1],
        ['draft_started', 1],
        ['send_clicked', 1],
        ['prompt_shown', 2],
        ['email_touched', 1],
        ['link_requested', 1],
        ['link_sent', 1],
        ['link_opened', 1],
        ['session_created', 1],
      ],
    );
    assert.deepEqual(s.by_source.organic, [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(s.by_source.paid[0], 2);
    assert.deepEqual(s.by_country.US, [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(s.by_country.IL[0], 2);
    // AC-219 (0.60.0): the campaign split answers "what did campaign X's visitors do".
    assert.equal(s.by_campaign.summer_launch[0], 2);
    assert.deepEqual(s.by_campaign.spring_promo, [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(s.home_clicks, { 'cta_create:hero': 1, 'cta_create:header': 1, 'other:faq': 1 });
    // AC-233 (0.62.0): the device split, and the source×device cross that isolates
    // e.g. paid×mobile. Two rows here are mobile (organic/US); everything else desktop.
    assert.deepEqual(s.by_device.mobile, [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(s.by_device.desktop[0], 2); // two desktop landings in-window (home + create page_view)
    assert.deepEqual(s.by_source_device['organic|mobile'], [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(s.by_source_device['paid|desktop'][0], 2);
  });

  it('an empty window returns zeroed steps, empty splits', async () => {
    const { pool } = seededPool([]);
    const s = await summarizeTelemetry(pool, { windowDays: 7, now: NOW });
    assert.equal(s.steps.length, 11);
    assert.ok(s.steps.every((x) => x.count === 0));
    assert.deepEqual(s.by_source, {});
    assert.deepEqual(s.by_campaign, {});
    assert.deepEqual(s.by_device, {});
    assert.deepEqual(s.by_source_device, {});
    assert.deepEqual(s.home_clicks, {});
  });
});
