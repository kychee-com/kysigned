/**
 * Key-archive lookup proxy (F-10.8 / AC-104) — the operator forwards the web
 * verifier's PUBLIC `(domain, selector)` DKIM-key lookup to archive.prove.email
 * server-side (the archive serves no CORS headers, so the browser can't call it
 * cross-origin). It returns the archive's records ARRAY (same shape the archive
 * returns) so the same-origin web verifier parses it identically; forwards ONLY
 * `(domain, selector)` (public DNS facts); never touches the bundle/file.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleKeyArchiveLookup } from './keyArchiveProxy.js';

function fakeFetch(handler: (url: string) => { status: number; body?: unknown }) {
  return (async (url: string) => {
    const { status, body } = handler(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as unknown as typeof fetch;
}

const RECORD = { domain: 'kysigned.com', selector: 'sel', value: 'p=ABCKEY', firstSeenAt: '2026-06-29T11:42:02.820Z' };

describe('handleKeyArchiveLookup — operator key-archive proxy (F-10.8 / AC-104)', () => {
  it('forwards (domain, selector) to the archive and returns its records array', async () => {
    const archive = {
      fetchFn: fakeFetch((url) => {
        assert.match(url, /\/api\/key\/domain\?/);
        assert.match(url, /domain=kysigned\.com/);
        assert.match(url, /selector=sel/);
        return { status: 200, body: [RECORD] };
      }),
    };
    const r = await handleKeyArchiveLookup({ archive }, 'kysigned.com', 'sel');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body), 'body is the records array');
    assert.equal((r.body as typeof RECORD[])[0].value, 'p=ABCKEY');
  });

  it('200 + empty array for an absent key (archive 404) — the web treats it as pending', async () => {
    const archive = { fetchFn: fakeFetch(() => ({ status: 404 })) };
    const r = await handleKeyArchiveLookup({ archive }, 'absent.com', 'sel');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  });

  it('400 when domain or selector is missing', async () => {
    assert.equal((await handleKeyArchiveLookup({}, null, 'sel')).status, 400);
    assert.equal((await handleKeyArchiveLookup({}, 'kysigned.com', '')).status, 400);
  });

  it('400 on a malformed domain or selector (defense-in-depth)', async () => {
    assert.equal((await handleKeyArchiveLookup({}, 'bad domain!', 'sel')).status, 400);
    assert.equal((await handleKeyArchiveLookup({}, 'kysigned.com', 'bad selector!')).status, 400);
  });

  it('502 when the archive errors (the web verifier treats it as pending)', async () => {
    const archive = { fetchFn: fakeFetch(() => ({ status: 503 })) };
    const r = await handleKeyArchiveLookup({ archive }, 'x.com', 'sel');
    assert.equal(r.status, 502);
  });
});

// ── F-10.8a (spec 0.77.0, #102): the proxy remembers recent answers ─────────────
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryKeyArchiveStore, type KeyArchiveStore } from '../db/keyArchiveCache.js';

describe('F-10.8a — the proxy remembers recent answers (AC-307, AC-308, AC-310)', () => {
  const T0 = new Date('2026-11-18T00:00:00.000Z');
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const R1 = { domain: 'gmail.com', selector: 's1', value: 'p=KEYONE', firstSeenAt: '2026-01-01T00:00:00.000Z' };
  const R2 = { domain: 'gmail.com', selector: 's1', value: 'p=KEYTWO', firstSeenAt: '2026-11-01T00:00:00.000Z' };

  function rig(opts: { max?: number } = {}) {
    const store = createMemoryKeyArchiveStore();
    let now = T0;
    let calls = 0;
    let answer: { status: number; body?: unknown } = { status: 200, body: [R1] };
    const deps = {
      archive: { fetchFn: fakeFetch(() => { calls++; return answer; }) },
      cache: { store, now: () => now, max: opts.max ?? 100 },
    };
    return {
      store,
      deps,
      calls: () => calls,
      setNow: (ms: number) => { now = new Date(T0.getTime() + ms); },
      setAnswer: (a: { status: number; body?: unknown }) => { answer = a; },
      lookup: (d = 'gmail.com', s = 's1', fresh = false) => handleKeyArchiveLookup(deps, d, s, { fresh }),
    };
  }

  it('F-10.8a memory: found answers only, 24 hour refetch, forgotten after 7 idle days or when full, only the public answer stored', async () => {
    const r = rig({ max: 2 });
    // A found answer is fetched once, then served from memory inside 24 hours.
    const first = await r.lookup();
    assert.equal(r.calls(), 1);
    r.setNow(23 * HOUR);
    const second = await r.lookup();
    assert.equal(r.calls(), 1, 'a second lookup inside 24 h makes no archive call');
    assert.equal(JSON.stringify(second.body), JSON.stringify(first.body), 'identical answers');
    // A hit records the lookup time; fetched_at does not move.
    assert.equal(r.store.peek('gmail.com', 's1')?.lastHitAt.getTime(), T0.getTime() + 23 * HOUR);
    assert.equal(r.store.peek('gmail.com', 's1')?.fetchedAt.getTime(), T0.getTime());
    // After 24 hours it asks the archive again and the fresh answer replaces the old one.
    r.setNow(25 * HOUR);
    r.setAnswer({ status: 200, body: [R1, R2] });
    const third = await r.lookup();
    assert.equal(r.calls(), 2);
    assert.equal((third.body as unknown[]).length, 2);
    assert.equal(r.store.peek('gmail.com', 's1')?.fetchedAt.getTime(), T0.getTime() + 25 * HOUR);
    // A stored entry holds only domain, selector, the archive's records and the two times.
    assert.deepEqual(Object.keys(r.store.peek('gmail.com', 's1')!).sort(), ['fetchedAt', 'lastHitAt', 'records']);
    assert.deepEqual(JSON.parse(r.store.peek('gmail.com', 's1')!.records), [R1, R2]);
    // An absent or failed lookup stores nothing.
    r.setAnswer({ status: 404 });
    await r.lookup('absent.com', 'x');
    assert.equal(r.store.peek('absent.com', 'x'), undefined);
    r.setAnswer({ status: 500 });
    await r.lookup('down.com', 'x');
    assert.equal(r.store.peek('down.com', 'x'), undefined);
    // fresh=1 skips the memory and replaces it; a fresh absent answer removes the row; a fresh failure leaves it.
    r.setAnswer({ status: 200, body: [R2] });
    const before = r.calls();
    await r.lookup('gmail.com', 's1', true);
    assert.equal(r.calls(), before + 1, 'fresh always asks the archive');
    assert.deepEqual(JSON.parse(r.store.peek('gmail.com', 's1')!.records), [R2]);
    r.setAnswer({ status: 500 });
    await r.lookup('gmail.com', 's1', true);
    assert.ok(r.store.peek('gmail.com', 's1'), 'a fresh failure leaves the row');
    r.setAnswer({ status: 404 });
    await r.lookup('gmail.com', 's1', true);
    assert.equal(r.store.peek('gmail.com', 's1'), undefined, 'a fresh "no record" removes it');
    // After storing a new found answer the proxy prunes: idle 7 days is gone; full drops the oldest-looked-up.
    r.setAnswer({ status: 200, body: [R1] });
    r.setNow(30 * DAY); await r.lookup('a.com', 's');
    r.setNow(30 * DAY + HOUR); await r.lookup('b.com', 's');
    r.setNow(30 * DAY + 2 * HOUR); await r.lookup('c.com', 's');
    assert.equal(r.store.peek('a.com', 's'), undefined, 'max 2: the pair looked up longest ago went first');
    assert.ok(r.store.peek('b.com', 's') && r.store.peek('c.com', 's'));
    r.setNow(40 * DAY); await r.lookup('d.com', 's');
    assert.equal(r.store.peek('b.com', 's'), undefined, 'idle more than 7 days: forgotten');
    assert.equal(r.store.peek('c.com', 's'), undefined, 'idle more than 7 days: forgotten');
    // The signing-time paths never import the store: only the proxy (and its wiring) does.
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f) && /keyArchiveCache/.test(readFileSync(p, 'utf8'))) importers.push(p);
      }
    };
    walk(join(process.cwd(), 'src'));
    assert.deepEqual(
      importers.map((p) => p.split('/src/')[1]).sort(),
      ['api/keyArchiveProxy.ts', 'db/keyArchiveCache.ts', 'functions/api.ts', 'functions/config.ts'],
    );
  });

  it('F-10.8a outage: served from memory inside 24 hours, failure after', async () => {
    const r = rig();
    await r.lookup();
    r.setAnswer({ status: 503 });
    // Fetched under 24 h ago: answered from memory, and no archive call is made.
    r.setNow(20 * HOUR);
    const callsBefore = r.calls();
    const mem = await r.lookup();
    assert.equal(mem.status, 200);
    assert.deepEqual(mem.body, [R1]);
    assert.equal(r.calls(), callsBefore);
    // A FRESH lookup gets the failure whatever is remembered.
    const fresh = await r.lookup('gmail.com', 's1', true);
    assert.equal(fresh.status, 502);
    // Fetched over 24 h ago: the failure, never the old answer.
    r.setNow(25 * HOUR);
    const stale = await r.lookup();
    assert.equal(stale.status, 502);
  });

  it('store errors never fail a lookup', async () => {
    const broken = (fail: 'hit' | 'put' | 'prune'): KeyArchiveStore => {
      const m = createMemoryKeyArchiveStore();
      return {
        hit: fail === 'hit' ? async () => { throw new Error('db down'); } : m.hit,
        put: fail === 'put' ? async () => { throw new Error('db down'); } : m.put,
        remove: m.remove,
        prune: fail === 'prune' ? async () => { throw new Error('db down'); } : m.prune,
      };
    };
    for (const fail of ['hit', 'put', 'prune'] as const) {
      const deps = {
        archive: { fetchFn: fakeFetch(() => ({ status: 200, body: [R1] })) },
        cache: { store: broken(fail), now: () => T0, max: 10 },
      };
      const res = await handleKeyArchiveLookup(deps, 'gmail.com', 's1');
      assert.equal(res.status, 200, `${fail} failing still answers`);
      assert.deepEqual(res.body, [R1]);
    }
  });

  it('without a store (a fork that wires none) the proxy behaves exactly as before', async () => {
    let calls = 0;
    const deps = { archive: { fetchFn: fakeFetch(() => { calls++; return { status: 200, body: [R1] }; }) } };
    await handleKeyArchiveLookup(deps, 'gmail.com', 's1');
    await handleKeyArchiveLookup(deps, 'gmail.com', 's1');
    assert.equal(calls, 2);
  });
});
