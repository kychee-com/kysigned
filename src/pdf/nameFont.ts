/**
 * nameFont — Unicode name rendering for the cover + signature page (#110).
 *
 * BACKGROUND. The cover / per-signer PDFs used to draw ALL text with pdf-lib's
 * `StandardFonts.Helvetica` (WinAnsi / CP1252). Any character outside that set made
 * pdf-lib throw deep in assembly (an opaque 500 — #101) or was pre-rejected at
 * create (#110: a Hebrew document name `ו`), so non-Latin document / signer names
 * were unusable.
 *
 * FIX (D3 = A+C). Embed **DejaVu Sans** (regular + bold; permissive Bitstream-Vera
 * license) and render name-bearing text through it. DejaVu covers Latin (incl.
 * European accents + Latin-Extended), Greek, Cyrillic, Hebrew and Arabic, but NOT
 * CJK — which is exactly the supported/unsupported boundary D3 asks for. Two things
 * fall out of using the font's OWN glyph coverage as the gate predicate:
 *   - acceptance == renderability (the gate and the renderer never disagree), and
 *   - CJK / Japanese / Korean names are cleanly rejected at create (no tofu, no 500).
 *
 * PER-STRING FALLBACK (minimal blast radius). WinAnsi-encodable strings (all the
 * English legal copy + Latin names) keep rendering with Helvetica exactly as before
 * — byte-identical output, text still searchable in the content stream — and ONLY
 * strings carrying a non-WinAnsi character route to the embedded DejaVu subset. So
 * the existing cover/signature snapshots and text-search tests are unaffected, and
 * the font is embedded only when a cover actually needs it.
 *
 * RTL (Hebrew / Arabic). pdf-lib draws glyphs left-to-right with no bidi and no
 * shaping, so a name/label string must be pre-ordered into VISUAL order before it
 * is drawn. `toVisualOrder` runs the proper Unicode Bidi Algorithm (UAX #9) via
 * `bidi-js` (MIT) — first-strong base direction, correct handling of an LTR run
 * (an email, a "Signer N:" label) embedded in an RTL line, and mirrored-character
 * replacement — so a Hebrew name reads correctly, an ASCII email stays LTR-intact,
 * and an LTR label stays to the left of its RTL value. This REPLACES the old
 * hand-rolled per-run reversal (F-010: it garbled emails, swapped Hebrew words, and
 * mis-placed labels differently at each of the four draw sites). Arabic still
 * renders in ISOLATED letterforms (no contextual joining — the documented A+C
 * limitation), still legible and still accepted.
 *
 * DETERMINISM (F-4.3 / DD-9). fontkit subset-embedding is deterministic for
 * identical draw sequences (verified: two renders are byte-identical), so the
 * send-time cover reconstruction self-test still holds for a non-Latin name.
 *
 * BACKEND-ONLY. This module (and its Buffer/fontkit use) is imported only by the
 * cover generator, the signature-page renderer and the create gate — never by the
 * browser `/verify` bundle, which byte-MERGES the STORED cover and never re-renders
 * it (recon correction, #110). So a larger font bloats the Lambda bundle only, not
 * `/verify`.
 */
import fontkit from '@pdf-lib/fontkit';
import bidiFactory from 'bidi-js';
import { StandardFonts, type PDFDocument, type PDFFont } from 'pdf-lib';
import { DEJAVU_SANS_REGULAR_BASE64 } from './fonts/dejaVuSans.js';
import { DEJAVU_SANS_BOLD_BASE64 } from './fonts/dejaVuSansBold.js';
import { isWinAnsiEncodable, type UnrenderableChar } from './winAnsi.js';

export type { UnrenderableChar };

// ── vendored font bytes (decoded once) ──────────────────────────────────────
let _regBytes: Uint8Array | undefined;
let _boldBytes: Uint8Array | undefined;

function decodeBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** DejaVu Sans Regular TTF bytes (decoded from the inlined base64 module). */
export function dejaVuSansRegularBytes(): Uint8Array {
  return (_regBytes ??= decodeBase64(DEJAVU_SANS_REGULAR_BASE64));
}
/** DejaVu Sans Bold TTF bytes. */
export function dejaVuSansBoldBytes(): Uint8Array {
  return (_boldBytes ??= decodeBase64(DEJAVU_SANS_BOLD_BASE64));
}

