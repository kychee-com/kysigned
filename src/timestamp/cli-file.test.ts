import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, type CliFs } from './cli.js';
import { createFakeProvider } from './fake.js';

function memFs(seed: Record<string, Uint8Array> = {}): { fs: CliFs; store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>(Object.entries(seed));
  return {
    store,
    fs: {
      async readFile(p) {
        const v = store.get(p);
        if (!v) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      async writeFile(p, d) {
        store.set(p, d);
      },
    },
  };
}

const providers = { fake: createFakeProvider({ timeSec: 1700000000 }) };
const deps = (fs: CliFs) => ({ providers, defaultProvider: 'fake', version: '1.0.0', fs });

describe('CLI file UX (AC-18 — stamp/verify a file, write a proof artifact)', () => {
  it('stamp <file> hashes the file and writes a .tsproof artifact', async () => {
    const { fs, store } = memFs({ 'doc.txt': Buffer.from('hello world') });
    const r = await runCli(['stamp', 'doc.txt'], deps(fs));
    assert.equal(r.code, 0, r.err);
    assert.ok(store.has('doc.txt.tsproof'));
    const proof = JSON.parse(Buffer.from(store.get('doc.txt.tsproof')!).toString());
    assert.equal(proof.provider, 'fake');
  });

  it('verify <proof-file> <data-file> validates the stamped file', async () => {
    const { fs } = memFs({ 'doc.txt': Buffer.from('hello world') });
    await runCli(['stamp', 'doc.txt'], deps(fs));
    const r = await runCli(['verify', 'doc.txt.tsproof', 'doc.txt'], deps(fs));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /"ok":true/);
  });

  it('verify fails when the data file does not match the proof', async () => {
    const { fs } = memFs({ 'doc.txt': Buffer.from('hello world'), 'other.txt': Buffer.from('different') });
    await runCli(['stamp', 'doc.txt'], deps(fs));
    const r = await runCli(['verify', 'doc.txt.tsproof', 'other.txt'], deps(fs));
    assert.notEqual(r.code, 0);
  });
});
