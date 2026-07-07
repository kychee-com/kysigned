/**
 * F-3.3 / DD-9 (Family B) — per-signer canonical PDF + per-signer hash.
 *
 * Each signer signs their OWN canonical PDF `P_i = cover_i ++ D` (the shared
 * uploaded document). `H_D = sha256(D)` is the envelope fingerprint, identical
 * for every signer and cited on every cover; `sentPdfHash = sha256(P_i)` is
 * per-signer and is what that signer's forward must return byte-for-byte (F-6.4).
 * Assembly is deterministic (F-4.3) so the verifier can reconstruct `P_i` (F-10.3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { buildSignerCanonicalPdf, type SignerCanonicalInput } from './perSignerCanonical.ts';
import { assembleCanonicalPdf } from './assembleCanonicalPdf.ts';

const FIXED_DATE = new Date('2026-06-17T12:00:00.000Z');

async function makeMockSource(
  pageCount: number,
  size: [number, number] = [612, 792],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage(size).drawText(`Doc page ${i + 1}`, { x: 72, y: 720 });
  }
  doc.setTitle(`Mock doc ${pageCount}p`);
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setProducer('mock-source-generator');
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

function baseInput(overrides: Partial<SignerCanonicalInput> = {}): SignerCanonicalInput {
  return {
    documentName: 'NDA — Acme Corp',
    senderEmail: 'contracts@acme.com',
    envelopeId: '16883542-30c8-4237-b961-1e188a797903',
    generatedAt: FIXED_DATE,
    operatorDomain: 'kysigned.com',
    sourceDocHash: 'a'.repeat(64), // H_D, supplied by the caller (= sha256(D))
    signerName: 'Alice Smith',
    signerEmail: 'alice@example.com',
    ...overrides,
  };
}

describe('buildSignerCanonicalPdf — Family B per-signer canonical PDF (DD-9)', () => {
  it('is deterministic — same signer + same D → byte-identical P_i and sentPdfHash', async () => {
    const D = await makeMockSource(2);
    const a = await buildSignerCanonicalPdf(baseInput(), D);
    const b = await buildSignerCanonicalPdf(baseInput(), D);
    assert.equal(Buffer.from(a.pdf).toString('hex'), Buffer.from(b.pdf).toString('hex'));
    assert.equal(a.sentPdfHash, b.sentPdfHash);
  });

  it('#110: a Hebrew-named P_i is deterministic AND reconstructs byte-exact from the stored cover (verifier path → PROVEN)', async () => {
    // The verifier (verify.ts / verifyWeb.ts / verifyCli.ts) byte-MERGES the STORED
    // cover with D — assembleCanonicalPdf(coverBytes, docBytes) — and never re-renders
    // the cover, so a non-Latin cover reconstructs P_i byte-exact and its hash still
    // equals sentPdfHash. This is the load-bearing #110 property: the embedded font
    // never enters the verify path; only the stored bytes do.
    const D = await makeMockSource(2);
    const input = baseInput({ documentName: 'הסכם סודיות', signerName: 'דוד כהן', signerEmail: 'david@example.co.il' });
    const a = await buildSignerCanonicalPdf(input, D);
    const b = await buildSignerCanonicalPdf(input, D);
    assert.equal(a.sentPdfHash, b.sentPdfHash, 'Hebrew-named P_i is byte-deterministic');
    const reconstructed = await assembleCanonicalPdf(a.cover, D); // exactly what the verifier does
    assert.equal(
      createHash('sha256').update(Buffer.from(reconstructed)).digest('hex'),
      a.sentPdfHash,
      'reconstruct(storedCover, D) == P_i for a Hebrew name → verifier returns PROVEN',
    );
  });

  it('two different signers of the same envelope → different P_i and different sentPdfHash', async () => {
    const D = await makeMockSource(2);
    const alice = await buildSignerCanonicalPdf(baseInput({ signerName: 'Alice Smith', signerEmail: 'alice@example.com' }), D);
    const bob = await buildSignerCanonicalPdf(baseInput({ signerName: 'Bob Jones', signerEmail: 'bob@example.com' }), D);
    assert.notEqual(Buffer.from(alice.pdf).toString('hex'), Buffer.from(bob.pdf).toString('hex'), 'per-signer covers → different P_i');
    assert.notEqual(alice.sentPdfHash, bob.sentPdfHash, 'per-signer sentPdfHash');
  });

  it('sentPdfHash = SHA-256 of exactly the P_i bytes (64-hex)', async () => {
    const D = await makeMockSource(1);
    const { pdf, sentPdfHash } = await buildSignerCanonicalPdf(baseInput(), D);
    const recomputed = createHash('sha256').update(Buffer.from(pdf)).digest('hex');
    assert.equal(sentPdfHash, recomputed);
    assert.match(sentPdfHash, /^[0-9a-f]{64}$/);
  });

  it('P_i = cover (1 page) ++ the full shared document D', async () => {
    // Proves the composer prepends exactly a one-page cover to the WHOLE D — the
    // per-signer difference is confined to the cover; D is shared verbatim. (That
    // the cover cites H_D is asserted at the cover layer, coverPage.test.ts.)
    const D = await makeMockSource(3);
    const { pdf } = await buildSignerCanonicalPdf(baseInput(), D);
    const doc = await PDFDocument.load(pdf);
    assert.equal(doc.getPageCount(), 1 + 3, 'cover (1) + D (3) = 4 pages');
  });

  it('the cover adopts the source document page size — A4 source ⇒ A4 cover (#33)', async () => {
    // The cover must be a natural part of the PDF, not a mismatched Letter sheet
    // in front of an A4 document. Page 1 (the cover) must match D's page size.
    const A4: [number, number] = [595, 842];
    const D = await makeMockSource(2, A4);
    const { pdf } = await buildSignerCanonicalPdf(baseInput(), D);
    const doc = await PDFDocument.load(pdf);
    const cover = doc.getPage(0).getSize();
    assert.equal(Math.round(cover.width), 595, 'cover width matches A4 source');
    assert.equal(Math.round(cover.height), 842, 'cover height matches A4 source');
  });
});
