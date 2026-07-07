/**
 * F-4 — kysigned cover-page generator (evidence-bundle model, spec v0.3.0).
 *
 * Produces a single-page deterministic PDF that becomes page 1 of the canonical
 * PDF (F-3.3). Per F-4.1 it carries:
 *  - the envelope metadata block (document title, sender/creator, envelope ID,
 *    generated timestamp)
 *  - the SHA-256 of the underlying uploaded document (computed pre-assembly, so
 *    there is no self-reference: this hash does not depend on the cover it sits
 *    on; it binds the source-document identity into the signed bytes)
 *  - the ESIGN/UETA/eIDAS consent-to-electronic-business notice + signing
 *    disclaimers (F-15), which therefore travel inside the evidence (F-4.2)
 *  - kysigned branding (logo badge + wordmark + how-it-works URL)
 *
 * The signing act is a FORWARD: the signer forwards the signing-request email
 * with the first line `I sign this document` and the document still attached;
 * their provider's DKIM signature over that forward IS the signature. There is
 * NO signer-facing hash-check (F-5.4 — byte-checking is the machines' job).
 *
 * LAYOUT (#33): body text is word-wrapped to the page's usable width measured
 * with `font.widthOfTextAtSize` — never hand-split — so it fills the column with
 * no wasted right margin, and the page adopts the SOURCE DOCUMENT'S page size
 * (passed by the caller) so the cover reads as a natural part of the PDF rather
 * than a mismatched Letter sheet in front of an A4 document.
 *
 * Deterministic per F-4.3 — pdf-lib metadata + IDs are overridden with fixed
 * values derived from the input metadata, the logo is drawn from fixed vector
 * paths (no embedded raster, no randomness), and word-wrap uses fixed font
 * metrics, so assembling twice with identical inputs (incl. page size) yields
 * byte-identical output (asserted by the test suite); that is the property that
 * makes `docHash` reproducible.
 *
 * NOTE (F-15.4): the consent/affirmation wording is LEGAL TEXT — any change to
 * the WORDS requires Barry's approval before deploy. The #33 redesign re-flows
 * that wording (where the line breaks fall) but does NOT alter it.
 */
import { PDFDocument, type PDFFont, type PDFPage, rgb } from 'pdf-lib';
import { BRAND_LOGO_PNG_BASE64 } from './brandLogo.js';
import { embedCoverFonts, needsUnicodeFont } from './nameFont.js';

export interface EnvelopeCoverMetadata {
  /** Document name as the envelope creator entered it. */
  documentName: string;
  /** Envelope creator's email address (Sender in user-facing language). */
  senderEmail: string;
  /** UUID identifying this envelope. */
  envelopeId: string;
  /**
   * SHA-256 (64-hex, no `0x`) of the underlying uploaded document — the file
   * the creator uploaded, hashed BEFORE this cover is prepended. NOT printed on
   * the cover (spec v0.6.0 / F-5.4 — signers don't verify hashes); retained for
   * callers and back-compat. Distinct from the envelope's `docHash`, which is the
   * SHA-256 of the assembled canonical PDF (cover + document).
   */
  sourceDocHash: string;
  /**
   * Deterministic timestamp baked into the cover (and into pdf-lib's
   * CreationDate / ModificationDate metadata). Must be supplied by the
   * caller — using `new Date()` would break determinism per F-4.3.
   */
  generatedAt: Date;
  /**
   * Operator's brand/marketing domain (e.g. 'kysigned.com'). The how-it-works
   * URL on the cover lives on this apex. Forker deployments pass their own
   * domain. Required.
   */
  operatorDomain: string;
  /**
   * Optional SPA-host override — used for the `/verify` footnote URL. Required
   * when an operator splits marketing (`example.com`) from the SPA
   * (`app.example.com`) per DD-66. Single-host forkers omit it and fall back to
   * `operatorDomain` (one domain serves both surfaces).
   */
  spaDomain?: string;
  /**
   * Per-signer fields (Family B, F-3.4 / DD-9). Each signer signs their OWN
   * canonical PDF `P_i` whose cover names them, so the cover is per-signer.
   * Omitted = a generic (non-per-signer) cover, kept only for back-compat with
   * callers not yet migrated.
   */
  signerName?: string;
  signerEmail?: string;
  /** Optional "signing on behalf of" organisation (F-22.2). */
  onBehalfOf?: string;
}

