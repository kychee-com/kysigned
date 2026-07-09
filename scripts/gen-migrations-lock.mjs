/**
 * gen-migrations-lock — regenerate src/db/migrations/migrations.lock.json.
 *
 * Migrations are APPEND-ONLY (issue #115): prod records each by NAME in
 * `_schema_migrations` and never re-applies it, so editing a shipped .sql
 * silently drifts prod from the repo. The lock pins an LF-normalized sha256 of
 * every migration; `integrity.test.ts` fails if a shipped file's content
 * changes. When you legitimately ADD a new NNN_*.sql migration, run this to
 * refresh the lock (a deliberate, reviewable step) — never edit an existing
 * migration to change the schema.
 *
 *   node scripts/gen-migrations-lock.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');

/** sha256 over LF-normalized content, so a CRLF checkout hashes identically (issue #115). */
export function hashMigration(content) {
  return 'sha256:' + createHash('sha256').update(content.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export function computeLock() {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const migrations = {};
  for (const f of files) migrations[f] = hashMigration(readFileSync(join(dir, f), 'utf8'));
  return migrations;
}

const COMMENT =
  'APPEND-ONLY. Migrations are immutable once shipped: prod records them by name and never re-applies, ' +
  'so editing a file silently drifts prod (issue #115). To change the schema, ADD a new NNN_*.sql migration ' +
  'and regenerate this lock via scripts/gen-migrations-lock.mjs. integrity.test.ts fails if any shipped file ' +
  'changes. Hashes are over LF-normalized content (CRLF-safe).';

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
  writeFileSync(join(dir, 'migrations.lock.json'), JSON.stringify({ _comment: COMMENT, migrations: computeLock() }, null, 2) + '\n');
  console.log(`migrations.lock.json regenerated (${Object.keys(computeLock()).length} migrations)`);
}
