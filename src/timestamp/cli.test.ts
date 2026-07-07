import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from './cli.js';
import { createFakeProvider } from './fake.js';

const providers = { fake: createFakeProvider({ timeSec: 1700000000 }) };
const HEX = '11'.repeat(32); // 64 hex chars = 32 bytes
const deps = { providers, defaultProvider: 'fake', version: '9.9.9' };

describe('CLI skeleton (AC-19 provider select, AC-20 help/version/bad-input)', () => {
  it('--version prints the version and exits 0', async () => {
    const r = await runCli(['--version'], deps);
    assert.equal(r.code, 0);
    assert.match(r.out, /9\.9\.9/);
  });

  it('--help and no-args print usage and exit 0', async () => {
    for (const argv of [['--help'], [] as string[]]) {
      const r = await runCli(argv, deps);
      assert.equal(r.code, 0);
      assert.match(r.out, /Usage/);
    }
  });

  it('unknown command exits non-zero with a message', async () => {
    const r = await runCli(['frobnicate'], deps);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /unknown command/i);
  });

  it('unknown provider exits non-zero with a message', async () => {
    const r = await runCli(['--provider', 'bogus', 'stamp', HEX], deps);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /provider/i);
  });

  it('malformed hash input exits non-zero', async () => {
    const r = await runCli(['stamp', 'nothex'], deps);
    assert.notEqual(r.code, 0);
  });

  it('stamp with a selected provider prints a proof (provider is selectable)', async () => {
    const r = await runCli(['--provider', 'fake', 'stamp', HEX], deps);
    assert.equal(r.code, 0);
    const proof = JSON.parse(r.out);
    assert.equal(proof.provider, 'fake');
  });

  it('stamp → verify round-trips through the CLI', async () => {
    const s = await runCli(['--provider', 'fake', 'stamp', HEX], deps);
    const v = await runCli(['--provider', 'fake', 'verify', s.out.trim(), HEX], deps);
    assert.equal(v.code, 0);
    assert.match(v.out, /"ok":true/);
  });

  it('a missing required argument gives a clear "missing argument" error (TR-001)', async () => {
    const cases: string[][] = [
      ['stamp'],
      ['verify'],
      ['verify', '{"provider":"fake","version":1,"status":"complete","data":""}'],
      ['upgrade'],
    ];
    for (const argv of cases) {
      const r = await runCli(argv, deps);
      assert.notEqual(r.code, 0, `${argv.join(' ')} should exit non-zero`);
      assert.match(r.err, /missing argument/i, `${argv.join(' ')} → ${r.err}`);
      assert.doesNotMatch(r.err, /ENOENT/, `${argv.join(' ')} must not leak an ENOENT`);
    }
  });
});
