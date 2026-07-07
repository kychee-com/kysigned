/**
 * envelopeWebhooks DAO tests — F-30.3 (AC-138). One row per envelope
 * (PK envelope_id, FK ON DELETE CASCADE — the webhook dies with its envelope).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import type { DbPool } from './pool.js';
import { setEnvelopeWebhook, getEnvelopeWebhook } from './envelopeWebhooks.js';

function makePool(handler?: (text: string, values?: unknown[]) => Array<Record<string, unknown>>) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      const rows = handler ? handler(text, values) : [];
      return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] } as unknown as pg.QueryResult;
    },
    async end() {},
  };
  return { pool, queries };
}

describe('envelopeWebhooks DAO (F-30.3)', () => {
  it('setEnvelopeWebhook INSERTs envelope_id + url + secret', async () => {
    const { pool, queries } = makePool(() => []);
    await setEnvelopeWebhook(pool, { envelopeId: 'env-1', url: 'https://a.example.com/h', secret: 'whs_x' });
    const ins = queries.find((q) => /INSERT INTO envelope_webhooks/i.test(q.text));
    assert.ok(ins, 'INSERT ran');
    const v = ins!.values ?? [];
    assert.ok(v.includes('env-1') && v.includes('https://a.example.com/h') && v.includes('whs_x'));
  });

  it('getEnvelopeWebhook returns the row (created_at rehydrated) or null', async () => {
    const { pool } = makePool(() => [
      { envelope_id: 'env-1', url: 'https://a.example.com/h', secret: 'whs_x', created_at: '2026-07-07T00:00:00.000Z' },
    ]);
    const row = await getEnvelopeWebhook(pool, 'env-1');
    assert.ok(row);
    assert.equal(row!.url, 'https://a.example.com/h');
    assert.ok(row!.created_at instanceof Date, 'ISO string rehydrated (prod wire shape)');

    const { pool: empty } = makePool(() => []);
    assert.equal(await getEnvelopeWebhook(empty, 'env-1'), null);
  });
});
