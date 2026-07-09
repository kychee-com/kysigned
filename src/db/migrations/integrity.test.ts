/**
 * Migration integrity — APPEND-ONLY enforcement (issue #115).
 *
 * Prod tracks applied migrations by NAME only (`_schema_migrations`, no
 * checksum) and never re-applies a recorded name. So editing a shipped .sql
 * changes the repo without ever reaching prod — a silent schema drift (this is
 * how prod's `credit_ledger` CHECK stayed enumerated while `001_schema.sql`
 * said agnostic, breaking the x402 rail until migration 009).
 *
 * This test pins an LF-normalized sha256 of every migration in
 * `migrations.lock.json`. Editing a shipped migration flips its hash → this
 * test fails, forcing you to instead ADD a new NNN_*.sql migration (and run
 * `scripts/gen-migrations-lock.mjs` to record it). LF-normalization keeps a
 * CRLF checkout hashing identically (the other half of #115).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeLock, hashMigration } from '../../../scripts/gen-migrations-lock.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(readFileSync(join(dir, 'migrations.lock.json'), 'utf8')) as {
  migrations: Record<string, string>;
};

describe('migration integrity — append-only (#115)', () => {
  it('every shipped .sql matches its locked LF-normalized checksum (edit a migration → add a new one instead)', () => {
    const drifted: string[] = [];
    for (const [name, want] of Object.entries(lock.migrations)) {
      const got = hashMigration(readFileSync(join(dir, name), 'utf8'));
      if (got !== want) drifted.push(`${name}: locked ${want.slice(0, 20)}… but file is ${got.slice(0, 20)}…`);
    }
    assert.deepEqual(
      drifted,
      [],
      `migration file(s) changed after being shipped — migrations are APPEND-ONLY (#115).\n${drifted.join('\n')}\n` +
        `To change the schema, add a NEW NNN_*.sql migration and run scripts/gen-migrations-lock.mjs.`,
    );
  });

  it('the lock and the migrations dir are in 1:1 correspondence (no unlocked or stale entries)', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const locked = Object.keys(lock.migrations).sort();
    assert.deepEqual(
      files,
      locked,
      'every .sql must be locked and every locked entry must exist — run scripts/gen-migrations-lock.mjs after adding a migration.',
    );
  });

  it('computeLock() reproduces the committed lock exactly (generator is deterministic)', () => {
    assert.deepEqual(computeLock(), lock.migrations);
  });
});