// ── glyph-coverage gate ─────────────────────────────────────────────────────
// Parse the regular face ONCE (memoized) purely to answer "does the render font
// have a glyph for this code point?". This is the SAME font that draws the text,
// so a char the gate accepts is a char the renderer can draw.
let _coverage: { hasGlyphForCodePoint(cp: number): boolean } | undefined;
function coverageFont() {
  return (_coverage ??= fontkit.create(Buffer.from(dejaVuSansRegularBytes())) as unknown as {
    hasGlyphForCodePoint(cp: number): boolean;
  });
}

/** True when the embedded name font can draw this code point (or it's whitespace). */
export function isSupportedNameChar(cp: number): boolean {
  // ASCII whitespace is always fine (space/tab/newline/CR) — never treated as tofu.
  if (cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d) return true;
  return coverageFont().hasGlyphForCodePoint(cp);
}

function codePointLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * The first character of `text` the embedded name font CANNOT draw, or `null` when
 * the whole string is renderable. Iterates by code point so astral characters
 * (emoji, rare CJK) are reported by their true code point, not a lone surrogate.
 * This replaces the old WinAnsi-only reject predicate (#110): Hebrew/Greek/Cyrillic/
 * Arabic now pass; CJK / Japanese / Korean are the ones rejected.
 */
export function firstUnsupportedNameChar(text: string): UnrenderableChar | null {
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0)!;
    if (!isSupportedNameChar(cp)) return { char: ch, label: codePointLabel(cp) };
  }
  return null;
}

// -- bidi (Unicode Bidirectional Algorithm, UAX #9, via bidi-js) -----------------
// pdf-lib draws glyphs strictly left-to-right with no bidi and no shaping, so a
// mixed-direction string must be pre-ordered into VISUAL order before it is drawn.
// bidi-js is the mainstream, permissively-licensed (MIT) UBA implementation (the
// same engine troika-three-text uses for canvas/WebGL text), never self-rolled
// (trust-model + "more eyes" rule). One factory instance, reused (stateless, cheap).
const _bidi = bidiFactory();

/**
 * Reorder `text` into VISUAL (draw) order using the full Unicode Bidi Algorithm with
 * first-strong ('auto') base direction. A correct UBA fixes every F-010 symptom at
 * once: a pure Hebrew name reverses to legible visual order; the two words of a
 * multi-word Hebrew name keep their order and their internal order; an LTR run
 * embedded in an RTL line (an ASCII email, its angle brackets) stays left-to-right
 * and untouched; and an LTR label ("Signer 1:", "Document:") stays to the LEFT of
 * its RTL value. Pure-LTR strings (all English legal copy, Latin/Greek/Cyrillic
 * names) come back byte-identical, so WinAnsi output and F-4.3 determinism are
 * preserved. Deterministic (a pure function of the input). No Arabic shaping:
 * isolated letterforms, the documented A+C limitation.
 */
export function toVisualOrder(text: string): string {
  const s = String(text ?? '');
  if (s === '') return s;
  const levels = _bidi.getEmbeddingLevels(s, 'auto');
  return _bidi.getReorderedString(s, levels);
}

// ── per-document font set + picker ──────────────────────────────────────────
export interface CoverFontSet {
  /** Helvetica (WinAnsi) — used for every WinAnsi-encodable string. */
  helv: PDFFont;
  helvBold: PDFFont;
  /**
   * Pick the font for a string: Helvetica when the string is WinAnsi-encodable
   * (unchanged, searchable), else the embedded DejaVu subset. Falls back to
   * Helvetica if DejaVu was not embedded (should not happen when `needsUnicode` is
   * computed from the drawn strings).
   */
  pick(text: string, bold: boolean): PDFFont;
  /**
   * Prepare a string for drawing with the picked font: WinAnsi strings pass through
   * verbatim; non-WinAnsi strings get any font-unrenderable char mapped to '?'
   * (defense-in-depth — the create gate already rejects those) and RTL runs
   * reordered. Width is preserved, so measuring the logical string then drawing the
   * prepared line keeps word-wrap correct.
   */
  prepare(text: string): string;
}

/** Does any of these strings carry a non-WinAnsi char (⇒ the DejaVu subset is needed)? */
export function needsUnicodeFont(...fields: Array<string | null | undefined>): boolean {
  return fields.some((f) => f != null && f !== '' && !isWinAnsiEncodable(String(f)));
}