/**
 * Page geometry for the cover. The caller passes the SOURCE DOCUMENT'S first-page
 * size so the cover matches it (#33 — "use whatever page the PDF is on"). Omitted
 * = US Letter, kept for back-compat and standalone (non-assembled) callers.
 */
export interface CoverPageSize {
  width: number;
  height: number;
}

const PRODUCER_TAG = 'kysigned-cover-v0.20.0';

/** US Letter at 72 DPI — the fallback when the caller does not pass a page size. */
const LETTER: CoverPageSize = { width: 612, height: 792 };
/** Clamp absurd/instrument page sizes so the cover never lays out off-page. */
const MIN_W = 360;
const MIN_H = 480;

const MARGIN_X = 54;
const TOP_MARGIN = 54;
const BOTTOM_MARGIN = 46;
const LABEL_COL = 96; // metadata label column width

// Brand palette — navy on white, the Kychee terminal motif (logo memory).
const NAVY = rgb(0.102, 0.106, 0.184); // #1a1b2f
const INK = rgb(0.12, 0.12, 0.14);
const MUTED = rgb(0.40, 0.43, 0.49);
const RULE = rgb(0.85, 0.86, 0.88);

function formatTimestamp(d: Date): string {
  // YYYY-MM-DD HH:MM:SS UTC — fixed format, no locale randomness.
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
}

/**
 * Greedy word-wrap measured against a pixel width using the actual font metrics
 * (#33 — fill the page's usable width, no hand-split narrow column). Deterministic:
 * `widthOfTextAtSize` is a pure function of the (fixed) font + text + size.
 */
