/**
 * Audit-grep gate — the retired SPA subdomain (DD-73 single-origin apex) must
 * not appear in source.
 *
 * v0.22.1 (DD-73) collapsed kysigned to a single same-origin apex
 * (`<operatorDomain>`, kysigned.com for Kychee). The separate app-subdomain
 * run402 project + its Custom Hostname were DELETED; the SPA serves same-origin
 * with the API + marketing. No source under src/, frontend/src/, or scripts/ may
 * reference the dead host. The apex `kysigned.com` is fine; the retired
 * `app.`-prefixed subdomain is not.
 *
 * The forbidden literal is assembled at runtime so this guard never self-matches.
 *
 * Run: `node --test --import tsx test/no-app-subdomain.test.ts`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN = ['app', 'kysigned', 'com'].join('.');
const ROOT = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..');
const SCAN = ['src', 'frontend/src', 'scripts'].map((d) => join(ROOT, d));
const EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs', '.json', '.html']);
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', 'build']);

function* walk(dir: string): Iterable<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

describe('audit-grep — retired SPA subdomain not in source (DD-73)', () => {
  it('src/, frontend/src/, scripts/ do not reference the dead app-subdomain host', () => {
    const hits: string[] = [];
    for (const dir of SCAN) {
      for (const file of walk(dir)) {
        const dot = file.lastIndexOf('.');
        if (dot < 0 || !EXT.has(file.slice(dot))) continue;
        const content = readFileSync(file, 'utf8');
        if (content.includes(FORBIDDEN)) {
          const line =
            content.split(/\r?\n/).findIndex((l) => l.includes(FORBIDDEN)) + 1;
          hits.push(`${file.slice(ROOT.length + 1)}:${line}`);
        }
      }
    }
    assert.deepEqual(
      hits,
      [],
      `Retired SPA subdomain (DD-73 single-origin apex) found in source:\n${hits
        .map((h) => `  ${h}`)
        .join('\n')}\n\nUse the apex (kysigned.com) for Kychee surfaces, or a generic placeholder for two-host forker examples.`,
    );
  });
});
