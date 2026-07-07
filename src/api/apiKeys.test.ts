/**
 * API-key management handler tests — F-30.1 (AC-132).
 *
 * Mint returns the raw key EXACTLY ONCE (201); list never exposes raw or hash;
 * revoke is owner-scoped (foreign/unknown → 404, no existence leak). These are
 * session-only surfaces — the gate keeps them out of BEARER scope (AC-131).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import type { DbPool } from '../db/pool.js';
import { handleMintApiKey, handleListApiKeys, handleRevokeApiKey } from './apiKeys.js';
import { API_KEY_PREFIX, hashApiKey } from './auth/apiKeyAuth.js';

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

const EMAIL = 'creator@example.com';

describe('api-key management handlers (F-30.1 / AC-132)', () => {
  it('mint → 201 with the raw key (shown exactly once) and stores only its hash', async () => {
    let storedHash: string | undefined;
    const { pool } = makePool((text, values) => {
      if (/INSERT INTO api_keys/i.test(text)) {
        const v = values ?? [];
        storedHash = v.find((x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x as string)) as string;
        return [{
          id: 'k-1', creator_email: EMAIL, key_hash: storedHash,
          label: (v.find((x) => x === 'mcp') as string) ?? null,
          created_at: new Date().toISOString(), last_used_at: null, revoked_at: null,
        }];
      }
      return [];
    });
    const r = await handleMintApiKey({ pool }, EMAIL, { label: 'mcp' });
    assert.equal(r.status, 201);
    const body = r.body as { id: string; key: string; label: string | null };
    assert.equal(body.id, 'k-1');
    assert.ok(body.key.startsWith(API_KEY_PREFIX), 'raw key returned at mint');
    assert.ok(storedHash, 'a hash was stored');
    assert.equal(storedHash, hashApiKey(body.key), 'DB holds sha256(raw), never the raw');
  });

  it('mint validates the label (optional string, capped length)', async () => {
    const { pool } = makePool(() => []);
    const r = await handleMintApiKey({ pool }, EMAIL, { label: 42 });
    assert.equal(r.status, 400);
    const long = await handleMintApiKey({ pool }, EMAIL, { label: 'x'.repeat(101) });
    assert.equal(long.status, 400);
  });

  it('list → 200 with metadata only (no key, no hash)', async () => {
    const { pool } = makePool(() => [
      { id: 'k-1', creator_email: EMAIL, key_hash: 'h'.repeat(64), label: 'mcp', created_at: new Date().toISOString(), last_used_at: null, revoked_at: null },
    ]);
    const r = await handleListApiKeys({ pool }, EMAIL);
    assert.equal(r.status, 200);
    const body = r.body as { keys: Array<Record<string, unknown>> };
    assert.equal(body.keys.length, 1);
    assert.equal(body.keys[0]!.id, 'k-1');
    assert.ok(!('key_hash' in body.keys[0]!), 'hash never leaves the DB layer');
    assert.ok(!('key' in body.keys[0]!), 'raw key never appears after mint');
  });

  it('revoke own key → 200; foreign/unknown → 404 with no existence leak', async () => {
    const mine = makePool((text) => (/UPDATE api_keys/i.test(text) ? [{ id: 'k-1' }] : []));
    const ok = await handleRevokeApiKey({ pool: mine.pool }, EMAIL, 'k-1');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { id: 'k-1', revoked: true });

    const foreign = makePool(() => []);
    const nope = await handleRevokeApiKey({ pool: foreign.pool }, EMAIL, 'k-strangers');
    assert.equal(nope.status, 404);
  });
});