// -- neutralize fontkit's built-in bidi so toVisualOrder is the SOLE authority (F-010 P1) --
/** The slice of a `@pdf-lib/fontkit` Font we touch — its 5-arg `layout` + our marker. */
interface FontkitLayoutFont {
  layout(text: string, features?: unknown, script?: unknown, language?: unknown, direction?: unknown): unknown;
  __ltrForced?: boolean;
}

/**
 * Make `toVisualOrder` the SOLE bidi authority for a subset-embedded font (F-010 P1).
 *
 * pdf-lib paints with `CustomFontSubsetEmbedder.encodeText`, which calls
 * `this.font.layout(text)` with NO `direction` argument. `@pdf-lib/fontkit`'s `layout()`
 * then runs its OWN crude bidi: it fully REVERSES any string whose first strong char is
 * RTL. Because we already hand it VISUAL-order text (produced by `toVisualOrder`), that
 * second reversal DOUBLE-reverses a pure-RTL name and paints it backwards on the page
 * (`ןהכ הנד` → the logical `דנה כהן`, `ד` landing leftmost — the shipped defect). fontkit's
 * `layout(text, features, script, language, direction)` takes a 5th `direction` arg;
 * forcing `'ltr'` disables the reversal. We wrap the embedded font's `layout` so EVERY call
 * pdf-lib makes — glyph paint AND width measurement — forces LTR unless a caller passes a
 * direction explicitly. Reordering (or not) the glyph array never changes the SUM of
 * advances, so text widths / word-wrap are unaffected; only the paint ORDER is corrected.
 *
 * Idempotent (guarded by `__ltrForced`). Throws loudly if pd-lib's internals no longer
 * expose the fontkit `layout` — a dependency bump must FAIL the render, never silently
 * regress to reversed RTL. Exported for the geometry regression suite
 * (rtlPaintGeometry.test.ts); NOT part of the package's public surface (src/pdf/index.ts).
 */
export function forceLtrLayout(font: PDFFont): void {
  const fk = (font as unknown as { embedder?: { font?: FontkitLayoutFont } })?.embedder?.font;
  if (fk && typeof fk.layout === 'function') {
    if (fk.__ltrForced) return; // already wrapped — do not double-wrap
    const orig = fk.layout.bind(fk);
    fk.layout = (t, ft, sc, lg, dir) => orig(t, ft, sc, lg, dir ?? 'ltr');
    fk.__ltrForced = true;
    return;
  }
  throw new Error('forceLtrLayout: cannot reach fontkit layout to force LTR (pdf-lib internals changed)');
}

/**
 * Embed the cover/signature font set into `doc`. Helvetica is always embedded;
 * DejaVu (regular + bold, subset) is embedded ONLY when `needsUnicode` — so an
 * all-Latin cover stays byte-identical to the pre-#110 output and pays no font cost.
 */
export async function embedCoverFonts(doc: PDFDocument, needsUnicode: boolean): Promise<CoverFontSet> {
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  let dejavu: PDFFont | undefined;
  let dejavuBold: PDFFont | undefined;
  if (needsUnicode) {
    doc.registerFontkit(fontkit);
    dejavu = await doc.embedFont(dejaVuSansRegularBytes(), { subset: true });
    dejavuBold = await doc.embedFont(dejaVuSansBoldBytes(), { subset: true });
    // F-010 P1: fontkit's layout() reverses any first-strong-RTL string on top of the
    // VISUAL order `toVisualOrder` already produced, double-reversing pure-RTL names so
    // they paint backwards. Neutralize it on BOTH faces so bidi-js is the only reorderer.
    // MUST stay inside this branch: the faces exist only when needsUnicode, and an all-
    // Latin cover never embeds them (forcing unconditionally would throw / cost nothing).
    forceLtrLayout(dejavu);
    forceLtrLayout(dejavuBold);
  }

  const sanitizeToRenderable = (s: string): string =>
    Array.from(s)
      .map((ch) => (isSupportedNameChar(ch.codePointAt(0)!) ? ch : '?'))
      .join('');

  return {
    helv,
    helvBold,
    pick(text: string, bold: boolean): PDFFont {
      const s = String(text ?? '');
      if (dejavu && dejavuBold && !isWinAnsiEncodable(s)) return bold ? dejavuBold : dejavu;
      return bold ? helvBold : helv;
    },
    prepare(text: string): string {
      const s = String(text ?? '');
      if (isWinAnsiEncodable(s)) return s; // Helvetica path: verbatim (WinAnsi is pure-LTR)
      return toVisualOrder(sanitizeToRenderable(s));
    },
  };
}
