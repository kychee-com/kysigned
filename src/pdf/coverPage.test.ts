/**
 * F-4 — Cover page tests (evidence-bundle model, spec v0.3.0).
 *
 * Verifies the kysigned-generated cover page carries every F-4.1 required
 * element (document title, envelope id, creator identity, the source-document
 * SHA-256, the ESIGN/UETA/eIDAS consent + signing disclaimers, and branding),
 * OMITS the signer hash-check block (F-5.4 — byte-checking is the machines' job,
 * not the signer's), and is byte-deterministic per F-4.3.
 *
 * The signing act is a FORWARD: the signer forwards the signing-request
 * email with the first line `I sign this document` and the document still
 * attached; the DKIM-signed forward IS the signature (no mailto/reply).
 *
 * NOTE (F-15.4): the consent/affirmation wording below is LEGAL TEXT and is
 * pinned here verbatim — any change requires Barry's approval before deploy.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { inflateSync } from 'node:zlib';
import { generateCoverPage, type EnvelopeCoverMetadata } from './coverPage.ts';

const FIXED_DATE = new Date('2026-05-22T19:55:23.000Z');

// SHA-256 of the underlying uploaded document (computed pre-assembly). Threaded
// through as metadata but, since spec v0.6.0, NOT rendered on the cover — the
// tests assert it is absent.
const SAMPLE_SOURCE_HASH =
  '0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd';

const SAMPLE_METADATA: EnvelopeCoverMetadata = {
  documentName: 'NDA — Acme Corp',
  senderEmail: 'contracts@acmecorp.com',
  envelopeId: '16883542-30c8-4237-b961-1e188a797903',
  generatedAt: FIXED_DATE,
  operatorDomain: 'kysigned.com',
  sourceDocHash: SAMPLE_SOURCE_HASH,
};

/**
 * Decode pdf-lib's `<HEXHEX> Tj` text-show operands into the visible text they
 * render, in reading order, joined by single spaces. pdf-lib uses WinAnsi for
 * built-in fonts and emits one hex string per `drawText`, so joining the tokens
 * with spaces reconstructs the visible reading text REGARDLESS of where the #33
 * width-wrap fell — a phrase the layout broke across two lines is still found
 * contiguously (wrapToWidth never splits a word, so every word is intact in some
 * token). This also strengthens the forbidden-content checks: a banned phrase
 * split across lines can no longer hide.
 */
function decodeShownText(streamText: string): string {
  const tokens: string[] = [];
  const re = /<([0-9A-Fa-f]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(streamText)) !== null) {
    const hex = m[1]!;
    if (hex.length % 2 !== 0) continue; // malformed, skip
    let out = '';
    for (let i = 0; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    tokens.push(out);
  }
  return tokens.join(' ');
}

/**
 * Extract all visible text from a pdf-lib-generated PDF by decompressing every
 * FlateDecode stream + decoding the hex-encoded text-show operands (space-joined
 * reading order, see decodeShownText).
 */
function extractDecompressedText(pdfBytes: Uint8Array): string {
  const raw = Buffer.from(pdfBytes);
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const streamIdx = raw.indexOf(Buffer.from('stream', 'latin1'), i);
    if (streamIdx === -1) break;
    let start = streamIdx + 6;
    if (raw[start] === 0x0d /* CR */) start++;
    if (raw[start] === 0x0a /* LF */) start++;
    const endIdx = raw.indexOf(Buffer.from('endstream', 'latin1'), start);
    if (endIdx === -1) break;
    let end = endIdx;
    if (raw[end - 1] === 0x0a) end--;
    if (raw[end - 1] === 0x0d) end--;
    const streamBytes = raw.subarray(start, end);
    try {
      const inflated = inflateSync(streamBytes);
      out.push(decodeShownText(inflated.toString('latin1')));
    } catch {
      // Some streams may not be flate-encoded (e.g., embedded fonts) — skip.
    }
    i = endIdx + 9;
  }
  return out.join(' ');
}

function asUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function coverText(pdf: Uint8Array): string {
  return asUtf8(pdf) + '\n' + extractDecompressedText(pdf);
}

