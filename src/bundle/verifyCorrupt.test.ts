/**
 * F-007-obs (system-test Fix Cycle 1) — a bundle whose embedded compressed stream
 * is CORRUPTED must produce a graceful, NAMED "FAILED" verdict from every engine,
 * never an uncaught throw. Previously the unguarded decompress (`inflateSync` /
 * DecompressionStream) let a `Z_DATA_ERROR` crash the verifier (500 / stack trace)
 * instead of surfacing a verdict via the existing `BundleVerdict.errors[]` channel.
 *
 * The three engines share one bundle layout, so one corrupted fixture covers all:
 *   - Node    (`verifyBundle`)              — node:zlib inflateSync
 *   - Web     (`verifyBundleWeb`)           — DecompressionStream
 *   - Toolkit (`verifyBundleIndependently`) — the independent reproduction (F-26)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream } from 'pdf-lib';
import { assembleBundle } from './assembleBundle.js';
import { verifyBundle } from './verify.js';
import { verifyBundleWeb } from './verifyWeb.js';
import { verifyBundleIndependently } from '../../scripts/verification-tools/verify-independent.mjs';
import type { AssembleBundleInput, BundleSignerInput } from './types.js';
import type { TimestampProof } from '../timestamp/contract.js';

function proof(p: string, raw: string): TimestampProof {
  return { provider: p, version: 1, status: 'complete', data: Buffer.from(raw).toString('base64') };
}

function signer(index: number): BundleSignerInput {
  return {
    index,
    name: `Signer ${index}`,
    email: `s${index}@example.com`,
    onBehalfOf: null,
    signingDomain: 'example.com',
    selector: 'test',
    signedAt: new Date('2026-06-14T10:00:00Z'),
    emlSha256: 'a'.repeat(64),
    rawEml: new Uint8Array(Buffer.from(`From: s${index}@example.com\r\n\r\nI sign this document\r\nUNIQUE-${index}\r\n`)),
    cover: new Uint8Array(Buffer.from(`%PDF-cover-${index}\n`)),
    dkimKey: 'v=DKIM1; k=rsa; p=AAAB',
    dkimObservedAt: new Date('2026-06-14T10:00:01Z'),
    archiveStatus: 'archived',
    otsProof: proof('ots', `ots-${index}`),
    tsaToken: proof('rfc3161', `tsr-${index}`),
    verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' },
  };
}

async function makeDoc(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.setCreationDate(new Date('2026-06-14T00:00:00Z'));
  d.setModificationDate(new Date('2026-06-14T00:00:00Z'));
  d.addPage([612, 792]).drawText('canonical document');
  return new Uint8Array(await d.save({ useObjectStreams: false }));
}

/** Walk the /EmbeddedFiles name tree and return the first embedded-file raw stream. */
function firstEmbeddedStream(node: PDFDict): PDFRawStream | null {
  const names = node.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (names) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      const spec = names.lookupMaybe(i + 1, PDFDict);
      const ef = spec?.lookupMaybe(PDFName.of('EF'), PDFDict);
      const s = ef?.lookup(PDFName.of('F'));
      if (s instanceof PDFRawStream) return s;
    }
  }
  const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (kids) {
    for (let i = 0; i < kids.size(); i++) {
      const kid = kids.lookupMaybe(i, PDFDict);
      if (kid) {
        const r = firstEmbeddedStream(kid);
        if (r) return r;
      }
    }
  }
  return null;
}

/**
 * Replace the first embedded FlateDecode stream's contents with same-length
 * non-deflate garbage (leaving `/Filter /FlateDecode` + the PDF object structure
 * intact), so the bundle still PARSES but the embedded-file decompress throws
 * `incorrect header check` (Z_DATA_ERROR) — the exact F-007-obs crash. Same length
 * keeps `/Length` valid, so `rawEmbeddedEntries` reads the corrupted bytes.
 */
async function corruptFirstEmbeddedStream(pdf: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { throwOnInvalidObject: false });
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const efTree = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  assert.ok(efTree, 'fixture must have an /EmbeddedFiles tree');
  const target = firstEmbeddedStream(efTree);
  assert.ok(target, 'fixture must have at least one embedded FlateDecode stream');
  (target as unknown as { contents: Uint8Array }).contents = new Uint8Array(target.contents.length).fill(0xff);
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

describe('bundle verifier — raw compressed-stream corruption → graceful FAILED, not a crash (F-007-obs)', () => {
  let corrupted: Uint8Array;

  before(async () => {
    const input: AssembleBundleInput = {
      envelope: {
        id: '18267982-ca76-45dc-a294-e86039a6343d',
        documentName: 'NDA',
        documentHash: 'd'.repeat(64),
        creatorEmail: 'creator@acme.com',
        completedAt: new Date('2026-06-14T12:00:00Z'),
      },
      documentOriginal: await makeDoc(),
      signers: [signer(1), signer(2)],
      verifierBaseUrl: 'https://kysigned.com',
    };
    const { bytes } = await assembleBundle(input);
    corrupted = await corruptFirstEmbeddedStream(bytes);
  });

  it('Node engine (verifyBundle) → proven:false + a named decompress error, no throw', async () => {
    const v = await verifyBundle(corrupted);
    assert.equal(v.proven, false);
    assert.ok(
      v.errors.some((e) => /damaged|decompress/i.test(e)),
      `expected a named decompress error, got ${JSON.stringify(v.errors)}`,
    );
  });

  it('Web engine (verifyBundleWeb) → proven:false + a named decompress error, no throw', async () => {
    const v = await verifyBundleWeb(corrupted);
    assert.equal(v.proven, false);
    assert.ok(
      v.errors.some((e) => /damaged|decompress/i.test(e)),
      `expected a named decompress error, got ${JSON.stringify(v.errors)}`,
    );
  });

  it('Independent tool (verifyBundleIndependently) → proven:false + a named decompress error, no throw', async () => {
    const v = await verifyBundleIndependently(corrupted);
    assert.equal(v.proven, false);
    assert.ok(
      v.errors.some((e: string) => /damaged|decompress/i.test(e)),
      `expected a named decompress error, got ${JSON.stringify(v.errors)}`,
    );
  });
});
