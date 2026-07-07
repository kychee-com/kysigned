/**
 * hashCheck.test.ts (F-25 / 29.2) — the /hashcheck original-document confirmation
 * core. Bundle mode (byte-exact A vs embedded document-original) + sign-request
 * mode (content-level normalize-and-compare, DD-20 — byte-exact reconstruction is
 * impossible per the 29.1 spike). Uses an INJECTED extractor so the test stays
 * Node-side; the real Node/web extractors are wired by callers (oracle, SPA).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { assembleCanonicalPdf } from '../pdf/assembleCanonicalPdf.js';
import { generateCoverPage } from '../pdf/coverPage.js';
import { checkOriginalInArtifact, normalizeDocPages, type ExtractMap } from './hashCheck.js';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function makeDoc(lines: string[], date = '2026-06-20T00:00:00Z'): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.setCreationDate(new Date(date));
  for (const l of lines) {
    const p = d.addPage([612, 792]);
    p.drawText(l, { x: 56, y: 720, size: 12 });
  }
  return new Uint8Array(await d.save({ useObjectStreams: false }));
}

async function makeCover(D: Uint8Array): Promise<Uint8Array> {
  return generateCoverPage(
    {
      documentName: 'Doc',
      senderEmail: 'creator@example.com',
      envelopeId: '11111111-2222-3333-4444-555555555555',
      sourceDocHash: sha(D),
      generatedAt: new Date('2026-06-20T10:00:00Z'),
      operatorDomain: 'kysigned.com',
      signerName: 'Alice',
      signerEmail: 'alice@example.com',
    },
    { width: 612, height: 792 },
  );
}

const emptyExtract: ExtractMap = async () => new Map();
const bundleExtract = (docOriginal: Uint8Array): ExtractMap => async () =>
  new Map([['document-original.pdf', docOriginal]]);

describe('hashCheck — original-document confirmation (F-25)', () => {
  it('bundle mode (byte-exact): matches when original == embedded document-original', async () => {
    const D = await makeDoc(['DOCUMENT BODY']);
    const r = await checkOriginalInArtifact(D, new Uint8Array([1, 2, 3]), bundleExtract(D));
    assert.equal(r.kind, 'bundle');
    assert.equal(r.guarantee, 'byte-exact');
    assert.equal(r.match, true);
    assert.equal(r.originalSha256, sha(D));
    assert.equal(r.foundSha256, sha(D));
  });

  it('bundle mode: mismatches when the embedded document differs from the original', async () => {
    const D = await makeDoc(['DOCUMENT BODY']);
    const D2 = await makeDoc(['A DIFFERENT DOCUMENT']);
    const r = await checkOriginalInArtifact(D2, new Uint8Array([9]), bundleExtract(D));
    assert.equal(r.kind, 'bundle');
    assert.equal(r.match, false);
    assert.equal(r.originalSha256, sha(D2));
    assert.equal(r.foundSha256, sha(D));
  });

  it('sign-request mode (content-level): matches the document inside cover ++ D', async () => {
    const D = await makeDoc(['AGREEMENT PAGE 1', 'AGREEMENT PAGE 2']);
    const Pi = await assembleCanonicalPdf(await makeCover(D), D);
    const r = await checkOriginalInArtifact(D, Pi, emptyExtract);
    assert.equal(r.kind, 'sign-request');
    assert.equal(r.guarantee, 'content-level');
    assert.equal(r.match, true);
  });

  it('sign-request match reports the NORMALIZED inner-document hash actually compared, not the raw file hash (F-25.3)', async () => {
    const D = await makeDoc(['AGREEMENT PAGE 1', 'AGREEMENT PAGE 2']);
    const Pi = await assembleCanonicalPdf(await makeCover(D), D);
    const r = await checkOriginalInArtifact(D, Pi, emptyExtract);
    assert.equal(r.match, true);
    // The displayed fingerprints are the content-level hashes that DECIDED the match
    // (the inner document with the cover removed) — equal on both sides on a match,
    // and NOT the raw sha256 of the file (which never took part in the comparison).
    const contentHash = sha(await normalizeDocPages(D));
    assert.equal(r.originalSha256, contentHash, 'original side = normalized content hash');
    assert.equal(r.foundSha256, contentHash, 'inner-document side = the same content hash');
    assert.notEqual(r.originalSha256, sha(D), 'must NOT be the raw file SHA-256');
  });

  it('sign-request mismatch surfaces both differing content hashes', async () => {
    const D = await makeDoc(['AGREEMENT']);
    const D2 = await makeDoc(['DIFFERENT AGREEMENT']);
    const Pi = await assembleCanonicalPdf(await makeCover(D), D);
    const r = await checkOriginalInArtifact(D2, Pi, emptyExtract);
    assert.equal(r.match, false);
    assert.ok(r.foundSha256, 'the inner-document content hash is still shown');
    assert.notEqual(r.originalSha256, r.foundSha256, 'the two content hashes differ');
  });

  it('sign-request mode: mismatches a different document behind the cover', async () => {
    const D = await makeDoc(['AGREEMENT']);
    const D2 = await makeDoc(['DIFFERENT AGREEMENT']);
    const Pi = await assembleCanonicalPdf(await makeCover(D), D);
    const r = await checkOriginalInArtifact(D2, Pi, emptyExtract);
    assert.equal(r.kind, 'sign-request');
    assert.equal(r.match, false);
  });

  it('sign-request match is stable across repeated calls (date-stripped normalization)', async () => {
    const D = await makeDoc(['X', 'Y']);
    const Pi = await assembleCanonicalPdf(await makeCover(D), D);
    const r1 = await checkOriginalInArtifact(D, Pi, emptyExtract);
    const r2 = await checkOriginalInArtifact(D, Pi, emptyExtract);
    assert.equal(r1.match, true);
    assert.equal(r2.match, true);
  });

  it('a non-PDF / unreadable artifact is reported unrecognized, never a false match', async () => {
    const D = await makeDoc(['DOC']);
    const r = await checkOriginalInArtifact(D, new Uint8Array([0, 1, 2, 3, 4]), emptyExtract);
    assert.equal(r.kind, 'unrecognized');
    assert.equal(r.match, false);
  });
});
