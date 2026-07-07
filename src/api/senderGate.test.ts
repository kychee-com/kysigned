/**
 * Sender gate tests — from spec F2.8.
 *
 * The sender gate is the default-deny enforcement layer that runs on POST /v1/envelope.
 * It supports two enforcement strategies:
 *   - 'allowlist' (self-hosted default): identity must be in allowed_senders table
 *   - 'hosted':   identity must be in allowed_senders OR have a positive credit balance
 *
 * In both modes, per-month quota (NULL = unlimited) is enforced when the identity
 * matches an allowed_senders row.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSenderAllowed } from './senderGate.js';
import { addAllowedSender, incrementMonthlyUsage } from '../db/allowedSenders.js';
import type { DbPool } from '../db/pool.js';

// Reuse the in-memory pool shape from allowedSenders.test.ts (lite copy).
function createInMemoryPool() {
  const allowed: any[] = [];
  const usage: any[] = [];

  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as any[];

      if (text.includes('INSERT INTO allowed_senders')) {
        const existing = allowed.find((a) => a.identity_type === v[0] && a.identity === v[1]);
        if (existing) {
          existing.quota_per_month = v[2];
          existing.added_by = v[3];
          existing.note = v[4];
          return { rows: [existing], rowCount: 1 } as any;
        }
        const row = {
          id: `as-${allowed.length + 1}`,
          identity_type: v[0], identity: v[1], quota_per_month: v[2],
          added_by: v[3], note: v[4], added_at: new Date(),
        };
        allowed.push(row);
        return { rows: [row], rowCount: 1 } as any;
      }
      if (text.includes("identity_type = 'email_domain'")) {
        const email = v[0] as string;
        const domain = v[1] as string;
        const exact = allowed.find((a) => a.identity_type === 'email' && a.identity === email);
        if (exact) return { rows: [exact], rowCount: 1 } as any;
        const dom = allowed.find((a) => a.identity_type === 'email_domain' && a.identity === domain);
        return { rows: dom ? [dom] : [], rowCount: dom ? 1 : 0 } as any;
      }
      if (text.includes('SELECT * FROM allowed_senders WHERE identity_type')) {
        const row = allowed.find((a) => a.identity_type === v[0] && a.identity === v[1]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } as any;
      }
      if (text.includes('INSERT INTO allowed_sender_usage')) {
        const existing = usage.find(
          (u) => u.identity_type === v[0] && u.identity === v[1] && u.period === v[2]
        );
        if (existing) { existing.count += 1; return { rows: [existing], rowCount: 1 } as any; }
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
  return { pool };
}

describe('Sender gate — F2.8 default-deny enforcement', () => {
  describe("strategy = 'allowlist' (self-hosted)", () => {
    it('denies an unknown sender (default-deny)', async () => {
      const { pool } = createInMemoryPool();
      const r = await checkSenderAllowed(pool, {
        strategy: 'allowlist',
        identity_type: 'email',
        identity: 'unknown@t.com',
        period: '2026-04',
      });
      assert.equal(r.allowed, false);
      assert.match(r.reason!, /not on the allowlist/i);
    });

    it('allows an allowlisted sender with no quota (case-insensitive)', async () => {
      const { pool } = createInMemoryPool();
      await addAllowedSender(pool, {
        identity_type: 'email', identity: 'ABC@t.com', quota_per_month: null, added_by: 'admin',
      });
      const r = await checkSenderAllowed(pool, {
        strategy: 'allowlist', identity_type: 'email', identity: 'abc@t.com', period: '2026-04',
      });
      assert.equal(r.allowed, true);
    });

    it('allows when usage is below quota', async () => {
      const { pool } = createInMemoryPool();
      await addAllowedSender(pool, {
        identity_type: 'email', identity: 'one@t.com', quota_per_month: 3, added_by: 'a',
      });
      await incrementMonthlyUsage(pool, 'email', 'one@t.com', '2026-04');
      await incrementMonthlyUsage(pool, 'email', 'one@t.com', '2026-04');
      const r = await checkSenderAllowed(pool, {
        strategy: 'allowlist', identity_type: 'email', identity: 'one@t.com', period: '2026-04',
      });
      assert.equal(r.allowed, true);
    });

    it('denies when usage equals quota', async () => {
      const { pool } = createInMemoryPool();
      await addAllowedSender(pool, {
        identity_type: 'email', identity: 'one@t.com', quota_per_month: 2, added_by: 'a',
      });
      await incrementMonthlyUsage(pool, 'email', 'one@t.com', '2026-04');
      await incrementMonthlyUsage(pool, 'email', 'one@t.com', '2026-04');
      const r = await checkSenderAllowed(pool, {
        strategy: 'allowlist', identity_type: 'email', identity: 'one@t.com', period: '2026-04',
      });
      assert.equal(r.allowed, false);
      assert.match(r.reason!, /quota/i);
    });

    it('allows fresh sender on a new period (quota resets monthly)', async () => {
      const { pool } = createInMemoryPool();
      await addAllowedSender(pool, {
        identity_type: 'email', identity: 'a@t.com', quota_per_month: 1, added_by: 'a',
      });
      await incrementMonthlyUsage(pool, 'email', 'a@t.com', '2026-03');
      const r = await checkSenderAllowed(pool, {
        strategy: 'allowlist', identity_type: 'email', identity: 'a@t.com', period: '2026-04',
      });
      assert.equal(r.allowed, true);
    });
  });

  describe("strategy = 'hosted'", () => {
    it('allows an allowlisted sender even without credits', async () => {
      const { pool } = createInMemoryPool();
      await addAllowedSender(pool, {
        identity_type: 'email', identity: 'one@t.com', quota_per_month: null, added_by: 'a',
      });
      const r = await checkSenderAllowed(pool, {
        strategy: 'hosted', identity_type: 'email', identity: 'one@t.com', period: '2026-04',
        creditBalance: 0,
      });
      assert.equal(r.allowed, true);
    });

    it('allows a non-allowlisted sender when credit balance > 0', async () => {
      const { pool } = createInMemoryPool();
      const r = await checkSenderAllowed(pool, {
        strategy: 'hosted', identity_type: 'email', identity: 'new@t.com', period: '2026-04',
        creditBalance: 5,
      });
      assert.equal(r.allowed, true);
    });

    it('denies a non-allowlisted sender with zero credit balance', async () => {
      const { pool } = createInMemoryPool();
      const r = await checkSenderAllowed(pool, {
        strategy: 'hosted', identity_type: 'email', identity: 'new@t.com', period: '2026-04',
        creditBalance: 0,
      });
      assert.equal(r.allowed, false);
      assert.match(r.reason!, /credit|allowlist/i);
    });

    it('still enforces quota when allowlisted', async () => {
      const { pool } = createInMemoryPool();
      await addAllowedSender(pool, {
        identity_type: 'email', identity: 'one@t.com', quota_per_month: 1, added_by: 'a',
      });
      await incrementMonthlyUsage(pool, 'email', 'one@t.com', '2026-04');
      const r = await checkSenderAllowed(pool, {
        strategy: 'hosted', identity_type: 'email', identity: 'one@t.com', period: '2026-04',
        creditBalance: 100,
      });
      // Quota wins over credit balance — explicit limit set by admin
      assert.equal(r.allowed, false);
      assert.match(r.reason!, /quota/i);
    });
  });
});
