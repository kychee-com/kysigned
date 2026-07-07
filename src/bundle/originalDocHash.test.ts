/**
 * originalDocHash.test.ts (F-10.9 / AC-105) — the verifier surfaces the original
 * document hash A = SHA-256(document-original.pdf) in the verdict, per signer and
 * once for the envelope, identical across signers, and IDENTICAL between the Node
 * and browser engines (differential parity for AC-107).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyBundle } from './verify.js';
import { verifyBundleWeb } from './verifyWeb.js';
import { extractEmbeddedFileMap } from './extract.js';
import { formatVerdict } from './verifyCli.js';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'test-assets');
const load = (n: string) => new Uint8Array(readFileSync(join(ASSETS, n)));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('original-document hash A surfaced in the verdict (F-10.9 / AC-105)', () => {
  it('Node engine: A = sha256(document-original), per signer + envelope, identical across signers', async () => {
    const bundle = load('sample-bundle.pdf');
    const A = sha((await extractEmbeddedFileMap(bundle)).get('document-original.pdf')!);
    const v = await verifyBundle(bundle);
    assert.equal(v.originalDocSha256, A, 'envelope A');
    assert.equal(v.signers.length, 2);
    for (const s of v.signers) assert.equal(s.originalDocSha256, A, `signer ${s.index} A`);
  });

  it('web engine produces the IDENTICAL A (differential parity)', async () => {
    const bundle = load('sample-bundle.pdf');
    const vn = await verifyBundle(bundle);
    const vw = await verifyBundleWeb(bundle);
    assert.equal(vw.originalDocSha256, vn.originalDocSha256, 'envelope A matches across engines');
    assert.deepEqual(
      vw.signers.map((s) => s.originalDocSha256),
      vn.signers.map((s) => s.originalDocSha256),
      'per-signer A matches across engines',
    );
  });

  it('CLI formatVerdict surfaces the original-doc hash labelled SHA-256, never the internal "A"', async () => {
    const v = await verifyBundle(load('sample-bundle.pdf'));
    const out = formatVerdict(v);
    assert.ok(out.includes(`Original document (SHA-256): ${v.originalDocSha256}`), 'original-doc hash line, labelled SHA-256');
    assert.ok(!/Original document A|Original document \(A\)|document A:/.test(out), 'no internal "A" label in the report');
  });
});
