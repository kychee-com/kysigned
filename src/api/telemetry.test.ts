/**
 * telemetry — F-38 collection endpoint (spec 0.59.0, DD-50).
 *
 * Locks the door: allowlist normalization (a URL carrying an envelope id or a
 * signer token can NEVER become a stored value), unknown/oversized/malformed →
 * dropped, per-page cap, per-source rate limit, always-silent success to the
 * visitor, fork-default OFF = zero writes, and the F-38.5 derivation riders
 * (referrer, click-id fact) are used then DISCARDED — never stored.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DbPool } from '../db/pool.js';
import {
  normalizeTelemetryPage,
  normalizeCampaign,
  handleTelemetryCollect,
  createTelemetryLimiter,
  TELEMETRY_MAX_RECORDS_PER_POST,
  type TelemetryCollectCtx,
} from './telemetry.js';

function capturePool() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values: values ?? [] });
      return { rows: [], rowCount: 1, command: '', oid: 0, fields: [] };
    },
    async end() {},
  };
  return { pool, calls };
}

function ctx(pool: DbPool, over: Partial<TelemetryCollectCtx> = {}): TelemetryCollectCtx {
  return { pool, ownHost: 'kysigned.com', limiter: createTelemetryLimiter(), ...over };
}

const collect = (
  c: TelemetryCollectCtx | undefined,
  body: unknown,
  over: { headers?: Headers; sourceAddr?: string | null } = {},
) =>
  handleTelemetryCollect(c, {
    body,
    headers: over.headers ?? new Headers(),
    sourceAddr: over.sourceAddr ?? '198.51.100.7',
  });

const batch = (over: Record<string, unknown> = {}) => ({
  page: '/pricing',
  ref: 'https://news.ycombinator.com/item?id=1',
  gclid: false,
  records: [
    { event: 'page_view', seq: 1 },
    { event: 'click', element: 'cta_create:hero', seq: 2 },
  ],
  ...over,
});

describe('normalizeTelemetryPage (F-38.1 — the allowlist door)', () => {
  it('maps known public paths to their page names', () => {
    assert.equal(normalizeTelemetryPage('/'), 'home');
    assert.equal(normalizeTelemetryPage('/index.html'), 'home');
    assert.equal(normalizeTelemetryPage('/pricing.html'), 'pricing');
    assert.equal(normalizeTelemetryPage('/pricing'), 'pricing');
    assert.equal(normalizeTelemetryPage('/faq.html'), 'faq');
    assert.equal(normalizeTelemetryPage('/how-it-works.html'), 'how_it_works');
    assert.equal(normalizeTelemetryPage('/verify'), 'verify');
  });

  it('a signer link or an envelope page stores the page NAME, never the id or token', () => {
    const p = normalizeTelemetryPage('/sign/7d0723ec-aaaa-bbbb-cccc-121212121212/tok_SECRETSECRET');
    assert.equal(p, 'sign');
    assert.equal(normalizeTelemetryPage('/review/abc/def'), 'review');
    assert.equal(normalizeTelemetryPage('/dashboard/envelope/e6da6806'), 'dashboard');
  });

  it('unknown paths record as other; query/hash stripped; full URLs accepted', () => {
    assert.equal(normalizeTelemetryPage('/wat-is-this'), 'other');
    assert.equal(normalizeTelemetryPage('/pricing?gclid=SECRET#frag'), 'pricing');
    assert.equal(normalizeTelemetryPage('https://kysigned.com/faq.html?x=1'), 'faq');
  });
});

describe('normalizeCampaign (F-38.1 0.60.0 — bounded operator cohort tag)', () => {
  it('lowercases and passes clean tokens; none when absent; other when malformed', () => {
    assert.equal(normalizeCampaign('Summer_Launch-2026'), 'summer_launch-2026');
    assert.equal(normalizeCampaign(undefined), 'none');
    assert.equal(normalizeCampaign(''), 'none');
    assert.equal(normalizeCampaign('has spaces!'), 'other');
    assert.equal(normalizeCampaign('x'.repeat(65)), 'other');
    assert.equal(normalizeCampaign('<script>'), 'other');
    assert.equal(normalizeCampaign(42), 'none');
  });
});

describe('0.61.0 vocabulary — the moved gate (F-39.5 / AC-227 / AC-230)', () => {
  it('/dashboard/create normalizes to its OWN page value; other dashboard paths stay dashboard', () => {
    assert.equal(normalizeTelemetryPage('/dashboard/create'), 'create');
    assert.equal(normalizeTelemetryPage('/dashboard/create?step=2#top'), 'create');
    assert.equal(normalizeTelemetryPage('https://kysigned.com/dashboard/create'), 'create');
    assert.equal(normalizeTelemetryPage('create'), 'create'); // already-normalized name
    assert.equal(normalizeTelemetryPage('/dashboard'), 'dashboard');
    assert.equal(normalizeTelemetryPage('/dashboard/7d0723ec-aaaa-bbbb-cccc-000000000000'), 'dashboard');
    assert.equal(normalizeTelemetryPage('/dashboard/create/extra'), 'dashboard'); // only the exact editor route is create
  });

  it('draft_started and send_clicked are accepted from the browser, element-less', async () => {
    const { pool, calls } = capturePool();
    await collect(ctx(pool), batch({
      page: '/dashboard/create',
      records: [
        { event: 'page_view', seq: 1 },
        { event: 'draft_started', seq: 2 },
        { event: 'send_clicked', element: 'ignored-junk', seq: 3 },
      ],
    }));
    assert.equal(calls.length, 1);
    const vals = calls[0].values;
    assert.ok(vals.includes('draft_started'));
    assert.ok(vals.includes('send_clicked'));
    assert.ok(vals.includes('create'));
    assert.ok(!vals.includes('ignored-junk')); // element-less events store null
  });

  it('near-miss editor event names are dropped by the allowlist', async () => {
    const { pool, calls } = capturePool();
    await collect(ctx(pool), batch({
      records: [
        { event: 'draft_startedx', seq: 1 },
        { event: 'send_click', seq: 2 },
        { event: 'editor_reached', seq: 3 }, // a summary STEP name, not a browser event
      ],
    }));
    assert.equal(calls.length, 0);
  });

  it('signin_prompt accepts the send trigger; near-miss triggers still drop (AC-230)', async () => {
    const { pool, calls } = capturePool();
    await collect(ctx(pool), batch({
      page: '/dashboard/create',
      records: [
        { event: 'signin_prompt', element: 'send', seq: 1 },
        { event: 'signin_prompt', element: 'sendx', seq: 2 },
        { event: 'signin_prompt', element: 'SEND', seq: 3 },
      ],
    }));
    assert.equal(calls.length, 1);
    const vals = calls[0].values;
    assert.equal(vals.filter((v) => v === 'send').length, 1);
    assert.ok(!vals.includes('sendx'));
    assert.ok(!vals.includes('SEND'));
  });
});

describe('handleTelemetryCollect — fork default + config gate (AC-221/AC-214)', () => {
  it('ctx undefined (rail disabled — the fork default) → silent drop, ZERO queries', async () => {
    const { calls } = capturePool();
    await collect(undefined, batch());
    assert.equal(calls.length, 0);
  });

  it('enabled: a valid batch inserts rows with normalized page, derived bucket/country, server time', async () => {
    const { pool, calls } = capturePool();
    await collect(ctx(pool), batch(), { headers: new Headers({ 'cf-ipcountry': 'IL' }) });
    assert.equal(calls.length, 1);
    const v = calls[0].values;
    // Two records, EIGHT params each (0.60.0): occurred_at, event, page,
    // element, country, source, campaign, page_seq
    assert.equal(v.length, 16);
    assert.ok(v[0] instanceof Date);
    assert.equal(v[1], 'page_view');
    assert.equal(v[2], 'pricing');
    assert.equal(v[3], null);
    assert.equal(v[4], 'IL');
    assert.equal(v[5], 'referral');
    assert.equal(v[6], 'none');
    assert.equal(v[7], 1);
    assert.equal(v[9], 'click');
    assert.equal(v[11], 'cta_create:hero');
  });

  it('the derivation riders are DISCARDED — no referrer URL or click-id trace in any param (AC-218)', async () => {
    const { pool, calls } = capturePool();
    await collect(ctx(pool), batch({ ref: 'https://www.google.com/search?q=x', gclid: true }));
    const flat = JSON.stringify(calls[0].values);
    assert.ok(!flat.includes('google.com'), 'referrer leaked');
    assert.ok(!/gclid/i.test(flat), 'click-id trace leaked');
    // gclid presence → paid bucket, as a bucket only
    assert.equal(calls[0].values[5], 'paid');
  });

  it('the utm rider records the NORMALIZED campaign label on every record of the load (AC-218 0.60.0)', async () => {
    const { pool, calls } = capturePool();
    await collect(ctx(pool), batch({ utm: 'Summer_Launch' }));
    // 8 params/record now: occurred_at, event, page, element, country, source, campaign, page_seq
    assert.equal(calls[0].values[6], 'summer_launch');
    assert.equal(calls[0].values[14], 'summer_launch');
    const { pool: p2, calls: c2 } = capturePool();
    await collect(ctx(p2), batch()); // no utm rider
    assert.equal(c2[0].values[6], 'none');
    const { pool: p3, calls: c3 } = capturePool();
    await collect(ctx(p3), batch({ utm: 'evil value <script>' }));
    assert.equal(c3[0].values[6], 'other');
    assert.ok(!JSON.stringify(c3[0].values).includes('<script>'), 'raw utm leaked');
  });

  it('a raw signer-link page in the batch stores the known-set value only (AC-214)', async () => {
    const { pool, calls } = capturePool();
    await collect(ctx(pool), batch({ page: '/sign/7d0723ec-1111/tok_SECRET', records: [{ event: 'page_view', seq: 1 }] }));
    const flat = JSON.stringify(calls[0].values);
    assert.ok(!flat.includes('tok_SECRET') && !flat.includes('7d0723ec'), 'token/id leaked into a stored value');
    assert.equal(calls[0].values[2], 'sign');
  });
});

describe('handleTelemetryCollect — the validation door (AC-220)', () => {
  it('malformed bodies are dropped silently, never throw, zero inserts', async () => {
    const { pool, calls } = capturePool();
    for (const junk of [null, 'a string', 42, [], {}, { records: 'nope' }, { page: 7, records: [] }]) {
      await collect(ctx(pool), junk);
    }
    assert.equal(calls.length, 0);
  });

  it('unknown event names and SERVER-ONLY event names from the browser are dropped', async () => {
    const { pool, calls } = capturePool();
    await collect(
      ctx(pool),
      batch({
        records: [
          { event: 'made_up', seq: 1 },
          { event: 'send_ok', seq: 2 }, // server-recorded step — a browser may not fabricate it
          { event: 'session_created', seq: 3 },
          { event: 'page_view', seq: 4 },
        ],
      }),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].values.length, 8); // only page_view survived
    assert.equal(calls[0].values[1], 'page_view');
  });

  it('click elements must match the registry grammar; junk and oversized elements drop', async () => {
    const { pool, calls } = capturePool();
    await collect(
      ctx(pool),
      batch({
        records: [
          { event: 'click', element: 'cta_create:hero', seq: 1 }, // named ok
          { event: 'click', element: 'other:faq', seq: 2 }, // catch-all with allowlisted dest ok
          { event: 'click', element: 'other:external', seq: 3 }, // catch-all external ok
          { event: 'click', element: 'other:https://evil.example/x', seq: 4 }, // raw URL dest — drop
          { event: 'click', element: 'cta_create:wat', seq: 5 }, // unknown location — drop
          { event: 'click', element: 'x'.repeat(300), seq: 6 }, // oversized — drop
          { event: 'click', seq: 7 }, // click without element — drop
          { event: 'scroll', element: '50', seq: 8 }, // scroll threshold ok
          { event: 'scroll', element: '33', seq: 9 }, // not a threshold — drop
          { event: 'signin_prompt', element: 'redirect', seq: 10 }, // ok
        ],
      }),
    );
    const v = calls[0].values;
    const elements = [v[3], v[11], v[19], v[27], v[35]];
    assert.equal(v.length, 40); // 5 surviving records × 8
    assert.deepEqual(elements, ['cta_create:hero', 'other:faq', 'other:external', '50', 'redirect']);
  });

  it('per-page caps: overflow records and out-of-range seq drop', async () => {
    const { pool, calls } = capturePool();
    const many = Array.from({ length: 80 }, (_, i) => ({ event: 'page_view', seq: i + 1 }));
    await collect(ctx(pool), batch({ records: many }));
    assert.equal(calls[0].values.length / 8 <= TELEMETRY_MAX_RECORDS_PER_POST, true);
    const { pool: p2, calls: c2 } = capturePool();
    await collect(ctx(p2), batch({ records: [{ event: 'page_view', seq: 5000 }] }));
    assert.equal(c2.length, 0, 'a seq past the per-page-load cap must drop');
  });

  it('an insert failure is swallowed — the visitor never sees an error', async () => {
    const pool: DbPool = {
      async query() {
        throw new Error('db down');
      },
      async end() {},
    };
    await assert.doesNotReject(() => collect(ctx(pool), batch()));
  });
});

describe('handleTelemetryCollect — per-source rate limit (AC-220)', () => {
  it('a flood from one source stops inserting; another source keeps recording', async () => {
    const { pool, calls } = capturePool();
    const c = ctx(pool);
    for (let i = 0; i < 60; i++) {
      await collect(c, batch({ records: [{ event: 'page_view', seq: 1 }] }), { sourceAddr: '203.0.113.66' });
    }
    const floodInserts = calls.length;
    assert.ok(floodInserts < 60, `flood must be limited (got ${floodInserts} inserts)`);
    const before = calls.length;
    await collect(c, batch({ records: [{ event: 'page_view', seq: 1 }] }), { sourceAddr: '198.51.100.9' });
    assert.equal(calls.length, before + 1, 'an unrelated source must be unaffected');
  });

  it('the address is used in memory only — it never appears in any SQL param', async () => {
    const { pool, calls } = capturePool();
    await collect(ctx(pool), batch(), { sourceAddr: '203.0.113.99' });
    assert.ok(!JSON.stringify(calls.flatMap((c) => c.values)).includes('203.0.113.99'));
  });
});
