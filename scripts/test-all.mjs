#!/usr/bin/env node

/**
 * Orchestrates all test suites for kysigned.
 * - Unit always runs.
 * - E2E + smoke run only when BASE_URL is set (they need a live server).
 * Exits non-zero on the first suite failure.
 */

import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function buildSuiteList(baseUrl) {
  const suites = [
    { name: 'unit', command: 'npm run test' },
  ];

  if (baseUrl) {
    suites.push(
      { name: 'e2e', command: 'npm run test:e2e' },
      { name: 'smoke', command: 'npm run test:e2e:smoke' },
    );
  }

  return suites;
}

// Only run when executed directly (not imported by tests). pathToFileURL is
// the cross-platform idiom — hand-building the file:/// URL breaks on posix
// (leading / doubles up), silently no-opping the whole runner on Linux CI.
const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMainModule) {
  const suites = buildSuiteList(process.env.BASE_URL);

  if (!process.env.BASE_URL) {
    console.log('ℹ BASE_URL not set — skipping e2e and smoke suites.\n');
  }

  for (const suite of suites) {
    console.log(`\n▶ Running ${suite.name} suite: ${suite.command}\n`);
    try {
      execSync(suite.command, { stdio: 'inherit', cwd: process.cwd() });
      console.log(`\n✓ ${suite.name} suite passed.\n`);
    } catch (err) {
      console.error(`\n✗ ${suite.name} suite FAILED.\n`);
      process.exit(1);
    }
  }

  console.log('\n✓ All suites passed.\n');
}
