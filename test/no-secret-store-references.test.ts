/**
 * Audit-grep gate — no reference to the old secret store in tracked files.
 *
 * Every Kychee secret lives in Parameter Store (kychee secret policy). History keeps
 * its mentions: applied migrations are exempt. The patterns — and this file's samples,
 * which would otherwise trip the pre-squash leak check — are assembled at runtime, so
 * this guard never self-matches.
 *
 * Run: `node --test --import tsx test/no-secret-store-references.test.ts`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..');
const EXEMPT = [/^src\/db\/migrations\//];
const SECRET = ['sec', 'ret'].join('');
const MANAGER = ['man', 'ager'].join('');
const GAP = String.raw`[\s#*/'"+\-_.]*`;
const PATTERNS = [
  new RegExp(`${SECRET}s?${GAP}${MANAGER}`, 'gi'),
  new RegExp(`get[-_]?${SECRET}[-_]?value`, 'gi'),
  new RegExp(`--${SECRET}-id\\b`, 'g'),
  new RegExp(`\\b${['Sec', 'ret'].join('')}(String|Binary)\\b`, 'g'),
  new RegExp(`from_?${SECRET}_?(name|complete_?arn|partial_?arn|attributes)`, 'gi'),
  new RegExp(`\\b${SECRET}_?arn\\b`, 'gi'),
  new RegExp(`\\bAWS ${['S', 'M'].join('')}\\b`, 'g'),
  new RegExp(`\\bAWS ${SECRET}s?\\b(?! (access|key))`, 'gi'),
];

function references(text: string): number[] {
  const lines = new Set<number>();
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) lines.add(text.slice(0, match.index).split('\n').length);
  }
  return [...lines].sort((a, b) => a - b);
}

describe('audit-grep — the old secret store is not referenced', () => {
  it('tracked files name only Parameter Store', () => {
    const files = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    const found: string[] = [];
    for (const path of files) {
      if (EXEMPT.some((pattern) => pattern.test(path))) continue;
      const full = join(ROOT, path);
      let text: string;
      try {
        if (!statSync(full).isFile()) continue;
        text = readFileSync(full, 'utf8');
      } catch {
        continue; // listed but missing on disk, e.g. a deleted file not yet committed
      }
      if (text.includes('\u0000')) continue; // binary
      for (const line of references(text)) found.push(`${path}:${line}`);
    }
    assert.deepEqual(found, [], `old secret store referenced at:\n${found.join('\n')}`);
  });

  it('the guard catches what it should', () => {
    assert.deepEqual(references(`import { X } from "@aws-sdk/client-${SECRET}s-${MANAGER}"\n`), [1]);
    assert.deepEqual(references(`${['aws', 'ssm'].join(' ')} get-parameter --name /secrets/example --with-decryption\n`), []);
  });
});
