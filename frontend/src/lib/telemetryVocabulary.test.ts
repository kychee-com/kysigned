/**
 * telemetryVocabulary.test.ts — the client half of the FC30.3 two-sided lock.
 *
 * `src/api/telemetryVocabulary.test.ts` (backend suite) holds
 * `CLIENT_TELEMETRY_EVENTS` and the server's `BROWSER_EVENTS` to each other.
 * That is only worth anything if the declared list is the REAL one — otherwise
 * the lock guards a list nothing emits. This test closes that half: every
 * event-name literal actually handed to the rail anywhere in the SPA (and in
 * the standalone static mirror) must be declared.
 *
 * Chain: emit call sites ⊆ CLIENT_TELEMETRY_EVENTS ⊆ BROWSER_EVENTS.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLIENT_TELEMETRY_EVENTS } from './telemetryEvents';

/** The `frontend/` root, found from the runner's cwd (never `import.meta.url` —
 *  Vite rewrites that to a non-file scheme in the transformed module). */
function frontendRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'public', 'telemetry.mjs')) && existsSync(join(dir, 'src', 'lib', 'telemetry.ts'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`could not locate the frontend root from ${process.cwd()}`);
}

const FRONTEND_ROOT = frontendRoot();

/**
 * Emit forms with a literal first argument. `.push(` is deliberately excluded
 * (array pushes everywhere) while the rail's own bare `push('page_view')` is
 * included — that is where `page_view` / `click` / `scroll` enter the wire.
 */
const EMIT_RE = /(?:telemetryEventOnce|telemetryEvent|\.eventOnce|\.event|(?<![.\w])push)\(\s*'([^']+)'/g;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      sourceFiles(full, acc);
      continue;
    }
    if (/\.test\.[cm]?[jt]sx?$/.test(entry)) continue; // tests may fabricate names
    if (/\.[cm]?[jt]sx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe('the declared client vocabulary is the REAL one (FC30.3)', () => {
  const declared = new Set<string>(CLIENT_TELEMETRY_EVENTS);
  const files = [...sourceFiles(join(FRONTEND_ROOT, 'src')), join(FRONTEND_ROOT, 'public', 'telemetry.mjs')];

  it('scans a meaningful surface (the scan itself must not silently find nothing)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('every event name handed to the rail anywhere in the SPA or the static mirror is declared', () => {
    const undeclared: Array<{ file: string; event: string }> = [];
    let emits = 0;
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(EMIT_RE)) {
        emits += 1;
        if (!declared.has(m[1])) undeclared.push({ file: file.slice(FRONTEND_ROOT.length).replace(/\\/g, '/'), event: m[1] });
      }
    }
    // The rail's own three automatic facts plus the hand-fired steps — if this
    // ever drops to a handful the regex stopped matching and the lock is fake.
    expect(emits, 'literal emit call sites found').toBeGreaterThanOrEqual(10);
    expect(undeclared, 'undeclared telemetry event name(s) — add them to CLIENT_TELEMETRY_EVENTS *and* the server BROWSER_EVENTS').toEqual([]);
  });

  it('both F-44.4 affordance facts are fired from the editor, not merely declared', () => {
    const editor = readFileSync(join(FRONTEND_ROOT, 'src', 'pages', 'CreateEnvelopePage.tsx'), 'utf8');
    expect(editor).toContain("telemetryEventOnce('sample_doc_clicked')");
    expect(editor).toContain("telemetryEventOnce('cover_details_expanded')");
  });
});
