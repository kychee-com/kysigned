/**
 * Extractor round-trip test (F-10.3) — assemble → extract returns the embedded
 * evidence byte-identical to what the manifest embedded. Validates that the
 * verifier reads exactly what the assembler wrote.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { PDFDocument } from 'pdf-lib';
import { assembleBundle } from './assembleBundle.js';
import { extractEmbeddedFileMap } from './extract.js';
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

describe('extractEmbeddedFiles — round-trips the assembler output', () => {
  it('returns all five embedded classes byte-identical to the manifest', async () => {
    const documentOriginal = await makeDoc();
    const input: AssembleBundleInput = {
      envelope: {
        id: '18267982-ca76-45dc-a294-e86039a6343d',
        documentName: 'NDA',
        documentHash: 'd'.repeat(64),
        creatorEmail: 'creator@acme.com',
        completedAt: new Date('2026-06-14T12:00:00Z'),
      },
      documentOriginal,
      signers: [signer(1), signer(2)],
      verifierBaseUrl: 'https://kysigned.com',
    };
    const { bytes, manifest } = await assembleBundle(input);

    const extracted = await extractEmbeddedFileMap(bytes);

    // Every embedded file comes back, byte-identical to what was embedded.
    for (const f of manifest) {
      const got = extracted.get(f.path);
      assert.ok(got, `extracted ${f.path}`);
      assert.deepEqual(got, f.bytes, `${f.path} byte-identical`);
    }
    // The five classes are all present.
    assert.ok(extracted.has('document-original.pdf'));
    assert.ok(extracted.has('signer-1.eml'));
    assert.ok(extracted.has('signer-2.eml'));
    assert.ok(extracted.has('proofs/signer-1.ots'));
    assert.ok(extracted.has('keys.json'));
    assert.ok(extracted.has('VERIFY-README.txt'));
  });
});
