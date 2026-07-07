/**
 * apiKeyAuth tests — F-30.1 (AC-131).
 *
 * Key format, hashing, Authorization-header parsing, and the defensive resolve
 * (any throw during resolution degrades to null → the gate 401s, never 500s —
 * the same hardening contract as resolveSession).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import type { DbPool } from '../../db/pool.js';
import { mintApiKey, hashApiKey, extractBearerKey, resolveApiKey, API_KEY_PREFIX } from './apiKeyAuth.js';

describe('apiKeyAuth (F-30.1)', () => {
  it('mintApiKey returns a ksk_-prefixed high-entropy raw + its sha256 hash', () => {
    const a = mintApiKey();
    const b = mintApiKey();
    assert.ok(a.raw.startsWith(API_KEY_PREFIX), 'prefixed');
    assert.ok(a.raw.length >= API_KEY_PREFIX.length + 43, 'at least 256 bits of encoded entropy');
    assert.notEqual(a.raw, b.raw, 'unique per mint');
    assert.equal(a.hash, hashApiKey(a.raw), 'hash pairs with the raw');
    assert.notEqual(a.hash, b.hash);
    assert.ok(!a.hash.includes(a.raw.slice(API_KEY_PREFIX.length)), 'hash does not embed the secret');
  });

  it('hashApiKey is deterministic hex sha256', () => {
    const h1 = hashApiKey('ksk_test');
    const h2 = hashApiKey('ksk_test');
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });

  it('extractBearerKey parses "Bearer <key>", bare "<key>", trims, and treats empty as absent', () => {
    assert.equal(extractBearerKey('Bearer ksk_abc'), 'ksk_abc');
    assert.equal(extractBearerKey('bearer ksk_abc'), 'ksk_abc', 'scheme is case-insensitive');
    assert.equal(extractBearerKey('  ksk_abc  '), 'ksk_abc', 'bare key accepted (MCP env passes it verbatim)');
    assert.equal(extractBearerKey(null), null);
    assert.equal(extractBearerKey('   '), null, 'whitespace-only = no attempt');
    // Present-but-garbage is still an ATTEMPT (returned for resolve to reject) —
    // it must not read as "no header".
    assert.equal(extractBearerKey('Bearer not-a-key'), 'not-a-key');
  });

  it('resolveApiKey resolves a stored hash to the creator and touches last_used_at', async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const raw = mintApiKey();
    const pool: DbPool = {
      async query(text: string, values?: unknown[]) {
        queries.push({ text, values });
        if (/FROM api_keys/i.test(text)) {
          return {
            rows: [{ id: 'k-1', creator_email: 'creator@example.com', key_hash: raw.hash, label: null, created_at: new Date().toISOString(), last_used_at: null, revoked_at: null }],
            rowCount: 1,
          } as unknown as pg.QueryResult;
        }
        return { rows: [], rowCount: 0 } as unknown as pg.QueryResult;
      },
      async end() {},
    };
    const actor = await resolveApiKey(pool, `Bearer ${raw.raw}`);
    assert.ok(actor);
    assert.equal(actor!.email, 'creator@example.com');
    assert.equal(actor!.keyId, 'k-1');
    const sel = queries.find((q) => /FROM api_keys/i.test(q.text));
    assert.ok((sel!.values ?? []).includes(raw.hash), 'looked up by HASH, never the raw');
    assert.ok(queries.some((q) => /last_used_at/i.test(q.text)), 'last_used_at touched');
  });

  it('resolveApiKey returns null for absent header, wrong prefix, or unknown key', async () => {
    const empty: DbPool = { async query() { return { rows: [], rowCount: 0 } as unknown as pg.QueryResult; }, async end() {} };
    assert.equal(await resolveApiKey(empty, null), null);
    assert.equal(await resolveApiKey(empty, 'Bearer not-a-key'), null, 'non-ksk prefix rejected without a DB hit');
    assert.equal(await resolveApiKey(empty, `Bearer ${API_KEY_PREFIX}${'c'.repeat(64)}`), null, 'unknown key → null');
  });

  it('resolveApiKey degrades to null when the DB throws (401, never a 500)', async () => {
    const boom: DbPool = { async query() { throw new Error('db down'); }, async end() {} };
    assert.equal(await resolveApiKey(boom, `Bearer ${API_KEY_PREFIX}${'d'.repeat(64)}`), null);
  });
});
