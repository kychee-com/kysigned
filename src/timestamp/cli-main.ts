/**
 * Process/bin adapter for the timestamp CLI — F-9.
 * Run locally: `npx tsx src/timestamp/cli-main.ts <args>` (a dev/test harness).
 *
 * Only executes when run directly (no module imports it), so it never runs during
 * `npm test`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { runCli, type CliFs } from './cli.js';

const fs: CliFs = {
  async readFile(p) {
    return new Uint8Array(await readFile(p));
  },
  async writeFile(p, d) {
    await writeFile(p, d);
  },
};

async function readVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const { code, out, err } = await runCli(process.argv.slice(2), { fs, version: await readVersion() });
if (out) process.stdout.write(out);
if (err) process.stderr.write(err);
process.exit(code);