function streamOnlyText(pdf: Uint8Array): string {
  return extractDecompressedText(pdf);
}

/** True if the PDF embeds at least one image XObject (the brand logo). Operates on
 *  the parsed object graph, so it is robust to object-stream compression. */
async function hasEmbeddedImage(pdf: Uint8Array): Promise<boolean> {
  const doc = await PDFDocument.load(pdf);
  return doc.context
    .enumerateIndirectObjects()
    .some(([, obj]) => obj instanceof PDFRawStream && String(obj.dict.get(PDFName.of('Subtype'))) === '/Image');
}

describe('generateCoverPage — F-4.1 required content', () => {
  it('produces a single page PDF', async () => {
    const pdf = await generateCoverPage(SAMPLE_METADATA);
    const doc = await PDFDocument.load(pdf);
    assert.equal(doc.getPageCount(), 1, 'cover must be exactly one page');
  });

  it('renders the kysigned brand header', async () => {
    const text = coverText(await generateCoverPage(SAMPLE_METADATA));
    assert.match(text, /kysigned/);
    assert.match(text, /signature request/i);
  });

  it('includes the envelope metadata block — document name, sender, envelope id, generated timestamp', async () => {
    const text = coverText(await generateCoverPage(SAMPLE_METADATA));
    assert.match(text, /NDA/, 'document name appears');
    assert.match(text, /contracts@acmecorp\.com/, 'sender (envelope creator) email appears');
    assert.match(text, /16883542-30c8-4237-b961/, 'envelope ID appears');
    assert.match(text, /2026-05-22/, 'generated timestamp date appears');
  });

  it('does NOT print the document hash on the cover (F-5.4 / AC-9, spec v0.6.0 — signers do not verify hashes)', async () => {
    const stream = streamOnlyText(await generateCoverPage(SAMPLE_METADATA));
    assert.doesNotMatch(stream, new RegExp(SAMPLE_SOURCE_HASH), 'the source-doc hash must NOT be rendered on the cover');
    assert.doesNotMatch(stream, /Document SHA-?256/i, 'no "Document SHA-256" fingerprint block on the cover');
  });

  it('frames the signing act as FORWARDING the request with the intent line + attachment', async () => {
    const stream = streamOnlyText(await generateCoverPage(SAMPLE_METADATA));
    assert.match(stream, /forward/i, 'consent frames signing as forwarding');
    assert.match(stream, /I sign this document/, 'the exact intent line appears copy-ready');
    assert.doesNotMatch(stream, /I SIGN THIS DOCUMENT/, 'intent phrase displayed normal-case — never all-caps (req 2 / F-6.3: caps never required)');
    assert.doesNotMatch(stream, /By replying/i, 'must NOT frame signing as a reply');
    assert.doesNotMatch(stream, /mailto:/i, 'no mailto compose flow (carved)');
  });

  it('renders the four ESIGN/UETA/eIDAS affirmations (no chain language)', async () => {
    const text = coverText(await generateCoverPage(SAMPLE_METADATA));
    assert.match(text, /read and understood this document/i, 'affirmation 1');
    assert.match(text, /ESIGN[\s\S]{0,200}7001/, 'affirmation 2 — ESIGN + 7001 citation');
    assert.match(text, /UETA/, 'affirmation 2 — UETA citation');
    assert.match(text, /eIDAS[\s\S]{0,100}25/, 'affirmation 2 — eIDAS Article 25 citation');
    assert.match(text, /DKIM/, 'affirmation 3 — DKIM mentioned');
    assert.match(text, /legally bound/i, 'affirmation 4');
  });

  it('affirmation #3 states the signer actively sends the forward from their own mailbox and that sending it is the act of signing', async () => {
    const stream = streamOnlyText(await generateCoverPage(SAMPLE_METADATA));
    assert.match(stream, /actively send/i, 'active-send framing');
    assert.match(stream, /your own mailbox/i, 'from your own mailbox');
    assert.match(stream, /act of signing/i, 'sending it is the act of signing');
    assert.match(stream, /"I sign this document" email/, 'calls it the "I sign this document" email');
  });

  it('states the honest scope of what a signature proves (F-15.3)', async () => {
    const stream = streamOnlyText(await generateCoverPage(SAMPLE_METADATA));
    // "someone with control of mailbox X signed exactly document Y" — never "person X signed".
    assert.match(stream, /control of/i, 'honest mailbox-control framing');
    assert.match(stream, /exactly this document/i, 'binds to exactly this document');
    // F-15.3 / AC-76 — name/org are DECLARED, never kysigned-verified (no KYC).
    assert.match(stream, /declared by the parties/i, 'name/org framed as declared (AC-76)');
    assert.match(stream, /not real-world identity/i, 'mailbox control, not verified identity (AC-76)');
  });

  it('renders the AFTER ALL SIGNERS footnote describing the signing record + a verify path (no chain)', async () => {
    const text = coverText(await generateCoverPage(SAMPLE_METADATA));
    assert.match(text, /After all signers/i);
    assert.match(text, /signing record/i, 'describes the self-contained signing record');
    assert.match(text, /\/verify/, 'points at the verifier');
    assert.match(text, /kysigned\.com/, 'operator domain present');
  });

  it('carries the how-it-works branding URL (F-4.1)', async () => {
    const stream = streamOnlyText(await generateCoverPage(SAMPLE_METADATA));
    assert.match(stream, /how-it-works/, 'how-it-works URL on the cover');
  });
});

