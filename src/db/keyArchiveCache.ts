/**
 * keyArchiveCache — F-10.8a (spec 0.77.0, #102, plan DD-84): the memory behind the
 * key-archive proxy (`src/api/keyArchiveProxy.ts`), and ONLY behind it. The
 * operator's signing-time checks call `lookupArchivedKey` directly and never import
 * this module (F-10.8a: "Only the web verifier's proxy remembers").
 *
 * One row per public `(domain, selector)`: the archive's answer for a FOUND key,
 * serialized once as text (so a remembered answer comes back byte-identical), when
 * it was fetched, and when it was last looked up. Public DNS facts only: nothing
 * about a bundle or a visitor.
 *
 * Two implementations of one interface: the SQL store (production) and an
 * in-memory store (tests, and a fork run without a database). Both forget the same
 * way: a pair idle KEY_ARCHIVE_IDLE_MS is dropped, then, while the set is over the
 * operator maximum, the pair looked up longest ago is dropped first.
 */
import type { DbPool } from './pool.js';

/** A pair nobody looks up for 7 days is forgotten (F-10.8a). */
export const KEY_ARCHIVE_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** A found answer is served from memory for at most 24 hours after it was fetched. */
export const KEY_ARCHIVE_FRESH_MS = 24 * 60 * 60 * 1000;
/** The operator maximum when `KYSIGNED_KEY_ARCHIVE_CACHE_MAX` is unset or unusable. */
export const DEFAULT_KEY_ARCHIVE_CACHE_MAX = 10000;

export interface RememberedAnswer {
  /** The archive's records, serialized exactly once at fetch time. */
  records: string;
  fetchedAt: Date;
}

export interface KeyArchiveStore {
  /** Read a remembered answer and record this lookup's time, in one step. Null = miss. */
  hit(domain: string, selector: string, now: Date): Promise<RememberedAnswer | null>;
  /** Remember a found answer (insert or replace), fetched and looked up `now`. */
  put(domain: string, selector: string, records: string, now: Date): Promise<void>;
  /** Forget a pair (a fresh lookup the archive answered "no record"). */
  remove(domain: string, selector: string): Promise<void>;
  /** Drop pairs idle 7 days, then the oldest-looked-up beyond `max`. */
  prune(now: Date, max: number): Promise<void>;
}

/** The operator maximum: a positive whole number, else the default. */
export function resolveKeyArchiveCacheMax(raw: string | undefined): number {
  const n = Number((raw ?? '').trim());
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n > 0 ? n : DEFAULT_KEY_ARCHIVE_CACHE_MAX;
}

function toDate(v: unknown): Date | null {
  if (typeof v !== 'string' && !(v instanceof Date)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function createSqlKeyArchiveStore(pool: DbPool): KeyArchiveStore {
  return {
    async hit(domain, selector, now) {
      const res = await pool.query(
        `UPDATE key_archive_cache
            SET last_hit_at = $3
          WHERE domain = $1 AND selector = $2
          RETURNING records, fetched_at`,
        [domain, selector, now.toISOString()],
      );
      const row = res.rows[0] as { records?: unknown; fetched_at?: unknown } | undefined;
      const fetchedAt = toDate(row?.fetched_at);
      // An unreadable row is a miss: the proxy then asks the archive and replaces it.
      if (!row || typeof row.records !== 'string' || !fetchedAt) return null;
      return { records: row.records, fetchedAt };
    },
    async put(domain, selector, records, now) {
      await pool.query(
        `INSERT INTO key_archive_cache (domain, selector, records, fetched_at, last_hit_at)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (domain, selector) DO UPDATE
            SET records = EXCLUDED.records,
                fetched_at = EXCLUDED.fetched_at,
                last_hit_at = EXCLUDED.last_hit_at`,
        [domain, selector, records, now.toISOString()],
      );
    },
    async remove(domain, selector) {
      await pool.query(`DELETE FROM key_archive_cache WHERE domain = $1 AND selector = $2`, [domain, selector]);
    },
    async prune(now, max) {
      await pool.query(`DELETE FROM key_archive_cache WHERE last_hit_at < $1`, [
        new Date(now.getTime() - KEY_ARCHIVE_IDLE_MS).toISOString(),
      ]);
      await pool.query(
        `DELETE FROM key_archive_cache
          WHERE (domain, selector) IN (
            SELECT domain, selector FROM key_archive_cache
             ORDER BY last_hit_at DESC
             OFFSET $1
          )`,
        [max],
      );
    },
  };
}

interface MemoryRow {
  records: string;
  fetchedAt: Date;
  lastHitAt: Date;
}

/** The same interface over a Map; `peek` lets tests read a row without touching it. */
export function createMemoryKeyArchiveStore(): KeyArchiveStore & {
  peek(domain: string, selector: string): MemoryRow | undefined;
} {
  const rows = new Map<string, MemoryRow>();
  const key = (d: string, s: string) => `${d}\u0000${s}`;
  return {
    peek: (d, s) => rows.get(key(d, s)),
    async hit(d, s, now) {
      const r = rows.get(key(d, s));
      if (!r) return null;
      r.lastHitAt = now;
      return { records: r.records, fetchedAt: r.fetchedAt };
    },
    async put(d, s, records, now) {
      rows.set(key(d, s), { records, fetchedAt: now, lastHitAt: now });
    },
    async remove(d, s) {
      rows.delete(key(d, s));
    },
    async prune(now, max) {
      const cutoff = now.getTime() - KEY_ARCHIVE_IDLE_MS;
      for (const [k, r] of rows) if (r.lastHitAt.getTime() < cutoff) rows.delete(k);
      const byRecency = [...rows.entries()].sort((a, b) => b[1].lastHitAt.getTime() - a[1].lastHitAt.getTime());
      for (const [k] of byRecency.slice(max)) rows.delete(k);
    },
  };
}
