/**
 * allowed_senders DAO tests — from spec F2.8 (allowed_senders default-deny access control).
 *
 * Default-deny: senders may only create envelopes if their identity is on the allowlist.
 * Each entry has a per-month quota (NULL = unlimited).
 * Identity types: 'email' (a single address) or 'email_domain' (any email under a domain),
 * both stored lowercased.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAllowedSender,
  removeAllowedSender,
  listAllowedSenders,
  isAllowedSender,
  getMatchingAllowedSender,
  getMonthlyUsage,
  incrementMonthlyUsage,
} from './allowedSenders.js';
import type { DbPool } from './pool.js';

// In-memory pool that recognizes the allowed_senders / allowed_sender_usage SQL shapes.
function createInMemoryPool() {
  const allowed: any[] = [];
  const usage: any[] = []; // {identity_type, identity, period, count}

  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as any[];

      if (text.includes('INSERT INTO allowed_senders')) {
        // (identity_type, identity, quota_per_month, added_by, note)
        const existing = allowed.find(
          (a) => a.identity_type === v[0] && a.identity === v[1]
        );
        if (existing) {
          // ON CONFLICT DO UPDATE: refresh quota/note/added_by
          existing.quota_per_month = v[2];
          existing.added_by = v[3];
          existing.note = v[4];
          return { rows: [existing], rowCount: 1 } as any;
        }
        const row = {
          id: `as-${allowed.length + 1}`,
          identity_type: v[0],
          identity: v[1],
          quota_per_month: v[2],
          added_by: v[3],
          note: v[4],
          added_at: new Date(),
        };
        allowed.push(row);
        return { rows: [row], rowCount: 1 } as any;
      }

      if (text.includes('DELETE FROM allowed_senders')) {
        const idx = allowed.findIndex(
          (a) => a.identity_type === v[0] && a.identity === v[1]
        );
        if (idx >= 0) {
          const [removed] = allowed.splice(idx, 1);
          return { rows: [removed], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      }

      if (text.includes("identity_type = 'email_domain'")) {
        // getMatchingAllowedSender for email: exact email OR email_domain
        const email = v[0] as string;
        const domain = v[1] as string;
        const exact = allowed.find((a) => a.identity_type === 'email' && a.identity === email);
        if (exact) return { rows: [exact], rowCount: 1 } as any;
        const dom = allowed.find((a) => a.identity_type === 'email_domain' && a.identity === domain);
        return { rows: dom ? [dom] : [], rowCount: dom ? 1 : 0 } as any;
      }
      if (text.includes('SELECT * FROM allowed_senders WHERE identity_type')) {
        const row = allowed.find(
          (a) => a.identity_type === v[0] && a.identity === v[1]
        );
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } as any;
      }

      if (text.includes('SELECT * FROM allowed_senders')) {
        return { rows: [...allowed].sort((a, b) => a.identity.localeCompare(b.identity)) } as any;
      }

      if (text.includes('INSERT INTO allowed_sender_usage')) {
        // (identity_type, identity, period) ON CONFLICT increment count
        const existing = usage.find(
          (u) => u.identity_type === v[0] && u.identity === v[1] && u.period === v[2]
        );
        if (existing) {
          existing.count += 1;
          return { rows: [existing], rowCount: 1 } as any;
        }
        const row = { identity_type: v[0], identity: v[1], period: v[2], count: 1 };
        usage.push(row);
        return { rows: [row], rowCount: 1 } as any;
      }

      if (text.includes('FROM allowed_sender_usage')) {
        const row = usage.find(
          (u) => u.identity_type === v[0] && u.identity === v[1] && u.period === v[2]
        );
        return { rows: row ? [{ count: String(row.count) }] : [{ count: '0' }] } as any;
      }

      return { rows: [], rowCount: 0 } as any;
    },
    async end() {},
  };

  return { pool, allowed, usage };
}

describe('allowed_senders DAO — from spec F2.8', () => {
  describe('addAllowedSender', () => {
    it('adds an email identity with quota (normalized lowercase)', async () => {
      const { pool } = createInMemoryPool();
      const row = await addAllowedSender(pool, {
        identity_type: 'email',
        identity: 'Sender@Example.com',
        quota_per_month: 100,
        added_by: 'admin@kychee.com',
        note: 'Test sender',
      });
      assert.equal(row.identity_type, 'email');
      assert.equal(row.identity, 'sender@example.com'); // normalized lowercase
      assert.equal(row.quota_per_month, 100);
      assert.equal(row.added_by, 'admin@kychee.com');
      assert.equal(row.note, 'Test sender');
    });

    it('adds an email identity with NULL quota (unlimited)', async () => {
      const { pool } = createInMemoryPool();
      const row = await addAllowedSender(pool, {
        identity_type: 'email',
        identity: 'Alice@Test.com',
        quota_per_month: null,
        added_by: 'admin',
      });
      assert.equal(row.identity_type, 'email');
      assert.equal(row.identity, 'alice@test.com');
      assert.equal(row.quota_per_month, null);
    });

    it('upserts on duplicate (refresh quota)', async () => {
      const { pool, allowed } = createInMemoryPool();
      await addAllowedSender(pool, {
        identity_type: 'email', identity: 'dup@t.com', quota_per_month: 10, added_by: 'a',
      });
      await addAllowedSender(pool, {
        identity_type: 'email', identity: 'dup@t.com', quota_per_month: 50, added_by: 'b',
      });
      assert.equal(allowed.length, 1);
      assert.equal(allowed[0].quota_per_month, 50);
    });
  });

  describe('removeAllowedSender', () => {
    it('removes an existing entry', async () => {
      const { pool } = createInMemoryPool();
      await addAllowedSender(pool, {
        identity_type: 'email', identity: 'one@t.com', quota_per_month: 10, added_by: 'a',
      });
      const removed = await removeAllowedSender(pool, 'email', 'one@t.com');
      assert.equal(removed, true);
      const ok = await isAllowedSender(pool, 'email', 'one@t.com');
      assert.equal(ok, false);
    });

    it('returns false for non-existent entry', async () => {
      const { pool } = createInMemoryPool();
      const removed = await removeAllowedSender(pool, 'email', 'missing@t.com');
      assert.equal(removed, false);
    });

    it('normalizes identity on remove', async () => {
      const { pool } = createInMemoryPool();
      await addAllowedSender(pool, {
        identity_type: 'email', identity: 'a@t.com', quota_per_month: null, added_by: 'a',
      });
      const removed = await removeAllowedSender(pool, 'email', 'A@T.com');
      assert.equal(removed, true);
    });
  });

  describe('listAllowedSenders', () => {
    it('returns all senders', async () => {
      const { pool } = createInMemoryPool();
      await addAllowedSender(pool, { identity_type: 'email', identity: 'b@t.com', quota_per_month: 1, added_by: 'a' });
      await addAllowedSender(pool, { identity_type: 'email', identity: 'a@t.com', quota_per_month: 2, added_by: 'a' });
      const list = await listAllowedSenders(pool);
      assert.equal(list.length, 2);
    });

    it('returns empty array when none exist', async () => {
      const { pool } = createInMemoryPool();
      const list = await listAllowedSenders(pool);
      assert.deepEqual(list, []);
    });
  });

  describe('email_domain identity_type', () => {
    it('allows any email under an allowlisted domain', async () => {
      const { pool } = createInMemoryPool();
      await addAllowedSender(pool, {
        identity_type: 'email_domain', identity: 'Kychee.com', quota_per_month: null, added_by: 'admin',
      });
      assert.equal(await isAllowedSender(pool, 'email', 'alice@kychee.com'), true);
      assert.equal(await isAllowedSender(pool, 'email', 'BOB@Kychee.COM'), true);
    });

    it('does not match other domains', async () => {
      const { pool } = createInMemoryPool();
      await addAllowedSender(pool, {
        identity_type: 'email_domain', identity: 'kychee.com', quota_per_month: null, added_by: 'admin',
      });
      assert.equal(await isAllowedSender(pool, 'email', 'eve@evil.com'), false);
      // Subdomains do NOT match (explicit allowlist policy — admin must add subdomains)
      assert.equal(await isAllowedSender(pool, 'email', 'eve@sub.kychee.com'), false);
    });

    it('exact email entry takes precedence over domain match for quota', async () => {
      const { pool } = createInMemoryPool();
      await addAllowedSender(pool, {
        identity_type: 'email_domain', identity: 'kychee.com', quota_per_month: 1000, added_by: 'admin',
      });
      await addAllowedSender(pool, {
        identity_type: 'email', identity: 'alice@kychee.com', quota_per_month: 5, added_by: 'admin',
      });
      // Both match; getMatchingAllowedSender should prefer exact email entry
      const match = await getMatchingAllowedSender(pool, 'email', 'alice@kychee.com');
      assert.equal(match!.identity_type, 'email');
      assert.equal(match!.quota_per_month, 5);
    });

    it('falls back to domain when no exact email entry exists', async () => {
      const { pool } = createInMemoryPool();
      await addAllowedSender(pool, {
        identity_type: 'email_domain', identity: 'kychee.com', quota_per_month: 1000, added_by: 'admin',
      });
      const match = await getMatchingAllowedSender(pool, 'email', 'newhire@kychee.com');
      assert.equal(match!.identity_type, 'email_domain');
      assert.equal(match!.identity, 'kychee.com');
    });

    it('rejects email_domain entries with @ in them', async () => {
      const { pool } = createInMemoryPool();
      // The DAO should normalize/validate — domain is stored bare (no @, no leading .)
      const row = await addAllowedSender(pool, {
        identity_type: 'email_domain', identity: '@kychee.com', quota_per_month: null, added_by: 'admin',
      });
      assert.equal(row.identity, 'kychee.com');
    });
  });

  describe('isAllowedSender', () => {
    it('returns true for an allowlisted identity (case-insensitive)', async () => {
      const { pool } = createInMemoryPool();
      await addAllowedSender(pool, {
        identity_type: 'email', identity: 'ABCDEF@t.com', quota_per_month: null, added_by: 'a',
      });
      assert.equal(await isAllowedSender(pool, 'email', 'abcdef@t.com'), true);
      assert.equal(await isAllowedSender(pool, 'email', 'ABCDEF@t.com'), true);
    });

    it('returns false for non-allowlisted identity (default-deny)', async () => {
      const { pool } = createInMemoryPool();
      assert.equal(await isAllowedSender(pool, 'email', 'unknown@t.com'), false);
    });

    it('matches only the exact allowlisted email', async () => {
      const { pool } = createInMemoryPool();
      await addAllowedSender(pool, {
        identity_type: 'email', identity: 'a@t.com', quota_per_month: null, added_by: 'a',
      });
      assert.equal(await isAllowedSender(pool, 'email', 'b@t.com'), false);
      assert.equal(await isAllowedSender(pool, 'email', 'a@t.com'), true);
    });
  });

  describe('monthly usage', () => {
    it('starts at zero', async () => {
      const { pool } = createInMemoryPool();
      const n = await getMonthlyUsage(pool, 'email', 'one@t.com', '2026-04');
      assert.equal(n, 0);
    });

    it('increments and reads usage for a period (case-insensitive)', async () => {
      const { pool } = createInMemoryPool();
      await incrementMonthlyUsage(pool, 'email', 'ABC@t.com', '2026-04');
      await incrementMonthlyUsage(pool, 'email', 'ABC@t.com', '2026-04');
      await incrementMonthlyUsage(pool, 'email', 'ABC@t.com', '2026-04');
      assert.equal(await getMonthlyUsage(pool, 'email', 'abc@t.com', '2026-04'), 3);
    });

    it('isolates usage by period', async () => {
      const { pool } = createInMemoryPool();
      await incrementMonthlyUsage(pool, 'email', 'a@t.com', '2026-03');
      await incrementMonthlyUsage(pool, 'email', 'a@t.com', '2026-04');
      await incrementMonthlyUsage(pool, 'email', 'a@t.com', '2026-04');
      assert.equal(await getMonthlyUsage(pool, 'email', 'a@t.com', '2026-03'), 1);
      assert.equal(await getMonthlyUsage(pool, 'email', 'a@t.com', '2026-04'), 2);
    });

    it('isolates usage by identity', async () => {
      const { pool } = createInMemoryPool();
      await incrementMonthlyUsage(pool, 'email', 'one@t.com', '2026-04');
      assert.equal(await getMonthlyUsage(pool, 'email', 'two@t.com', '2026-04'), 0);
    });
  });
});
