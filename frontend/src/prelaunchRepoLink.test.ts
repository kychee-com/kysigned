/**
 * prelaunchRepoLink.test.ts — pre-launch guard for FC1.7 / F-003.
 *
 * The public repo `github.com/kychee-com/kysigned` 404s until the launch
 * visibility flip (plan task 20.8). Until then, NO live, shipped surface may
 * hard-link it — a live link to a 404 is the cycle-1 F-003 defect. This sweep
 * scans the SPA's shipping surfaces (the served `llms.txt` + every React
 * component/page that renders to live HTML) and fails if any of them contains a
 * hard link/clone reference to the repo URL.
 *
 * At launch, when the flip happens, re-introduce the GitHub links and update (or
 * retire) this test in the same change. The forkability story stays on the live
 * surfaces meanwhile as forward-looking copy ("public repo published at launch"),
 * which is what this guard permits — it forbids only the live URL/clone form.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, '..'); // frontend/

// A hard link or clone instruction to the not-yet-public repo. Matches the URL
// (with or without scheme) and a `git clone …kysigned` form. It deliberately does
// NOT match prose like "public repository published at launch" (no URL) — that
// forward-looking copy is allowed pre-launch.
const FORBIDDEN = [
  /https?:\/\/github\.com\/kychee-com\/kysigned/i,
  /\bgithub\.com\/kychee-com\/kysigned\//i, // a deep path (e.g. /blob/…)
  /\bclone\s+github\.com\/kychee-com\/kysigned/i,
];

/** Files that render to a LIVE shipping surface (served HTML / served text). */
function liveSurfaceFiles(): string[] {
  const out: string[] = [];
  // 1) Served static assets under frontend/public (e.g. llms.txt).
  const pub = join(FRONTEND, 'public');
  for (const name of safeReaddir(pub)) {
    const p = join(pub, name);
    if (statSync(p).isFile()) out.push(p);
  }
  // 2) The React source that renders live HTML (components + pages), excluding tests.
  for (const sub of ['src/components', 'src/pages']) {
    walk(join(FRONTEND, sub), (p) => {
      if (/\.(t|j)sx?$/.test(p) && !/\.test\.(t|j)sx?$/.test(p)) out.push(p);
    });
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function walk(dir: string, onFile: (p: string) => void): void {
  for (const name of safeReaddir(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, onFile);
    else onFile(p);
  }
}

describe('pre-launch: no live surface hard-links the not-yet-public repo (FC1.7 / F-003)', () => {
  const files = liveSurfaceFiles();

  it('finds live shipping surfaces to scan', () => {
    expect(files.length).toBeGreaterThan(0);
    // llms.txt is a key agent-discovery surface — make sure it's in scope.
    expect(files.some((f) => f.endsWith('llms.txt'))).toBe(true);
  });

  for (const file of files) {
    const rel = file.slice(FRONTEND.length + 1).replace(/\\/g, '/');
    it(`${rel} does not hard-link github.com/kychee-com/kysigned`, () => {
      const text = readFileSync(file, 'utf8');
      for (const re of FORBIDDEN) {
        const m = text.match(re);
        expect(
          m,
          `${rel} contains a pre-launch hard reference to the public repo: "${m?.[0]}". ` +
            `Soften it to forward-looking copy until the launch flip (task 20.8).`,
        ).toBeNull();
      }
    });
  }
});
