/**
 * attributionCapture.test.ts — F-37 pending capture + bind-once (AC-206).
 *
 * The server half of the attribution rail: the magic-link request carries the
 * browser's capture, `recordAttributionCapture` persists it keyed by the
 * NORMALIZED inbox (F-3.2a), and `bindAttributionIfPending` stamps the account
 * exactly once at establishment — earliest unexpired capture wins, organic
 * stays organic forever, nothing is ever overwritten.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DbPool } from '../db/pool.js';
import {
  parseAttributionSubmission,
  recordAttributionCapture,
  bindAttributionIfPending,
  getCreatorAttribution,
  ATTRIBUTION_WINDOW_MS,
} from './attributionCapture.js';

const NOW = new Date('2026-07-19T12:00:00.000Z');
const FRESH_AT = '2026-07-18T09:30:00.000Z';

describe('parseAttributionSubmission', () => {
  it('accepts a full submission and keeps the recorded consent', () => {
    const parsed = parseAttributionSubmission(
      { gclid: 'Cj0Kabc-123_x', captured_at: FRESH_AT, consent: 'granted' },
      NOW,
    );
    assert.deepEqual(parsed, {
      gclid: 'Cj0Kabc-123_x',
      capturedAt: new Date(FRESH_AT),
      consent: 'granted',
    });
  });

  it('maps missing/garbage consent to null (never fabricated)', () => {
    assert.equal(parseAttributionSubmission({ gclid: 'Cj0K', captured_at: FRESH_AT }, NOW)?.consent, null);
    assert.equal(
      parseAttributionSubmission({ gclid: 'Cj0K', captured_at: FRESH_AT, consent: 'GRANTED!!' }, NOW)?.consent,
      null,
    );
    assert.equal(
      parseAttributionSubmission({ gclid: 'Cj0K', captured_at: FRESH_AT, consent: 'denied' }, NOW)?.consent,
      'denied',
    );
  });

  it('rejects malformed shapes without throwing (bad gclid / bad date / non-object)', () => {
    assert.equal(parseAttributionSubmission(null, NOW), null);
    assert.equal(parseAttributionSubmission('gclid=x', NOW), null);
    assert.equal(parseAttributionSubmission({ gclid: 'has space', captured_at: FRESH_AT }, NOW), null);
    assert.equal(parseAttributionSubmission({ gclid: 'x'.repeat(600), captured_at: FRESH_AT }, NOW), null);
    assert.equal(parseAttributionSubmission({ gclid: 'Cj0K', captured_at: 'not-a-date' }, NOW), null);
    assert.equal(parseAttributionSubmission({ gclid: 'Cj0K' }, NOW), null);
  });

  it('rejects a capture already outside the 90-day window (dead on arrival) or far-future', () => {
    const expired = new Date(NOW.getTime() - ATTRIBUTION_WINDOW_MS - 1000).toISOString();
    const farFuture = new Date(NOW.getTime() + 48 * 3600 * 1000).toISOString();
    assert.equal(parseAttributionSubmission({ gclid: 'Cj0K', captured_at: expired }, NOW), null);
    assert.equal(parseAttributionSubmission({ gclid: 'Cj0K', captured_at: farFuture }, NOW), null);
  });
});

interface Captured {
  text: string;
  values: unknown[];
}

function capturePool(handlers: (text: string, values: unknown[]) => { rows: unknown[]; rowCount: number } | null) {
  const queries: Captured[] = [];
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as unknown[];
      queries.push({ text, values: v });
      return (handlers(text, v) ?? { rows: [], rowCount: 0 }) as never;
    },
    async end() {},
  };
  return { pool, queries };
}

describe('recordAttributionCapture', () => {
  it('inserts keyed by the NORMALIZED inbox with conflict-tolerant dedupe', async () => {
    const { pool, queries } = capturePool(() => null);
    await recordAttributionCapture(pool, 'Alice.Smith+promo@GoogleMail.com', {
      gclid: 'Cj0Kpending',
      capturedAt: new Date(FRESH_AT),
      consent: 'granted',
    });
    const insert = queries.find((q) => q.text.includes('INSERT INTO attribution_captures'));
    assert.ok(insert, 'wrote the pending capture');
    assert.match(insert!.text, /ON CONFLICT[\s\S]*DO NOTHING/);
    assert.equal(insert!.values[0], 'alicesmith@gmail.com', 'keyed by the F-3.2a normalized inbox');
    assert.equal(insert!.values[1], 'Cj0Kpending');
    assert.equal(insert!.values[3], 'granted');
  });
});

describe('bindAttributionIfPending — establishment stamp, once only', () => {
  function bindPool(opts: {
    pending?: { gclid: string; captured_at: string; consent_state: string | null } | null;
    stampInserted?: boolean;
  }) {
    return capturePool((text) => {
      if (text.includes('FROM attribution_captures') && text.includes('SELECT')) {
        return opts.pending
          ? { rows: [opts.pending], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (text.includes('INSERT INTO creator_attribution')) {
        return { rows: [], rowCount: opts.stampInserted === false ? 0 : 1 };
      }
      return null;
    });
  }

  it('binds the earliest unexpired pending capture and purges the pendings', async () => {
    const { pool, queries } = bindPool({
      pending: { gclid: 'Cj0Kfirst', captured_at: FRESH_AT, consent_state: 'granted' },
    });
    const r = await bindAttributionIfPending(pool, 'New.User@x.com', NOW);
    assert.deepEqual(r, {
      bound: true,
      attribution: { gclid: 'Cj0Kfirst', capturedAt: new Date(FRESH_AT), consent: 'granted' },
    });
    const select = queries.find((q) => q.text.includes('FROM attribution_captures') && q.text.includes('SELECT'));
    assert.ok(select, 'looked up pendings');
    assert.match(select!.text, /ORDER BY captured_at ASC/, 'earliest capture wins (first-touch)');
    assert.ok(
      (select!.values as unknown[]).some((v) => v instanceof Date && (v as Date).getTime() === NOW.getTime() - ATTRIBUTION_WINDOW_MS),
      'window floor parameter excludes >90d captures at bind time',
    );
    const stamp = queries.find((q) => q.text.includes('INSERT INTO creator_attribution'));
    assert.ok(stamp, 'stamped the establishment');
    assert.match(stamp!.text, /ON CONFLICT[\s\S]*DO NOTHING/, 'never overwrites an existing stamp');
    assert.equal(stamp!.values[1], 'Cj0Kfirst');
    const purge = queries.find((q) => q.text.includes('DELETE FROM attribution_captures'));
    assert.ok(purge, 'pending rows are single-purpose — purged at establishment');
  });

  it('no unexpired pending → stamps ORGANIC (null gclid) so a later click never rewrites it', async () => {
    const { pool, queries } = bindPool({ pending: null });
    const r = await bindAttributionIfPending(pool, 'organic@x.com', NOW);
    assert.deepEqual(r, { bound: false });
    const stamp = queries.find((q) => q.text.includes('INSERT INTO creator_attribution'));
    assert.ok(stamp, 'organic establishment is stamped too');
    assert.equal(stamp!.values[1], null, 'organic stamp carries NULL gclid');
    assert.ok(queries.some((q) => q.text.includes('DELETE FROM attribution_captures')), 'pendings purged');
  });

  it('an already-established account never re-binds (conflict → bound:false)', async () => {
    const { pool } = bindPool({
      pending: { gclid: 'Cj0Klater', captured_at: FRESH_AT, consent_state: null },
      stampInserted: false,
    });
    const r = await bindAttributionIfPending(pool, 'repeat@x.com', NOW);
    assert.deepEqual(r, { bound: false });
  });
});

describe('getCreatorAttribution', () => {
  it('returns the bound attribution, and null for organic/absent accounts', async () => {
    const withRow = capturePool((text) =>
      text.includes('FROM creator_attribution')
        ? { rows: [{ gclid: 'Cj0Kbound', captured_at: FRESH_AT, consent_state: null }], rowCount: 1 }
        : null,
    );
    assert.deepEqual(await getCreatorAttribution(withRow.pool, 'A@x.com'), {
      gclid: 'Cj0Kbound',
      capturedAt: new Date(FRESH_AT),
      consent: null,
    });

    const organic = capturePool((text) =>
      text.includes('FROM creator_attribution')
        ? { rows: [{ gclid: null, captured_at: null, consent_state: null }], rowCount: 1 }
        : null,
    );
    assert.equal(await getCreatorAttribution(organic.pool, 'B@x.com'), null);

    const absent = capturePool(() => null);
    assert.equal(await getCreatorAttribution(absent.pool, 'C@x.com'), null);
  });
});
