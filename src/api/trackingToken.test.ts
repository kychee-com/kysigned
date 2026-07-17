/**
 * F-30.7 / #154 — tracking-token store (56.1): mint / hash-at-rest / resolve.
 *
 * Mirrors the API-key custody model (apiKeyAuth.ts): the DB only ever sees the
 * sha256; resolution degrades to null on any storage error (an observer probe
 * must never 500 the status route).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mintTrackingToken,
  hashTrackingToken,
  storeTrackingToken,
  resolveTrackingToken,
} from './trackingToken.js';
import type { DbPool } from '../db/pool.js';

function fakePool(rows: Array<Record<string, unknown>> = []): { pool: DbPool; queries: Array<{ text: string; values: unknown[] }> } {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  return {
    queries,
    pool: {
      async query(text: string, values?: unknown[]) {
        queries.push({ text, values: values ?? [] });
        return { rows, rowCount: rows.length } as never;
      },
      async end() {},
    } as unknown as DbPool,
  };
}

describe('mintTrackingToken — F-30.7 token shape', () => {
  it('mints ktt_ + 43 base64url chars (256-bit), unique per call, hash pairs with the raw', () => {
    const a = mintTrackingToken();
    const b = mintTrackingToken();
    assert.match(a.raw, /^ktt_[A-Za-z0-9_-]{43}$/, '256 bits base64url under the ktt_ prefix');
    assert.notEqual(a.raw, b.raw);
    assert.equal(a.hash, hashTrackingToken(a.raw));
  });

  it('the raw token NEVER contains a 64-hex run (custody-regex interplay: bare 64-hex = key shape)', () => {
    for (let i = 0; i < 20; i++) {
      assert.doesNotMatch(mintTrackingToken().raw, /[0-9a-fA-F]{64}/);
    }
  });

  it('hashTrackingToken is a deterministic hex sha256 of the raw', () => {
    const h1 = hashTrackingToken('ktt_x');
    const h2 = hashTrackingToken('ktt_x');
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.notEqual(h1, hashTrackingToken('ktt_y'));
  });
});

describe('storeTrackingToken — hash-at-rest', () => {
  it('inserts ONLY the hash — the raw token never reaches the DB', async () => {
    const { pool, queries } = fakePool();
    const minted = mintTrackingToken();
    await storeTrackingToken(pool, 'env-1', minted.raw);
    assert.equal(queries.length, 1);
    assert.match(queries[0]!.text, /INSERT INTO envelope_tracking_tokens/i);
    assert.ok(queries[0]!.values.includes('env-1'));
    assert.ok(queries[0]!.values.includes(hashTrackingToken(minted.raw)), 'the hash is a bind param');
    assert.ok(!queries[0]!.values.includes(minted.raw), 'the RAW token must never be a bind param');
    assert.doesNotMatch(queries[0]!.text, /ktt_/, 'the raw token must never be inlined in SQL');
  });
});

describe('resolveTrackingToken — observer lookup', () => {
  it('resolves a known raw token to its envelope_id by hash', async () => {
    const minted = mintTrackingToken();
    const { pool, queries } = fakePool([{ envelope_id: 'env-9' }]);
    const got = await resolveTrackingToken(pool, minted.raw);
    assert.equal(got, 'env-9');
    assert.ok(queries[0]!.values.includes(hashTrackingToken(minted.raw)), 'lookup is BY HASH');
    assert.ok(!queries[0]!.values.includes(minted.raw));
  });

  it('unknown token → null; non-ktt_ input → null with NO query (cheap reject)', async () => {
    const { pool } = fakePool([]);
    assert.equal(await resolveTrackingToken(pool, mintTrackingToken().raw), null);
    const { pool: p2, queries: q2 } = fakePool([]);
    assert.equal(await resolveTrackingToken(p2, 'ksk_not_a_tracking_token'), null);
    assert.equal(q2.length, 0, 'wrong prefix never touches the DB');
  });

  it('a storage error degrades to null (observer probes never 500 the route)', async () => {
    const pool = {
      async query() {
        throw new Error('db down');
      },
      async end() {},
    } as unknown as DbPool;
    assert.equal(await resolveTrackingToken(pool, mintTrackingToken().raw), null);
  });
});