// Family B (DD-9 / F-22 / #30): the per-signer cover carries that signer's named
// adoption, the on-behalf-of authority affirmation (when set), and the
// signs-as-presented statement — INSIDE the signed bytes. DRAFT legal wording
// (F-15.4-gated); these assertions pin the draft and update on Barry's approval.
describe('generateCoverPage — Family B per-signer affirmation (F-22 / #30)', () => {
  const norm = (pdf: Uint8Array) => coverText(pdf).replace(/\s+/g, ' ');

  it('renders the named individual adoption line + the signs-as-presented statement', async () => {
    const t = norm(await generateCoverPage({ ...SAMPLE_METADATA, signerName: 'Alice Smith', signerEmail: 'alice@example.com' }));
    assert.match(t, /I, Alice Smith \(alice@example\.com\), sign this document/, 'named adoption');
    assert.match(t, /adopt this document as presented/i, 'signs-as-presented (#30)');
    assert.match(t, /not a condition or reservation/i, 'trailing text is no reservation (#30)');
    assert.doesNotMatch(t, /on behalf of/i, 'individual signer has no on-behalf-of line');
  });

  it('renders the on-behalf-of authority affirmation when an organisation is set', async () => {
    const t = norm(await generateCoverPage({ ...SAMPLE_METADATA, signerName: 'Bob Jones', signerEmail: 'bob@acme.com', onBehalfOf: 'Acme Corporation' }));
    assert.match(t, /I, Bob Jones \(bob@acme\.com\), sign this document on behalf of Acme Corporation/, 'on-behalf adoption');
    assert.match(t, /authorised to sign on its behalf/i, 'authority affirmation');
  });

  it('falls back to the email as identifier when no name is given', async () => {
    const t = norm(await generateCoverPage({ ...SAMPLE_METADATA, signerEmail: 'carol@example.com' }));
    assert.match(t, /I, carol@example\.com, sign this document/, 'email-only identifier');
  });

  it('a generic (non-per-signer) cover has no affirmation block (back-compat)', async () => {
    const t = norm(await generateCoverPage(SAMPLE_METADATA)); // no signerEmail
    assert.doesNotMatch(t, /sign this document on behalf of/i);
    assert.doesNotMatch(t, /adopt this document as presented/i);
  });

  it('a long organisation name is fully rendered, wrapped across lines (#33 adaptive wrap)', async () => {
    const longOrg = 'The Very Long Partnership of Attorneys and Counsellors at Law International LLP';
    const t = norm(await generateCoverPage({ ...SAMPLE_METADATA, signerName: 'Dana Long', signerEmail: 'dana@firm.com', onBehalfOf: longOrg }));
    // Wrapping splits the org across lines but must never DROP it — the #33
    // overflow risk is clipped/missing text. Assert every word survives.
    for (const word of ['Partnership', 'Attorneys', 'Counsellors', 'International', 'LLP']) {
      assert.match(t, new RegExp(`\\b${word}\\b`), `long org word "${word}" rendered`);
    }
  });
});