function wrapToWidth(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  // Defense in depth (F-005): a nullish/non-string value here (a missing metadata
  // field) would throw `Cannot read properties of undefined (reading 'split')` and
  // 500 the whole create. Coerce to '' so the renderer degrades gracefully — the
  // real validation (e.g. document_name required) lives at the handler boundary.
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const trial = cur ? `${cur} ${w}` : w;
    if (cur && font.widthOfTextAtSize(trial, size) > maxWidth) {
      lines.push(cur);
      cur = w;
    } else {
      cur = trial;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/**
 * Per-signer affirmation paragraphs (Family B, F-22 + #30) — the named adoption +
 * (optional) on-behalf-of authority affirmation + the "signs as presented"
 * statement, rendered INSIDE the signed cover bytes (so the declaration is bound
 * by the signer's DKIM signature, not merely asserted in the email body). DRAFT
 * legal wording, F-15.4-gated (pending Barry's final approval). Returns [] for a
 * generic (non-per-signer) cover. Each entry is a logical paragraph (wrapped at
 * render time), NOT a pre-broken line.
 */
function buildSignerAffirmation(m: EnvelopeCoverMetadata): Array<{ text: string; bold?: boolean }> {
  if (!m.signerEmail) return [];
  const who = m.signerName ? `${m.signerName} (${m.signerEmail})` : m.signerEmail;
  const adopt = m.onBehalfOf
    ? `I, ${who}, sign this document on behalf of ${m.onBehalfOf}, and I affirm that I am authorised to sign on its behalf in this matter.`
    : `I, ${who}, sign this document.`;
  const asIs =
    'I adopt this document as presented; any additional text in my forwarded email is not a condition or reservation.';
  return [
    { text: adopt, bold: true },
    { text: asIs },
  ];
}

export async function generateCoverPage(
  metadata: EnvelopeCoverMetadata,
  pageSize: CoverPageSize = LETTER,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();

  // Deterministic metadata overrides per F-4.3. pdf-lib defaults to wall-clock
  // CreationDate/ModificationDate and a random Producer — both kill
  // reproducibility. Override every field that would otherwise vary.
  doc.setTitle(`kysigned envelope ${metadata.envelopeId}`);
  doc.setAuthor('kysigned');
  doc.setSubject(`Signature request: ${metadata.documentName}`);
  doc.setProducer(PRODUCER_TAG);
  doc.setCreator(PRODUCER_TAG);
  doc.setCreationDate(metadata.generatedAt);
  doc.setModificationDate(metadata.generatedAt);

  // #110 — embed the name font set. Helvetica (WinAnsi) draws all the English legal
  // copy + Latin names byte-identically as before; the embedded DejaVu Sans subset
  // is added ONLY when a user field carries a non-WinAnsi character (Latin-Extended /
  // Greek / Cyrillic / Hebrew / Arabic), so any-script document & signer names render
  // instead of being rejected at create or 500ing deep in assembly.
  const needsUnicode = needsUnicodeFont(
    metadata.documentName,
    metadata.senderEmail,
    metadata.signerName,
    metadata.signerEmail,
    metadata.onBehalfOf,
  );
  const fonts = await embedCoverFonts(doc, needsUnicode);

  // Adopt the source document's page size (#33) so the cover is a natural part
  // of the PDF, clamped so a pathologically small page can't push text off-page.
  const pageWidth = Math.max(MIN_W, Math.round(pageSize.width));
  const pageHeight = Math.max(MIN_H, Math.round(pageSize.height));
  const usableWidth = pageWidth - 2 * MARGIN_X;

  const page: PDFPage = doc.addPage([pageWidth, pageHeight]);

  let y = pageHeight - TOP_MARGIN;

  // ── render helpers ──────────────────────────────────────────────────────
  // Every string is drawn through fonts.pick (Helvetica for WinAnsi-encodable text,
  // the embedded DejaVu subset otherwise) + fonts.prepare (defensive sanitize + RTL
  // reorder). English/Latin stays on Helvetica byte-for-byte; a non-Latin name routes
  // to DejaVu and renders. Width is measured with the SAME font each line is drawn
  // with, so #33 width-wrap stays correct.
  const show = (
    s: string,
    x: number,
    yy: number,
    size: number,
    font: PDFFont,
    color?: ReturnType<typeof rgb>,
  ) => {
    page.drawText(fonts.prepare(s), { x, y: yy, size, font, color: color ?? INK });
  };

  const text = (
    s: string,
    x: number,
    yy: number,
    opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> } = {},
  ) => {
    const size = opts.size ?? 10;
    show(s, x, yy, size, fonts.pick(s, !!opts.bold), opts.color);
  };

  /** A wrapped paragraph. `marker` (e.g. "1.") gets a hanging indent so the
   *  continuation lines align under the body, not under the number. */
  const paragraph = (
    s: string,
    opts: {
      size?: number;
      bold?: boolean;
      color?: ReturnType<typeof rgb>;
      indent?: number;
      gapAfter?: number;
      marker?: string;
    } = {},
  ) => {
    const size = opts.size ?? 9.5;
    // One font for the whole logical paragraph so wrap + draw share metrics (a
    // paragraph with any non-WinAnsi char routes wholly to DejaVu).
    const font = fonts.pick(s, !!opts.bold);
    const indent = opts.indent ?? 0;
    const hang = opts.marker ? font.widthOfTextAtSize(`${opts.marker} `, size) : 0;
    const x0 = MARGIN_X + indent;
    const lines = wrapToWidth(s, font, size, usableWidth - indent - hang);
    lines.forEach((ln, i) => {
      if (i === 0 && opts.marker) show(opts.marker, x0, y, size, fonts.pick(opts.marker, !!opts.bold), opts.color);
      show(ln, x0 + hang, y, size, font, opts.color);
      y -= size * 1.42;
    });
    y -= opts.gapAfter ?? 9;
  };

  /** A "Label   value" metadata row; the value wraps under itself if long. */
  const kvRow = (label: string, value: string) => {
    const size = 10;
    show(label, MARGIN_X, y, size, fonts.pick(label, false), MUTED);
    const valueFont = fonts.pick(value, false);
    const lines = wrapToWidth(value, valueFont, size, usableWidth - LABEL_COL);
    lines.forEach((ln, i) => {
      show(ln, MARGIN_X + LABEL_COL, y, size, valueFont, INK);
      if (i < lines.length - 1) y -= size * 1.4;
    });
    y -= size * 1.5;
  };

  const heading = (s: string) => {
    y -= 4;
    text(s, MARGIN_X, y, { size: 11, bold: true, color: NAVY });
    y -= 11 * 1.5;
  };

  const rule = (gap = 10) => {
    page.drawLine({
      start: { x: MARGIN_X, y: y + 4 },
      end: { x: pageWidth - MARGIN_X, y: y + 4 },
      thickness: 0.75,
      color: RULE,
    });
    y -= gap;
  };

  // ── header band: brand logo + wordmark ───────────────────────────────────
  // The real kysigned mark (">" terminal prompt + fountain-pen nib + signature
  // flourish), embedded from brandLogo.ts and stamped deterministically (F-4.3).
  // A forker swaps that one file. (Was a hand-drawn ">" badge — GH#33.)
  const BADGE = 30;
  const badgeTop = y;
  const brandLogo = await doc.embedPng(BRAND_LOGO_PNG_BASE64);
  page.drawImage(brandLogo, { x: MARGIN_X, y: badgeTop - BADGE, width: BADGE, height: BADGE });
  // Wordmark + subtitle to the right of the logo.
  text('kysigned', MARGIN_X + BADGE + 12, badgeTop - 13, { size: 17, bold: true, color: NAVY });
  text('signature request', MARGIN_X + BADGE + 12, badgeTop - 27, { size: 9.5, color: MUTED });
  y = badgeTop - BADGE - 16;
  rule(16);

  // ── envelope metadata ───────────────────────────────────────────────────
  kvRow('Document', metadata.documentName);
  kvRow('Sender', metadata.senderEmail);
  kvRow('Envelope ID', metadata.envelopeId);
  kvRow('Generated', formatTimestamp(metadata.generatedAt));
  if (metadata.signerEmail) {
    kvRow('Signer', metadata.signerName ? `${metadata.signerName} <${metadata.signerEmail}>` : metadata.signerEmail);
  }
  if (metadata.onBehalfOf) kvRow('On behalf of', metadata.onBehalfOf);
  y -= 6;
  rule(12);

  // No document hash is printed (F-5.4 / AC-9, spec v0.6.0): signers do not verify
  // hashes — byte-checking is the machines' job, and the verifier proves all signed
  // the same D by reconstruction (F-10.3), not by a printed value. `sourceDocHash`
  // is still threaded in for callers but intentionally not rendered here.

  // ── YOUR AGREEMENT — consent + four affirmations (F-15). LEGAL TEXT. ──────
  heading('YOUR AGREEMENT');
  // Per-signer named adoption + on-behalf-of authority + signs-as-presented
  // (Family B, F-22 / #30). Empty for a generic cover.
  for (const a of buildSignerAffirmation(metadata)) paragraph(a.text, { size: 9.5, bold: a.bold, gapAfter: 5 });
  paragraph(
    'By forwarding the signing-request email for this envelope — with the first line "I sign this document" and the document still attached — you affirm:',
    { gapAfter: 8 },
  );
  paragraph('You have read and understood this document in its entirety.', { marker: '1.', gapAfter: 6 });
  paragraph(
    'You consent to use an electronic signature in lieu of a handwritten signature for this transaction. (ESIGN Act 15 U.S.C. §7001, UETA §7, eIDAS Article 25.)',
    { marker: '2.', gapAfter: 6 },
  );
  paragraph(
    'Your forwarded "I sign this document" email, which you actively send from your own mailbox and which your email provider authenticates with its DKIM signature, is your signature. Sending it is the act of signing.',
    { marker: '3.', gapAfter: 6 },
  );
  paragraph(
    'You intend to be legally bound by this signature to the extent permitted under applicable law in your jurisdiction.',
    { marker: '4.', gapAfter: 12 },
  );

  // ── WHAT THIS PROVES — honest scope per F-15.3 (mailbox control, not identity).
  heading('WHAT THIS PROVES');
  paragraph('Each signature proves that someone in control of the signing mailbox signed exactly this document, nothing more.', { gapAfter: 6 });
  paragraph(
    'The name and organisation shown are as DECLARED by the parties; kysigned verifies mailbox control, not real-world identity.',
    { gapAfter: 12 },
  );

  // ── AFTER ALL SIGNERS — the signing-record outcome + a verify path (no chain).
  heading('AFTER ALL SIGNERS HAVE SIGNED');
  const verifyHost = metadata.spaDomain ?? metadata.operatorDomain;
  paragraph(
    `Once every signer forwards "I sign this document", kysigned assembles a self-contained signing record: this document, plus every signer's original provider-signed email and independent timestamps, and sends it to all parties. Anyone can confirm each signature at ${verifyHost}/verify (drag it in): no account, offline, and even if kysigned no longer exists.`,
    { gapAfter: 14 },
  );

  // Branding footer — how-it-works URL on the marketing apex (F-4.1).
  paragraph(`Learn how this works: ${metadata.operatorDomain}/how-it-works`, { size: 9, bold: true, gapAfter: 0 });

  // useObjectStreams: false → text streams remain inspectable (the test suite
  // searches the rendered text). updateFieldAppearances: false → no form-fill
  // side effects. Both also keep the output stable (object-stream ordering can
  // vary), preserving F-4.3 determinism.
  const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return new Uint8Array(bytes);
}
