/**
 * Signature page renderer (F-8.1 / F-22) — the bundle's rendered front matter.
 *
 * Page 1 (and overflow pages) present, per signer, a verdict block: name as
 * claimed (F-22.1), email, provider domain + selector, signing time, the verbatim
 * intent line, the `.eml` SHA-256, and "on behalf of <org>" ONLY when the signer
 * declared one (F-22.2/22.3 — omitted for individuals). Plus envelope metadata,
 * the bundle fingerprint (F-8.2), a SINGLE document-level "Verify this document"
 * panel (one QR + URL that opens the /verify tool for the whole bundle — the same
 * link for every envelope, deliberately NOT per-signer), and the plain-language note
 * that the authoritative evidence is embedded and anyone can re-verify — no
 * kysigned, no certificate.
 *
 * This is a CONVENIENCE summary: the verifier trusts the embedded `.eml`, never
 * this page (AC-28e). Names/orgs render in their own script via the embedded DejaVu
 * Sans subset (#110) — Latin/English stays on Helvetica; the untrusted intent line
 * is defensively sanitised (any font-unrenderable char → '?') so pdf-lib can never
 * throw, and the true bytes live in the embedded evidence regardless.
 *
 * Deterministic: caller pins fonts + the QR PNG; the assembler pins the document
 * dates. Mirrors the cover-page idiom (coverPage.ts / nameFont.ts).
 */