describe('generateCoverPage — forbidden content (signer hash-check + DO NOT REPLY)', () => {

  it('contains NO signer hash-check block (F-5.4 — byte-checking is the machines\' job)', async () => {
    const text = coverText(await generateCoverPage(SAMPLE_METADATA));
    assert.doesNotMatch(text, /hash-check/i, 'no /hash-check verification route');
    assert.doesNotMatch(text, /sha256sum/i, 'no sha256sum instruction');
    assert.doesNotMatch(text, /shasum/i, 'no shasum instruction');
    assert.doesNotMatch(text, /Get-FileHash/i, 'no PowerShell hash instruction');
    assert.doesNotMatch(text, /INDEPENDENT VERIFICATION/i, 'no signer-facing verification block');
  });

  it('does NOT include the DO NOT REPLY mismatch instruction (lives in email body, not the legal artifact)', async () => {
    const text = coverText(await generateCoverPage(SAMPLE_METADATA));
    assert.doesNotMatch(text, /do not reply/i, 'mismatch instruction must not be on cover');
  });
});

describe('generateCoverPage — F-4.3 determinism', () => {
  it('produces byte-identical output for identical inputs', async () => {
    const a = await generateCoverPage(SAMPLE_METADATA);
    const b = await generateCoverPage(SAMPLE_METADATA);
    assert.equal(
      Buffer.from(a).toString('hex'),
      Buffer.from(b).toString('hex'),
      'byte-identical PDFs for identical inputs',
    );
  });

  it('produces different output when the document name differs', async () => {
    const a = await generateCoverPage(SAMPLE_METADATA);
    const b = await generateCoverPage({ ...SAMPLE_METADATA, documentName: 'Different Document' });
    assert.notEqual(Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'));
  });

  it('produces different output when generatedAt differs', async () => {
    const a = await generateCoverPage(SAMPLE_METADATA);
    const b = await generateCoverPage({
      ...SAMPLE_METADATA,
      generatedAt: new Date('2027-01-01T00:00:00.000Z'),
    });
    assert.notEqual(Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'));
  });

  // (Removed "differs when sourceDocHash differs" — the source-doc hash is no
  //  longer rendered on the cover per spec v0.6.0, so it no longer affects bytes.)
});

// DD-66 two-host operator support: /verify is an SPA route; how-it-works is a
// marketing-apex route. Operators who split marketing (kysigned.com) from the
// SPA (app.example.com) point /verify at the SPA host; single-host forkers fall
// back to operatorDomain. (The old /hash-check route is carved per F-5.4.)
describe('generateCoverPage — DD-66 operator URL selection', () => {
  it('uses spaDomain for the /verify footnote when provided', async () => {
    const text = coverText(await generateCoverPage({ ...SAMPLE_METADATA, spaDomain: 'app.example.com' }));
    assert.match(text, /app\.example\.com\/verify/);
  });

  it('falls back to operatorDomain for /verify when spaDomain omitted (single-host forker)', async () => {
    const stream = streamOnlyText(await generateCoverPage(SAMPLE_METADATA)); // no spaDomain
    assert.match(stream, /(?:^|[^.])kysigned\.com\/verify/);
  });

  it('keeps the how-it-works URL on the marketing apex (operatorDomain), not the SPA host', async () => {
    const stream = streamOnlyText(await generateCoverPage({ ...SAMPLE_METADATA, spaDomain: 'app.example.com' }));
    assert.match(stream, /(?:^|[^.])kysigned\.com\/how-it-works/, 'how-it-works stays on operatorDomain');
    assert.doesNotMatch(stream, /app\.example\.com\/how-it-works/, 'how-it-works is not an SPA route');
  });

  it('different spaDomain values produce different PDFs (plumbing sanity)', async () => {
    const a = await generateCoverPage({ ...SAMPLE_METADATA, spaDomain: 'app.example.com' });
    const b = await generateCoverPage({ ...SAMPLE_METADATA, spaDomain: 'sign.lawfirmxx.com' });
    assert.notEqual(Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'));
  });
});

// #33 redesign: the cover adopts the source document's page size (so it's a
// natural part of the PDF, not a mismatched Letter sheet), and body text is
// word-wrapped to the page's usable width (no hand-split narrow column with a
// wasted right margin) — plus a vector logo header band.
describe('generateCoverPage — #33 layout (page size + width-aware wrap + logo)', () => {
  async function pageSize(pdf: Uint8Array): Promise<{ width: number; height: number }> {
    const doc = await PDFDocument.load(pdf);
    return doc.getPage(0).getSize();
  }
  /** Count text-show operators (≈ rendered lines) in the decompressed streams. */
  function countTextShows(pdf: Uint8Array): number {
    const raw = Buffer.from(pdf);
    let n = 0;
    let i = 0;
    while (i < raw.length) {
      const s = raw.indexOf(Buffer.from('stream', 'latin1'), i);
      if (s === -1) break;
      let start = s + 6;
      if (raw[start] === 0x0d) start++;
      if (raw[start] === 0x0a) start++;
      const e = raw.indexOf(Buffer.from('endstream', 'latin1'), start);
      if (e === -1) break;
      try {
        const inflated = inflateSync(raw.subarray(start, e)).toString('latin1');
        n += (inflated.match(/Tj/g) ?? []).length;
      } catch {
        /* non-flate stream */
      }
      i = e + 9;
    }
    return n;
  }

  it('defaults to US Letter (612×792) when no page size is given', async () => {
    const { width, height } = await pageSize(await generateCoverPage(SAMPLE_METADATA));
    assert.equal(width, 612);
    assert.equal(height, 792);
  });

  it('adopts the page size it is given — A4 source ⇒ A4 cover (#33)', async () => {
    const { width, height } = await pageSize(await generateCoverPage(SAMPLE_METADATA, { width: 595, height: 842 }));
    assert.equal(width, 595);
    assert.equal(height, 842);
  });

  it('clamps a pathologically small page so the cover never lays out off-page', async () => {
    const { width, height } = await pageSize(await generateCoverPage(SAMPLE_METADATA, { width: 10, height: 10 }));
    assert.ok(width >= 360, `width clamped (got ${width})`);
    assert.ok(height >= 480, `height clamped (got ${height})`);
  });

  it('wraps body text to the page width — a wider page yields fewer lines than a narrow one', async () => {
    // Same (tall) height so vertical room is identical; only width differs. A
    // hand-split fixed-width column would render the SAME line count regardless
    // of page width — this is the regression guard for the #33 narrow-column bug.
    const narrow = countTextShows(await generateCoverPage(SAMPLE_METADATA, { width: 420, height: 1400 }));
    const wide = countTextShows(await generateCoverPage(SAMPLE_METADATA, { width: 900, height: 1400 }));
    assert.ok(wide < narrow, `wider page should wrap into fewer lines (wide=${wide}, narrow=${narrow})`);
  });

  it('renders the kysigned wordmark (text) + the embedded brand-logo image (logo, not just metadata)', async () => {
    const pdf = await generateCoverPage(SAMPLE_METADATA);
    assert.match(streamOnlyText(pdf), /kysigned/, 'wordmark drawn on the page');
    // The ">" + pen-nib + signature-flourish mark is now the embedded brand PNG
    // (brandLogo.ts, GH#33), not vector text — assert the page embeds an image XObject.
    assert.ok(await hasEmbeddedImage(pdf), 'brand logo embedded as an image XObject');
  });

  it('per-signer cover stays deterministic under a custom page size', async () => {
    const meta = { ...SAMPLE_METADATA, signerName: 'Alice Smith', signerEmail: 'alice@example.com' };
    const a = await generateCoverPage(meta, { width: 595, height: 842 });
    const b = await generateCoverPage(meta, { width: 595, height: 842 });
    assert.equal(Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'));
  });

  // F-005 defense in depth: a nullish text metadata field must NOT crash the
  // renderer (`wrapToWidth(undefined).split` → 500). The handler validates the
  // required fields (document_name) up front, but the renderer degrades gracefully
  // for any field that slips through, rather than 500ing the whole create.
  it('does not throw when a text metadata field is undefined (renders a blank instead)', async () => {
    const meta = { ...SAMPLE_METADATA, documentName: undefined as unknown as string };
    const pdf = await generateCoverPage(meta); // would throw pre-fix
    assert.ok(pdf.length > 0, 'a cover PDF was produced despite the missing field');
  });
});

// #110: any-script document / signer names render via the embedded DejaVu Sans
// subset instead of being rejected at create (Hebrew doc name `ו`) or 500ing deep
// in assembly (a non-WinAnsi signer name). Latin/English stays on Helvetica.
describe('generateCoverPage — #110 any-script name rendering', () => {
  const HEBREW = { ...SAMPLE_METADATA, documentName: 'הסכם סודיות', signerName: 'דוד כהן', signerEmail: 'david@example.co.il' };

  it('renders a Hebrew document + signer name without throwing (was #110 reject / #101 500)', async () => {
    const pdf = await generateCoverPage(HEBREW); // pre-#110 this path could not exist (create-gated)
    const doc = await PDFDocument.load(pdf);
    assert.equal(doc.getPageCount(), 1, 'still a single-page cover');
    assert.ok(pdf.length > 0);
  });

  it('renders Greek and Cyrillic names without throwing', async () => {
    const greek = await generateCoverPage({ ...SAMPLE_METADATA, signerName: 'Αθανάσιος', signerEmail: 'a@x.gr' });
    const cyr = await generateCoverPage({ ...SAMPLE_METADATA, signerName: 'Александр', signerEmail: 'a@x.ru' });
    assert.ok(greek.length > 0 && cyr.length > 0);
  });

  it('embeds the DejaVu subset ONLY for a non-Latin cover (Latin covers stay Helvetica-only)', async () => {
    // useObjectStreams:false ⇒ the FontDescriptor / BaseFont name is in plaintext.
    const nonLatin = asUtf8(await generateCoverPage(HEBREW));
    const latin = asUtf8(await generateCoverPage({ ...SAMPLE_METADATA, signerName: 'Alice Smith', signerEmail: 'alice@example.com' }));
    assert.match(nonLatin, /DejaVu/, 'non-Latin cover embeds the DejaVu font');
    assert.doesNotMatch(latin, /DejaVu/, 'all-Latin cover does NOT embed DejaVu (no cost, byte-identical to pre-#110)');
  });

  it('is byte-DETERMINISTIC for a Hebrew-named cover (F-4.3 / DD-9 — reconstruction depends on it)', async () => {
    const a = await generateCoverPage(HEBREW);
    const b = await generateCoverPage(HEBREW);
    assert.equal(
      Buffer.from(a).toString('hex'),
      Buffer.from(b).toString('hex'),
      'two renders of the same Hebrew-named cover must be byte-identical',
    );
  });

  it('is byte-deterministic for a Greek-named cover under a custom page size', async () => {
    const meta = { ...SAMPLE_METADATA, signerName: 'Αθανάσιος Παπαδόπουλος', signerEmail: 'a@x.gr' };
    const a = await generateCoverPage(meta, { width: 595, height: 842 });
    const b = await generateCoverPage(meta, { width: 595, height: 842 });
    assert.equal(Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'));
  });

  it('a Hebrew signer name produces a different cover than a Latin one (plumbing sanity)', async () => {
    const heb = await generateCoverPage(HEBREW);
    const lat = await generateCoverPage({ ...HEBREW, documentName: 'NDA', signerName: 'David Cohen', signerEmail: 'david@example.co.il' });
    assert.notEqual(Buffer.from(heb).toString('hex'), Buffer.from(lat).toString('hex'));
  });
});
