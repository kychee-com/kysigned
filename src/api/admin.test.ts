/**
 * Admin API tests — F2.8 admin endpoints for managing allowed_senders.
 *
 * The admin API requires operator authentication. The library exposes pure
 * handlers; the deploying service is responsible for wiring auth (e.g.,
 * static admin token, session, or platform IAM).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleAddAllowedSender,
  handleRemoveAllowedSender,
  handleListAllowedSenders,
} from './admin.js';
import type { DbPool } from '../db/pool.js';

function createInMemoryPool() {
  const allowed: any[] = [];
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as any[];
      if (text.includes('INSERT INTO allowed_senders')) {
        const existing = allowed.find((a) => a.identity_type === v[0] && a.identity === v[1]);
        if (existing) {
          existing.quota_per_month = v[2]; existing.added_by = v[3]; existing.note = v[4];
          return { rows: [existing], rowCount: 1 } as any;
        }
        const row = { id: `as-${allowed.length + 1}`, identity_type: v[0], identity: v[1],
          quota_per_month: v[2], added_by: v[3], note: v[4], added_at: new Date() };
        allowed.push(row);
        return { rows: [row], rowCount: 1 } as any;
      }
      if (text.includes('DELETE FROM allowed_senders')) {
        const idx = allowed.findIndex((a) => a.identity_type === v[0] && a.identity === v[1]);
        if (idx >= 0) {
          const [removed] = allowed.splice(idx, 1);
          return { rows: [removed], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      }
      if (text.includes('SELECT * FROM allowed_senders WHERE identity_type')) {
        const row = allowed.find((a) => a.identity_type === v[0] && a.identity === v[1]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } as any;
      }
      if (text.includes('SELECT * FROM allowed_senders')) {
        return { rows: [...allowed] } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    },
    async end() {},
  };
  return { pool, allowed };
}

describe('Admin API — F2.8 allowed_senders management', () => {
  describe('POST /admin/allowed_senders', () => {
    it('adds an email sender with quota', async () => {
      const { pool } = createInMemoryPool();
      const r = await handleAddAllowedSender(
        { pool, operator: 'admin@kychee.com' },
        { identity_type: 'email', identity: 'Team@Example.com', quota_per_month: 100, note: 'team A' }
      );
      assert.equal(r.status, 201);
      const body = r.body as any;
      assert.equal(body.identity, 'team@example.com');
      assert.equal(body.quota_per_month, 100);
      assert.equal(body.added_by, 'admin@kychee.com');
    });

    it('adds an email sender with unlimited quota', async () => {
      const { pool } = createInMemoryPool();
      const r = await handleAddAllowedSender(
        { pool, operator: 'admin' },
        { identity_type: 'email', identity: 'a@t.com', quota_per_month: null }
      );
      assert.equal(r.status, 201);
      assert.equal((r.body as any).quota_per_month, null);
    });

    it('adds an email_domain entry that allows any email under the domain', async () => {
      const { pool } = createInMemoryPool();
      const r = await handleAddAllowedSender(
        { pool, operator: 'admin' },
        { identity_type: 'email_domain', identity: '@example.org', quota_per_month: 500 }
      );
      assert.equal(r.status, 201);
      const body = r.body as any;
      assert.equal(body.identity_type, 'email_domain');
      assert.equal(body.identity, 'example.org'); // leading @ stripped
      assert.equal(body.quota_per_month, 500);
    });

    it('rejects invalid identity_type', async () => {
      const { pool } = createInMemoryPool();
      const r = await handleAddAllowedSender(
        { pool, operator: 'admin' },
        { identity_type: 'sms' as any, identity: 'x@t.com', quota_per_month: null }
      );
      assert.equal(r.status, 400);
    });

    it('rejects empty identity', async () => {
      const { pool } = createInMemoryPool();
      const r = await handleAddAllowedSender(
        { pool, operator: 'admin' },
        { identity_type: 'email', identity: '', quota_per_month: null }
      );
      assert.equal(r.status, 400);
    });

    it('rejects negative quota', async () => {
      const { pool } = createInMemoryPool();
      const r = await handleAddAllowedSender(
        { pool, operator: 'admin' },
        { identity_type: 'email', identity: 'one@t.com', quota_per_month: -1 }
      );
      assert.equal(r.status, 400);
    });
  });

  describe('DELETE /admin/allowed_senders/:type/:identity', () => {
    it('removes an existing entry', async () => {
      const { pool } = createInMemoryPool();
      await handleAddAllowedSender({ pool, operator: 'a' },
        { identity_type: 'email', identity: 'one@t.com', quota_per_month: null });
      const r = await handleRemoveAllowedSender({ pool, operator: 'a' }, 'email', 'one@t.com');
      assert.equal(r.status, 200);
    });

    it('returns 404 for unknown entry', async () => {
      const { pool } = createInMemoryPool();
      const r = await handleRemoveAllowedSender({ pool, operator: 'a' }, 'email', 'missing@t.com');
      assert.equal(r.status, 404);
    });
  });

  describe('GET /admin/allowed_senders', () => {
    it('lists all entries', async () => {
      const { pool } = createInMemoryPool();
      await handleAddAllowedSender({ pool, operator: 'a' },
        { identity_type: 'email_domain', identity: 'example.com', quota_per_month: 10 });
      await handleAddAllowedSender({ pool, operator: 'a' },
        { identity_type: 'email', identity: 'a@t.com', quota_per_month: null });
      const r = await handleListAllowedSenders({ pool, operator: 'a' });
      assert.equal(r.status, 200);
      assert.equal(r.body.length, 2);
    });

    it('returns empty list when none exist', async () => {
      const { pool } = createInMemoryPool();
      const r = await handleListAllowedSenders({ pool, operator: 'a' });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, []);
    });
  });
});
