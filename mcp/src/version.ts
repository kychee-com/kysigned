/**
 * version — the single source of truth for the server version, read from
 * package.json at runtime so the McpServer version, `--version`, and the
 * startup banner can never drift from the published npm version (#125).
 * Resolves `../package.json` relative to this module, which holds in both
 * `src/` (tsx) and the built `dist/`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();
