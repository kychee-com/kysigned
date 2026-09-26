// Verification stays on the holder's machine (plan 83.2, F-47.5, AC-303): the built
// command runs under a network guard (network-guard.mjs, preloaded) that records every
// attempt and answers none. Offline makes no attempt at all; online reaches only the
// verifier's two additive indicators (the OpenTimestamps calendars and a Bitcoin block
// source, and the public key archive, directly, never an operator), sends no bundle
// bytes, and still returns the offline verdict with both indicators pending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = join(HERE, '..');
const BIN = join(CLI_DIR, 'dist', 'kysigned.mjs');
const LIB = join(CLI_DIR, 'dist', 'index.js');
const GUARD = pathToFileURL(join(HERE, 'network-guard.mjs')).href;
const ASSETS = join(CLI_DIR, '..', 'docs', 'test-assets');
const GENUINE = join(ASSETS, 'acme-anvil-waiver-signed-bundle.pdf');
const TAMPERED = join(ASSETS, 'sample-bundle-tampered-doc.pdf');

/** The hosts the verifier's two indicators may reach (F-10.6, F-10.7, F-10.8). */
const ALLOWED_HOST = /(^|\.)(opentimestamps\.org|eternitywall\.com|blockstream\.info|mempool\.space|archive\.prove\.email)$/;

function guarded(args) {
  const dir = mkdtempSync(join(tmpdir(), 'kysigned-netlog-'));
  const log = join(dir, 'net.jsonl');
  try {
    const r = spawnSync(process.execPath, ['--import', GUARD, BIN, ...args], {
      encoding: 'utf8',
      env: { ...process.env, KYSIGNED_NETLOG: log },
    });
    const attempts = existsSync(log)
      ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return { code: r.status, out: r.stdout, err: r.stderr, attempts };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A few windows of the bundle's own bytes, as they would appear in a request body. */
function bundleMarkers(file) {
  const b64 = readFileSync(file).toString('base64');
  return [0.25, 0.5, 0.75].map((f) => b64.slice(Math.floor(b64.length * f), Math.floor(b64.length * f) + 64));
}

test('offline: no network attempt at all, and the verdict comes back with both indicators pending', () => {
  for (const [file, exit] of [[GENUINE, 0], [TAMPERED, 1]]) {
    const r = guarded(['verify', '--offline', '--json', file]);
    assert.deepEqual(r.attempts, [], `${file}: offline made a network attempt`);
    assert.equal(r.code, exit, r.err);
    const doc = JSON.parse(r.out);
    for (const s of doc.signers) {
      assert.equal(s.checks.keyAuthenticity, 'pending-online');
      assert.ok(['pending', 'absent'].includes(s.bitcoinAnchor.status), `bitcoin anchor ${s.bitcoinAnchor.status}`);
    }
  }
});

test('online: only the indicator hosts, no bundle bytes, never an operator; the verdict still holds', () => {
  const r = guarded(['verify', '--json', GENUINE]);
  assert.ok(r.attempts.length > 0, 'the guard saw no attempt: the online indicators did not run, so this test proves nothing');
  const markers = bundleMarkers(GENUINE);
  for (const a of r.attempts) {
    assert.equal(a.kind, 'fetch', `a ${a.kind} attempt outside fetch: ${a.detail}`);
    const host = new URL(a.url).hostname;
    assert.match(host, ALLOWED_HOST, `request to ${host} (${a.url})`);
    assert.ok(a.bodyLength < 4096, `${a.url} sent ${a.bodyLength} bytes`);
    const body = Buffer.from(a.bodyBase64, 'base64');
    assert.ok(!body.includes('%PDF'), `${a.url} sent PDF bytes`);
    for (const m of markers) assert.ok(!a.bodyBase64.includes(m) && !body.toString('latin1').includes(m), `${a.url} sent the bundle`);
  }
  assert.equal(r.code, 0, r.err);
  const doc = JSON.parse(r.out);
  assert.equal(doc.offline, false);
  for (const s of doc.signers) assert.equal(s.checks.keyAuthenticity, 'pending-online', 'an unreachable archive reads as pending, never an error');
});

test('the library, offline, makes no fetch in the caller\'s own process', async () => {
  const { verifyBundleBytes } = await import(pathToFileURL(LIB).href);
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input instanceof Request ? input.url : input));
    throw new TypeError('fetch failed (test)');
  };
  try {
    const out = await verifyBundleBytes(new Uint8Array(readFileSync(GENUINE)), { offline: true });
    assert.equal(out.exitCode, 0);
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(calls, []);
});