import { PDFDocument, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import type { BundleEnvelopeInput } from './types.js';
import { embedCoverFonts, needsUnicodeFont } from '../pdf/nameFont.js';

export interface SignaturePageSigner {
  index: number;
  name: string;
  email: string;
  onBehalfOf?: string | null;
  signingDomain: string;
  selector: string;
  signedAt: Date;
  emlSha256: string;
  /** Verbatim first body line of the forward (extracted from the `.eml`). */
  intentLine: string;
}

export interface SignaturePageInput {
  envelope: BundleEnvelopeInput;
  signers: SignaturePageSigner[];
  fingerprint: string;
  verifierBaseUrl: string;
  /** Pre-rendered verifier QR PNG (deterministic; built by the assembler). */
  qrPng: Uint8Array;
}

const PAGE_WIDTH = 612; // US Letter @ 72dpi
const PAGE_HEIGHT = 792;
const MARGIN_X = 50;
const TOP_Y = 752;
const BOTTOM_Y = 60;

function fmt(d: Date): string {
  const p = (n: number) => n.toString().padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`
  );
}

export async function renderSignaturePages(doc: PDFDocument, input: SignaturePageInput): Promise<void> {
  // #110 — embed the name font set. Helvetica draws WinAnsi text (all the English
  // labels) exactly as before; the DejaVu Sans subset is added only when a signer
  // name / org / document name / intent line carries a non-WinAnsi char. Gate-checked
  // names render in their own script; `nf.prepare` RTL-reorders + defensively maps any
  // font-unrenderable char (e.g. CJK in an untrusted intent line) to '?', so no throw.
  const needsUnicode = needsUnicodeFont(
    input.envelope.documentName,
    input.envelope.creatorEmail,
    ...input.signers.flatMap((s) => [s.name, s.email, s.onBehalfOf ?? '', s.intentLine, s.signingDomain]),
  );
  const nf = await embedCoverFonts(doc, needsUnicode);
  const helv = nf.helv;
  const helvBold = nf.helvBold;
  const qr = await doc.embedPng(input.qrPng);
  const base = input.verifierBaseUrl.replace(/\/+$/, '');

  let page: PDFPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = TOP_Y;

  const draw = (text: string, opts: { size?: number; bold?: boolean; gap?: number; indent?: number } = {}) => {
    const size = opts.size ?? 10;
    if (y - size < BOTTOM_Y) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = TOP_Y;
    }
    page.drawText(nf.prepare(text), {
      x: MARGIN_X + (opts.indent ?? 0),
      y,
      size,
      font: nf.pick(text, !!opts.bold),
      color: rgb(0.1, 0.1, 0.1),
    });
    y -= size + 2 + (opts.gap ?? 0);
  };

  // ── Single, document-level verifier panel (top-right of page 1) ───────────
  // ONE QR for the WHOLE bundle: it opens the /verify tool — the same link for
  // every envelope, carrying no per-signer data. Boxed + labelled "Verify this
  // document" and set apart from the signer blocks below so it never reads as
  // belonging to any one signature (Barry QA 2026-06-22).
  const QR_SIZE = 88;
  const PANEL_W = 140;
  const PANEL_H = 138;
  const PANEL_X = PAGE_WIDTH - MARGIN_X - PANEL_W;
  const PANEL_TOP = PAGE_HEIGHT - 28;
  const PANEL_BOTTOM = PANEL_TOP - PANEL_H;
  const cx = PANEL_X + PANEL_W / 2;
  const centerX = (t: string, font: PDFFont, size: number) => cx - font.widthOfTextAtSize(nf.prepare(t), size) / 2;
  page.drawRectangle({
    x: PANEL_X, y: PANEL_BOTTOM, width: PANEL_W, height: PANEL_H,
    color: rgb(0.98, 0.98, 0.98), borderColor: rgb(0.78, 0.78, 0.78), borderWidth: 1,
  });
  const panelTitle = 'Verify this document';
  page.drawText(nf.prepare(panelTitle), { x: centerX(panelTitle, helvBold, 9), y: PANEL_TOP - 16, size: 9, font: helvBold, color: rgb(0.1, 0.1, 0.1) });
  page.drawImage(qr, { x: cx - QR_SIZE / 2, y: PANEL_TOP - 24 - QR_SIZE, width: QR_SIZE, height: QR_SIZE });
  const verifyHost = base.replace(/^https?:\/\//, '') + '/verify';
  const cap = 'Scan, or visit';
  page.drawText(nf.prepare(cap), { x: centerX(cap, helv, 7.5), y: PANEL_BOTTOM + 17, size: 7.5, font: helv, color: rgb(0.4, 0.4, 0.4) });
  page.drawText(nf.prepare(verifyHost), { x: centerX(verifyHost, helv, 7.5), y: PANEL_BOTTOM + 7, size: 7.5, font: helv, color: rgb(0.4, 0.4, 0.4) });

  draw('kysigned - Signing record', { size: 16, bold: true, gap: 4 });
  draw('Signature page', { size: 11, bold: true, gap: 3 });
  draw('This PDF is the signing record: the document below, plus who signed it and when.', { size: 9, gap: 12 });

  // ── Envelope metadata ─────────────────────────────────────────────────────
  draw(`Document:    ${input.envelope.documentName}`, { size: 10, gap: 2 });
  draw(`Envelope ID: ${input.envelope.id}`, { size: 10, gap: 2 });
  draw(`Creator:     ${input.envelope.creatorEmail}`, { size: 10, gap: 2 });
  draw(`Completed:   ${fmt(input.envelope.completedAt)}`, { size: 10, gap: 2 });
  draw('Document fingerprint (SHA-256):', { size: 9, bold: true, gap: 1 });
  draw(input.envelope.documentHash, { size: 9, gap: 14 });

  // ── Per-signer verdict blocks ─────────────────────────────────────────────
  for (const s of input.signers) {
    draw(`Signer ${s.index}: ${s.name}`, { size: 12, bold: true, gap: 3 });
    draw(`Email:        ${s.email}`, { size: 9, indent: 8, gap: 2 });
    if (s.onBehalfOf) {
      draw(`On behalf of: ${s.onBehalfOf}`, { size: 9, indent: 8, gap: 2 });
    }
    draw(`Provider:     ${s.signingDomain} (selector ${s.selector})`, { size: 9, indent: 8, gap: 2 });
    draw(`Signed:       ${fmt(s.signedAt)}`, { size: 9, indent: 8, gap: 2 });
    draw(`Intent line:  "${s.intentLine}"`, { size: 9, indent: 8, gap: 2 });
    draw(`.eml SHA-256: ${s.emlSha256}`, { size: 9, indent: 8, gap: 12 });
  }

  // F-15.3 / AC-76 — the names/organisations above are DECLARED, not verified.
  draw('Names and organisations above are as declared by the parties; kysigned', { size: 9, gap: 2 });
  draw('verifies control of the signing mailbox, not real-world identity.', { size: 9, gap: 14 });

  // ── Bundle fingerprint (F-8.2) ────────────────────────────────────────────
  draw('Verification code (SHA-256 of the embedded evidence):', { size: 10, bold: true, gap: 2 });
  draw(input.fingerprint, { size: 9, gap: 14 });

  // ── Re-verify note (no seal, no certificate) ──────────────────────────────
  draw('How to trust this document', { size: 11, bold: true, gap: 4 });
  draw('This PDF is intentionally unsigned: no certificate, no seal. It', { size: 9, gap: 2 });
  draw('opens clean in any viewer. Its authenticity comes entirely from the', { size: 9, gap: 2 });
  draw('evidence embedded inside it (each signer\'s original provider-signed email', { size: 9, gap: 2 });
  draw('+ independent timestamps), which anyone can re-verify - offline, forever,', { size: 9, gap: 2 });
  draw('even if kysigned no longer exists. See the embedded VERIFY-README.txt.', { size: 9, gap: 8 });
  draw('Verify independently: scan the QR panel on page 1, or visit', { size: 9, gap: 1 });
  draw(`${base}/verify`, { size: 9, bold: true });
}
