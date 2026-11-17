/**
 * keyArchiveCache.test.ts — F-10.8a (#102, DD-84): the store behind the key-archive
 * proxy's memory. Two implementations of ONE interface:
 *   - the SQL store (production), checked here by the statements it sends;
 *   - the in-memory store (tests and forks without a database), checked by behavior.
 * Both implement the same two forgetting rules: a pair idle 7 days is gone, and with
 * the set full the pair looked up longest ago is dropped first.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DbPool } from './pool.js';
import {
  createSqlKeyArchiveStore,
  createMemoryKeyArchiveStore,
  resolveKeyArchiveCacheMax,
  KEY_ARCHIVE_IDLE_MS,
  DEFAULT_KEY_ARCHIVE_CACHE_MAX,
} from './keyArchiveCache.js';

const T0 = new Date('2026-11-18T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const DAY = 24 * 60 * 60 * 1000;
const RECORDS = '[{"domain":"gmail.com","selector":"s1","value":"v=DKIM1; p=AAA"}]';

function capturePool(handler: (text: string, values: unknown[]) => { rows: unknown[]; rowCount: number } | null) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as unknown[];
      queries.push({ text, values: v });
      return (handler(text, v) ?? { rows: [], rowCount: 0 }) as never;
    },
    async end() {},
  };
  return { pool, queries };
}

describe('the SQL store (DD-84)', () => {
  it('a hit is ONE statement that reads and touches together, and returns the stored text unchanged', async () => {
    const { pool, queries } = capturePool(() => ({
      rows: [{ records: RECORDS, fetched_at: T0.toISOString(), last_hit_at: at(DAY).toISOString() }],
      rowCount: 1,
    }));
    const store = createSqlKeyArchiveStore(pool);
    const got = await store.hit('gmail.com', 's1', at(DAY));
    assert.equal(queries.length, 1, 'one round trip for a hit');
    assert.match(queries[0]!.text, /UPDATE key_archive_cache\s+SET last_hit_at/);
    assert.match(queries[0]!.text, /RETURNING/);
    assert.deepEqual(queries[0]!.values, ['gmail.com', 's1', at(DAY).toISOString()]);
    assert.equal(got?.records, RECORDS, 'byte-identical text back');
    assert.equal(got?.fetchedAt.toISOString(), T0.toISOString());
  });

  it('a hit on nothing, or on a row it cannot read, is a miss', async () => {
    const none = createSqlKeyArchiveStore(capturePool(() => ({ rows: [], rowCount: 0 })).pool);
    assert.equal(await none.hit('gmail.com', 's1', T0), null);
    const bad = createSqlKeyArchiveStore(
      capturePool(() => ({ rows: [{ records: 42, fetched_at: 'not a date' }], rowCount: 1 })).pool,
    );
    assert.equal(await bad.hit('gmail.com', 's1', T0), null);
  });

  it('put is an upsert that sets the answer and both times', async () => {
    const { pool, queries } = capturePool(() => ({ rows: [], rowCount: 1 }));
    await createSqlKeyArchiveStore(pool).put('gmail.com', 's1', RECORDS, T0);
    assert.match(queries[0]!.text, /INSERT INTO key_archive_cache/);
    assert.match(queries[0]!.text, /ON CONFLICT \(domain, selector\) DO UPDATE/);
    assert.deepEqual(queries[0]!.values, ['gmail.com', 's1', RECORDS, T0.toISOString()]);
  });

  it('remove deletes the pair', async () => {
    const { pool, queries } = capturePool(() => ({ rows: [], rowCount: 1 }));
    await createSqlKeyArchiveStore(pool).remove('gmail.com', 's1');
    assert.match(queries[0]!.text, /DELETE FROM key_archive_cache WHERE domain = \$1 AND selector = \$2/);
  });

  it('prune drops pairs idle 7 days, then the oldest-looked-up beyond the maximum', async () => {
    const { pool, queries } = capturePool(() => ({ rows: [], rowCount: 0 }));
    await createSqlKeyArchiveStore(pool).prune(at(10 * DAY), 500);
    assert.equal(queries.length, 2);
    assert.match(queries[0]!.text, /DELETE FROM key_archive_cache WHERE last_hit_at < \$1/);
    assert.equal(queries[0]!.values[0], at(10 * DAY - KEY_ARCHIVE_IDLE_MS).toISOString());
    assert.match(queries[1]!.text, /ORDER BY last_hit_at DESC/);
    assert.match(queries[1]!.text, /OFFSET \$1/);
    assert.deepEqual(queries[1]!.values, [500]);
  });
});

describe('the in-memory store (same interface, same two forgetting rules)', () => {
  it('stores, hits (moving only last_hit_at), and removes', async () => {
    const s = createMemoryKeyArchiveStore();
    await s.put('gmail.com', 's1', RECORDS, T0);
    const h = await s.hit('gmail.com', 's1', at(DAY));
    assert.equal(h?.records, RECORDS);
    assert.equal(h?.fetchedAt.toISOString(), T0.toISOString(), 'a hit never moves fetched_at');
    assert.equal(s.peek('gmail.com', 's1')?.lastHitAt.toISOString(), at(DAY).toISOString(), 'a hit moves last_hit_at');
    await s.remove('gmail.com', 's1');
    assert.equal(await s.hit('gmail.com', 's1', at(DAY)), null);
  });

  it('a pair idle 7 days is gone after a prune; one used inside 7 days stays', async () => {
    const s = createMemoryKeyArchiveStore();
    await s.put('a.com', 's', RECORDS, T0);
    await s.put('b.com', 's', RECORDS, T0);
    await s.hit('b.com', 's', at(5 * DAY));
    await s.prune(at(8 * DAY), 100);
    assert.equal(s.peek('a.com', 's'), undefined, 'idle 8 days: forgotten');
    assert.ok(s.peek('b.com', 's'), 'looked up 3 days ago: kept');
  });

  it('with the set full, the pair looked up longest ago is dropped first', async () => {
    const s = createMemoryKeyArchiveStore();
    await s.put('old.com', 's', RECORDS, at(0));
    await s.put('mid.com', 's', RECORDS, at(1000));
    await s.put('new.com', 's', RECORDS, at(2000));
    await s.prune(at(3000), 2);
    assert.equal(s.peek('old.com', 's'), undefined);
    assert.ok(s.peek('mid.com', 's'));
    assert.ok(s.peek('new.com', 's'));
  });
});

describe('the operator maximum (KYSIGNED_KEY_ARCHIVE_CACHE_MAX)', () => {
  it('a positive whole number is used; anything else falls back to the default', () => {
    assert.equal(DEFAULT_KEY_ARCHIVE_CACHE_MAX, 10000);
    assert.equal(resolveKeyArchiveCacheMax('2500'), 2500);
    for (const bad of [undefined, '', '0', '-5', 'abc', '1.5']) {
      assert.equal(resolveKeyArchiveCacheMax(bad), DEFAULT_KEY_ARCHIVE_CACHE_MAX, String(bad));
    }
  });
});
