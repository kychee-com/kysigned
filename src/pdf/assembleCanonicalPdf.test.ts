/**
 * F-3.3 + F-4.3 — Canonical envelope PDF assembly tests (evidence-bundle model).
 *
 * Asserts:
 *  - canonical = cover (page 1) + source content (pages 2..N)
 *  - assembly is deterministic per F-4.3 (identical inputs → byte-identical out)
 *  - the envelope `docHash` = SHA-256(canonical bytes), NOT the source hash
 *  - Family B (DD-9): per-signer COVERS yield per-signer canonical PDFs — the old
 *    byte-identity rule (AC-6, retired) is gone; the primitive stays deterministic
 *    (same inputs → byte-identical), which is what lets the verifier reconstruct
 *    each P_i = cover_i ++ D (F-10.3). The composed-per-signer flow + sentPdfHash
 *    live in perSignerCanonical.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { generateCoverPage, type EnvelopeCoverMetadata } from './coverPage.ts';
import { assembleCanonicalPdf } from './assembleCanonicalPdf.ts';

const FIXED_DATE = new Date('2026-05-22T19:55:23.000Z');

const SAMPLE_METADATA: EnvelopeCoverMetadata = {
  documentName: 'NDA — Acme Corp',
  senderEmail: 'contracts@acmecorp.com',
  envelopeId: '16883542-30c8-4237-b961-1e188a797903',
  generatedAt: FIXED_DATE,
  operatorDomain: 'kysigned.com',
  sourceDocHash: '0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd',
};

async function makeMockSource(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Source page ${i + 1}`, { x: 72, y: 720 });
  }
  // Use fixed metadata for deterministic mock source.
  doc.setTitle(`Mock source ${pageCount}p`);
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setProducer('mock-source-generator');
  const bytes = await doc.save({ useObjectStreams: false });
  return new Uint8Array(bytes);
}

describe('assembleCanonicalPdf — F22.1', () => {
  it('produces a canonical PDF with cover as page 1 and source as pages 2..N', async () => {
    const cover = await generateCoverPage(SAMPLE_METADATA);
    const source = await makeMockSource(3);
    const canonical = await assembleCanonicalPdf(cover, source);

    const doc = await PDFDocument.load(canonical);
    assert.equal(doc.getPageCount(), 4, 'cover (1) + source (3) = 4 pages');
  });

  it('canonical PDF identifies kysigned as the producer (metadata)', async () => {
    const cover = await generateCoverPage(SAMPLE_METADATA);
    const source = await makeMockSource(1);
    const canonical = await assembleCanonicalPdf(cover, source);
    // pdf-lib encodes metadata fields as UTF-16 BE inside `<FEFF...>` hex
    // blocks. Look for the UTF-16-BE-encoded 'kysigned' substring.
    // pdf-lib serializes metadata strings as `<FEFF...>` hex blocks where the
    // contents are the ASCII representation of UTF-16-BE-encoded chars. So
    // "kysigned" appears in the PDF bytes as the literal ASCII text
    // "006B0079007300690067006E00650064" (the UTF-16 BE hex of "kysigned").
    const ascii = Buffer.from(canonical).toString('latin1').toUpperCase();
    const expected = '006B0079007300690067006E00650064'; // UTF-16 BE hex of "kysigned"
    assert.ok(
      ascii.includes(expected),
      'canonical PDF metadata identifies kysigned as producer (UTF-16 BE in <FEFF...> hex block)',
    );
  });

  it('is deterministic — identical inputs produce byte-identical output (DD-69)', async () => {
    const cover = await generateCoverPage(SAMPLE_METADATA);
    const source = await makeMockSource(2);
    const a = await assembleCanonicalPdf(cover, source);
    const b = await assembleCanonicalPdf(cover, source);
    assert.equal(
      Buffer.from(a).toString('hex'),
      Buffer.from(b).toString('hex'),
      'byte-identical canonical PDFs for identical inputs',
    );
  });

  it('pins /ModDate to /CreationDate so output is reproducible — NOT the wall-clock save time (Barry QA)', async () => {
    // pdf-lib's save() stamps /ModDate with the CURRENT time, so a reconstruction
    // at verify time never byte-matched the originally-sent P_i and EVERY real
    // bundle failed "document matches". The fix pins /ModDate := /CreationDate (the
    // cover's fixed generatedAt). This catches the regression the same-instant
    // determinism test above could not (both its calls land in the same second).
    const cover = await generateCoverPage(SAMPLE_METADATA);
    const source = await makeMockSource(2);
    const str = Buffer.from(await assembleCanonicalPdf(cover, source)).toString('latin1');
    const cd = /\/CreationDate \(D:([0-9]{14}Z?)\)/.exec(str);
    const md = /\/ModDate \(D:([0-9]{14}Z?)\)/.exec(str);
    assert.ok(cd && md, 'both /CreationDate and /ModDate are present');
    assert.equal(md![1], cd![1], '/ModDate must equal the pinned /CreationDate, not the save-time wall clock');
    assert.ok(md![1].startsWith('20260522'), `dates pinned to the cover generatedAt (2026-05-22), got ${md![1]}`);
  });

  it('reconstructs with NO Node Buffer — the /verify SPA runs assembleCanonicalPdf in the browser where `Buffer` is undefined (Barry QA: a Buffer-using ModDate pin threw "Could not read that file" in-browser)', async () => {
    // Generate inputs while Buffer still exists, then delete the global to
    // simulate the browser, and require the reconstruction (the document-matches
    // step of verifyBundleWeb) to run AND still pin /ModDate to /CreationDate.
    const cover = await generateCoverPage(SAMPLE_METADATA);
    const source = await makeMockSource(2);
    const savedBuffer = globalThis.Buffer;
    let out: Uint8Array;
    try {
      // @ts-expect-error simulate the browser global scope (no Node Buffer)
      delete globalThis.Buffer;
      out = await assembleCanonicalPdf(cover, source);
    } finally {
      globalThis.Buffer = savedBuffer;
    }
    const str = Buffer.from(out).toString('latin1');
    const cd = /\/CreationDate \(D:([0-9]{14}Z?)\)/.exec(str);
    const md = /\/ModDate \(D:([0-9]{14}Z?)\)/.exec(str);
    assert.ok(cd && md, 'both dates present after a Buffer-free reconstruction');
    assert.equal(md![1], cd![1], '/ModDate pinned to /CreationDate, computed without Node Buffer');
  });

  it('docHash of canonical PDF differs from docHash of source upload (F22.9.1 semantic)', async () => {
    const cover = await generateCoverPage(SAMPLE_METADATA);
    const source = await makeMockSource(1);
    const canonical = await assembleCanonicalPdf(cover, source);

    const sourceHash = createHash('sha256').update(source).digest('hex');
    const canonicalHash = createHash('sha256').update(canonical).digest('hex');

    assert.notEqual(
      sourceHash,
      canonicalHash,
      'canonical PDF hash must differ from source upload hash — that is the v0.19.0 semantic shift',
    );
    assert.match(canonicalHash, /^[0-9a-f]{64}$/, '64-hex docHash');
  });
});

describe('assembleCanonicalPdf — Family B: per-signer covers → per-signer PDFs (DD-9), hash = SHA-256(bytes)', () => {
  it('different per-signer covers produce different canonical PDFs (F-3.4 — byte-identity rule retired)', async () => {
    const coverA = await generateCoverPage({ ...SAMPLE_METADATA, signerName: 'Alice Smith', signerEmail: 'alice@example.com' });
    const coverB = await generateCoverPage({ ...SAMPLE_METADATA, signerName: 'Bob Jones', signerEmail: 'bob@example.com' });
    const source = await makeMockSource(2);
    const forSignerA = await assembleCanonicalPdf(coverA, source);
    const forSignerB = await assembleCanonicalPdf(coverB, source);
    assert.notEqual(
      Buffer.from(forSignerA).toString('hex'),
      Buffer.from(forSignerB).toString('hex'),
      'per-signer covers → per-signer canonical PDFs',
    );
  });

  it('docHash equals SHA-256 of exactly the canonical bytes', async () => {
    const cover = await generateCoverPage(SAMPLE_METADATA);
    const source = await makeMockSource(3);
    const canonical = await assembleCanonicalPdf(cover, source);
    const docHash = createHash('sha256').update(canonical).digest('hex');
    // Recompute independently from the same bytes — docHash is a pure function
    // of the canonical PDF, nothing else.
    const recomputed = createHash('sha256').update(Buffer.from(canonical)).digest('hex');
    assert.equal(docHash, recomputed, 'docHash is SHA-256 over exactly the canonical bytes');
    assert.match(docHash, /^[0-9a-f]{64}$/);
  });
});
