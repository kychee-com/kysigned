#!/usr/bin/env node
/**
 * index — the kysigned-mcp executable bin. Kept tiny and SEPARATE from the
 * importable server (`server.ts`) so it can ALWAYS start the stdio server with
 * no is-main guard: the guard used to compare `import.meta.url` to
 * `pathToFileURL(process.argv[1])`, which diverges when the package bin is
 * invoked through an npm-generated symlink (`npx` / `node_modules/.bin`), so
 * the server never started and MCP hosts saw "Connection closed" (#126).
 * Nothing imports this file — importers use `server.ts` — so it runs stdio
 * unconditionally.
 *
 * Also provides human-facing CLI diagnostics for first-run config (#125):
 * --help, --version, a masked stderr startup banner, and `doctor`.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { server, getEndpoint } from './server.js';
import { VERSION } from './version.js';

function maskedAuth(): string {
  const a = process.env.KYSIGNED_AUTHORIZATION;
  if (!a || !a.trim()) return 'unset';
  const t = a.trim();
  return t.length <= 8 ? 'set' : `${t.slice(0, 4)}…${t.slice(-4)}`;
}

const HELP = `kysigned-mcp ${VERSION} — MCP server for kysigned (self-verifying e-signatures)

Usage:
  kysigned-mcp            start the stdio MCP server (how an MCP host launches it)
  kysigned-mcp --help     show this help
  kysigned-mcp --version  print the version
  kysigned-mcp doctor     check endpoint URL, auth presence, and /v1/health reachability

Environment:
  KYSIGNED_ENDPOINT       the kysigned instance (default https://kysigned.com)
  KYSIGNED_AUTHORIZATION  a creator API key (ksk_…); mint one at <endpoint>/account/api-keys

MCP host config example:
  {
    "command": "npx",
    "args": ["-y", "kysigned-mcp"],
    "env": { "KYSIGNED_ENDPOINT": "https://kysigned.com", "KYSIGNED_AUTHORIZATION": "ksk_…" }
  }
`;

async function doctor(): Promise<number> {
  const endpoint = getEndpoint();
  let ok = true;
  process.stdout.write(`kysigned-mcp ${VERSION} doctor\n`);
  process.stdout.write(`  endpoint: ${endpoint}\n`);
  try {
    // eslint-disable-next-line no-new
    new URL(endpoint);
    process.stdout.write('  endpoint URL: valid\n');
  } catch {
    process.stdout.write('  endpoint URL: INVALID\n');
    ok = false;
  }
  if (maskedAuth() === 'unset') {
    process.stdout.write('  auth: MISSING — set KYSIGNED_AUTHORIZATION (mint a key at <endpoint>/account/api-keys)\n');
    ok = false;
  } else {
    process.stdout.write(`  auth: present (${maskedAuth()})\n`);
  }
  try {
    const res = await fetch(`${endpoint}/v1/health`);
    process.stdout.write(`  /v1/health: ${res.ok ? `reachable (${res.status})` : `HTTP ${res.status}`}\n`);
    if (!res.ok) ok = false;
  } catch (e) {
    process.stdout.write(`  /v1/health: UNREACHABLE (${e instanceof Error ? e.message : 'error'})\n`);
    ok = false;
  }
  return ok ? 0 : 1;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes('--version') || args.includes('-V')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.includes('doctor')) {
    process.exitCode = await doctor();
    return;
  }
  // Normal startup: one masked banner to STDERR (stdout stays clean for MCP stdio).
  process.stderr.write(`kysigned-mcp ${VERSION} endpoint=${getEndpoint()} auth=${maskedAuth()}\n`);
  await server.connect(new StdioServerTransport());
}

run().catch((err) => {
  console.error('kysigned-mcp failed to start:', err);
  process.exit(1);
});
