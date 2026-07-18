#!/usr/bin/env node
/**
 * test-live.mjs — the LIVE E2E test tier.
 *
 * kysigned's suites split into two tiers, deliberately:
 *
 *   MANDATORY (hermetic) — `npm test`, `npm run test:docs`, the frontend and mcp
 *     suites. Deterministic, no third-party network, must be green on every run.
 *     These gate every commit and every publish.
 *
 *   LIVE E2E (this script) — the tests that deliberately hit REAL third parties:
 *     archive.prove.email (the provider-key gate) and the OpenTimestamps calendars
 *     plus a real Bitcoin anchor. They are env-gated (`KYSIGNED_ONLINE_E2E=1`) so a
 *     third party being down can never turn the mandatory tier red, and so the
 *     hermetic tier stays reproducible offline.
 *
 * Gated does NOT mean optional: this tier runs in the /publish pre-flight and proves
 * the two claims no hermetic test can — a genuine bundle really does reach PROVEN
 * (DURABLE) against the real archive + chain, and the forged-key fixture really is
 * REJECTED by the real archive. Run it whenever verifier behaviour changes.
 *
 * A cross-platform runner rather than an inline env var: bare `VAR=1 node …` in an
 * npm script fails under Windows cmd, and adding cross-env for one line is not worth
 * a dependency.
 *
 * Run:  npm run test:live
 */
import { spawn } from 'node:child_process';

const FILES = [
  'src/bundle/signedFixture.test.ts', // genuine bundle → PROVEN (DURABLE) online
  'src/bundle/forgedKeyFixture.test.ts', // #136 forgery → FAILED by the real archive gate
];

const child = spawn(
  process.execPath,
  ['--test', '--import', 'tsx', ...FILES],
  { stdio: 'inherit', env: { ...process.env, KYSIGNED_ONLINE_E2E: '1' } },
);

child.on('exit', (code) => process.exit(code ?? 1));
