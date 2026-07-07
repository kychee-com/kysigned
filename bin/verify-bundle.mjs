#!/usr/bin/env node
/**
 * kysigned reference CLI verifier (F-10.2 / AC-29).
 *
 * Usage:  verify-bundle <bundle.pdf>
 *
 * Runs the documented F-10.3 algorithm over a bundle PDF and prints a human-first
 * verdict. Exit 0 = PROVEN, 1 = FAILED, 2 = usage/IO error. Offline by default:
 * DKIM verifies against the embedded keys.json; the RFC 3161 timestamp verifies
 * against its embedded TSA token; the OpenTimestamps Bitcoin anchor and the public
 * archive key-window join upgrade when online (the verdict notes pending checks).
 *
 * This is the canonical implementation of the algorithm; the web verifier (F-10.1)
 * runs the same engine client-side. kysigned is NOT in the trust set.
 */
import { readFileSync } from 'node:fs';
import { runVerifyCli } from '../dist/bundle/verifyCli.js';

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const path = args.find((a) => !a.startsWith('--'));
if (!path) {
  console.error('usage: verify-bundle [--offline] <bundle.pdf>');
  process.exit(2);
}

let bytes;
try {
  bytes = new Uint8Array(readFileSync(path));
} catch (err) {
  console.error(`cannot read ${path}: ${err.message}`);
  process.exit(2);
}

const { exitCode, report } = await runVerifyCli(bytes, { offline });
console.log(report);
process.exit(exitCode);
