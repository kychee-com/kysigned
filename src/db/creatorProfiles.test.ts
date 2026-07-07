/**
 * creatorProfiles tests — Phase 2F.SS, surface D (spec F1.11 / DD-97).
 *
 * `creator_profiles` stores the ENVELOPE CREATOR's own saved name (our
 * customer's name) — NOT a signer/recipient store. One row per creator
 * account, keyed by their normalized lowercase login email. The only datum is
 * `display_name`; the email is already known from sign-in.
 *
 * Invariants tested here:
 *   1. getCreatorName returns null when no row exists, the stored name when it
 *      does, and matches case-insensitively (normalized email key).
 *   2. upsertCreatorName inserts on first write and OVERWRITES on a second
 *      write for the same account — the typo-fix path (a later send with a
 *      corrected name replaces the saved value).
 *
 * Uses an in-memory mock pool matching the pattern from userCredits.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getCreatorName, upsertCreatorName } from './creatorProfiles.js';
// (Fixture identities are generic placeholders — no real accounts.)
import type { DbPool } from './pool.js';

function createInMemoryPool(): DbPool & { _profiles: Map<string, string> } {
  const profiles = new Map<string, string>();

  return {
    _profiles: profiles,
    async query(text: string, values?: unknown[]) {
      const v = values ?? [];
      const t = text.trim();

      // SELECT display_name FROM creator_profiles WHERE account_email = $1
      if (/SELECT display_name FROM creator_profiles WHERE account_email = \$1/.test(t)) {
        const email = v[0] as string;
        const name = profiles.get(email);
        return { rows: name !== undefined ? [{ display_name: name }] : [], rowCount: name !== undefined ? 1 : 0 } as any;
      }

      // INSERT ... ON CONFLICT (account_email) DO UPDATE — upsert the name.
      if (/INSERT INTO creator_profiles[\s\S]*ON CONFLICT \(account_email\)[\s\S]*DO UPDATE SET display_name/.test(t)) {
        const [email, name] = v as [string, string];
        profiles.set(email, name);
        return { rows: [], rowCount: 1 } as any;
      }

      throw new Error(`Unexpected query: ${t}`);
    },
    async end() {},
  };
}

describe('creatorProfiles.getCreatorName', () => {
  it('returns null for an account with no saved name', async () => {
    const pool = createInMemoryPool();
    const name = await getCreatorName(pool, 'nobody@example.com');
    assert.equal(name, null);
  });

  it('returns the saved name for a known account', async () => {
    const pool = createInMemoryPool();
    pool._profiles.set('creator@example.com', 'Jordan Rivera');
    const name = await getCreatorName(pool, 'creator@example.com');
    assert.equal(name, 'Jordan Rivera');
  });

  it('normalizes email case before lookup', async () => {
    const pool = createInMemoryPool();
    pool._profiles.set('creator@example.com', 'Jordan R');
    const name = await getCreatorName(pool, 'Creator@Example.COM');
    assert.equal(name, 'Jordan R');
  });
});

describe('creatorProfiles.upsertCreatorName', () => {
  it('inserts a new saved name, then getCreatorName returns it', async () => {
    const pool = createInMemoryPool();
    await upsertCreatorName(pool, 'creator@example.com', 'Jordan R');
    const name = await getCreatorName(pool, 'creator@example.com');
    assert.equal(name, 'Jordan R');
  });

  it('overwrites the saved name on a second write (the typo-fix path)', async () => {
    const pool = createInMemoryPool();
    await upsertCreatorName(pool, 'creator@example.com', 'Jordan R'); // typo
    await upsertCreatorName(pool, 'creator@example.com', 'Jordan Rivera'); // corrected
    const name = await getCreatorName(pool, 'creator@example.com');
    assert.equal(name, 'Jordan Rivera');
    assert.equal(pool._profiles.size, 1, 'one row per account — corrected name replaces, not appends');
  });

  it('normalizes email case so the same account maps to one row', async () => {
    const pool = createInMemoryPool();
    await upsertCreatorName(pool, 'Creator@Example.COM', 'Jordan R');
    const name = await getCreatorName(pool, 'creator@example.com');
    assert.equal(name, 'Jordan R');
    assert.equal(pool._profiles.size, 1);
  });
});
