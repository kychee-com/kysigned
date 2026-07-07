/**
 * apiKeys DAO tests — F-30.1 (AC-131/AC-132).
 *
 * The table stores ONLY a sha256 hash of the key (the raw value exists once, in
 * the mint response). Lookups filter revoked keys; revocation is scoped to the
 * owning creator so one creator can never revoke another's key.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import type { DbPool } from './pool.js';
import {
  createApiKey,
  getApiKeyByHash,
  listApiKeysByCreator,
  revokeApiKey,
  touchApiKeyLastUsed,
} from './apiKeys.js';

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

const ROW = {
  id: 'k-1',
  creator_email: 'creator@example.com',
  key_hash: 'h'.repeat(64),
  label: 'mcp',
  created_at: '2026-07-07T00:00:00.000Z', // prod wire shape: ISO STRING, not Date
  last_used_at: null,
  revoked_at: null,
};

describe('apiKeys DAO (F-30.1)', () => {
  it('createApiKey INSERTs hash + creator and returns the rehydrated row', async () => {
    const { pool, queries } = makePool(() => [{ ...ROW }]);
    const row = await createApiKey(pool, {
      creatorEmail: 'creator@example.com',
      keyHash: 'h'.repeat(64),
      label: 'mcp',
    });
    const ins = queries.find((q) => /INSERT INTO api_keys/i.test(q.text));
    assert.ok(ins, 'INSERT INTO api_keys ran');
    assert.ok((ins!.values ?? []).includes('h'.repeat(64)), 'stores the HASH');
    assert.equal(row.creator_email, 'creator@example.com');
    // prod HttpDbPool returns TIMESTAMPTZ as ISO strings — the DAO must rehydrate.
    assert.ok(row.created_at instanceof Date, 'created_at rehydrated to a Date');
  });

  it('getApiKeyByHash filters revoked keys (WHERE revoked_at IS NULL)', async () => {
    const { pool, queries } = makePool(() => [{ ...ROW }]);
    const row = await getApiKeyByHash(pool, ROW.key_hash);
    assert.ok(row);
    const sel = queries.find((q) => /FROM api_keys/i.test(q.text));
    assert.ok(sel, 'SELECT ran');
    assert.match(sel!.text, /revoked_at IS NULL/i, 'revoked keys are excluded at the SQL layer');
    assert.ok((sel!.values ?? []).includes(ROW.key_hash), 'looks up by hash');
  });

  it('getApiKeyByHash returns null when nothing matches', async () => {
    const { pool } = makePool(() => []);
    assert.equal(await getApiKeyByHash(pool, 'nope'), null);
  });

  it('listApiKeysByCreator scopes to the creator email', async () => {
    const { pool, queries } = makePool(() => [{ ...ROW }, { ...ROW, id: 'k-2', revoked_at: '2026-07-07T01:00:00.000Z' }]);
    const rows = await listApiKeysByCreator(pool, 'creator@example.com');
    assert.equal(rows.length, 2);
    const sel = queries.find((q) => /FROM api_keys/i.test(q.text));
    assert.ok((sel!.values ?? []).includes('creator@example.com'), 'scoped to the creator');
    assert.ok(rows[1]!.revoked_at instanceof Date, 'revoked_at rehydrated');
  });

  it('revokeApiKey updates only the owner row and reports whether it hit', async () => {
    const { pool, queries } = makePool((text) => (/UPDATE api_keys/i.test(text) ? [{ id: 'k-1' }] : []));
    const ok = await revokeApiKey(pool, 'k-1', 'creator@example.com');
    assert.equal(ok, true);
    const upd = queries.find((q) => /UPDATE api_keys/i.test(q.text));
    assert.ok(upd, 'UPDATE ran');
    assert.match(upd!.text, /revoked_at/i);
    const vals = upd!.values ?? [];
    assert.ok(vals.includes('k-1') && vals.includes('creator@example.com'), 'scoped to id AND owner');
  });

  it('revokeApiKey returns false for a foreign or unknown key', async () => {
    const { pool } = makePool(() => []);
    assert.equal(await revokeApiKey(pool, 'k-other', 'creator@example.com'), false);
  });

  it('touchApiKeyLastUsed stamps last_used_at', async () => {
    const { pool, queries } = makePool(() => []);
    await touchApiKeyLastUsed(pool, 'k-1');
    const upd = queries.find((q) => /UPDATE api_keys/i.test(q.text));
    assert.ok(upd && /last_used_at/i.test(upd.text));
  });
});
