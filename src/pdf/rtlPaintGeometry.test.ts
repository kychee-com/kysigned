/**
 * RTL PAINT-ORDER GEOMETRY (F-010 P1 regression, #110 follow-up).
 *
 * WHY THIS FILE EXISTS. The F-010 "Hebrew renders reversed" defect shipped past
 * THREE verification passes because every prior check read the text back through a
 * layer that RE-APPLIES the bidi algorithm — pdf.js `getTextContent().str`, or a
 * multimodal/vision read of the rendered image. Both RECONSTRUCT logical order from
 * the visual glyphs, so they always report the "correct" `ןהכ`, hiding the fact that
 * the raw glyphs are painted in the wrong (reversed) order. A Hebrew reader looking
 * at the actual PDF sees the name backwards.
 *
 * Root cause: TWO bidi engines were stacked. `nameFont.toVisualOrder` (bidi-js, a
 * proper UBA) reorders the logical name into VISUAL order (`דנה כהן` → `ןהכ הנד`,
 * `ן` leftmost). Then pdf-lib's `drawText` → `CustomFontSubsetEmbedder.encodeText`
 * calls `this.font.layout(text)` and `@pdf-lib/fontkit`'s `layout()` does its OWN
 * crude bidi: it fully reverses any string whose first strong char is RTL — undoing
 * `toVisualOrder` and painting the LOGICAL order left-to-right (i.e. backwards).
 *
 * THESE TESTS ASSERT RAW PAINT ORDER, NEVER RECONSTRUCTION. Two authoritative,
 * geometry-level signals (both blessed by the finding, and both are what the red
 * team used to MEASURE the bug):
 *   (1) `theEmbeddedFont.layout(preparedString).glyphs` mapped through the fontkit
 *       glyphs' OWN `.codePoints`. pdf-lib paints exactly this glyph array in order,
 *       advancing x monotonically, so `glyphs[0]` is the leftmost (smallest x). We
 *       use the EXACT font object + layout call pdf-lib draws with
 *       (`nf.pick(name).embedder.font.layout`), so this is the paint geometry, not a
 *       re-derivation.
 *   (2) The ACTUAL rendered page bytes: we draw the name, then read the drawn glyph
 *       IDs from the content-stream `<hex> Tj` operand and resolve them to code
 *       points via the embedded subset's ToUnicode CMap. Confirms `ן` (U+05DF) is at
 *       the smallest x on the real page.
 *
 * Neither uses `getTextContent().str` or a vision read. See
 * agent-memory verify_real_path_not_seam / reference_kysigned_pdf_fonts_i18n.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { embedCoverFonts, forceLtrLayout, toVisualOrder } from './nameFont.ts';

// ── code-point helpers ───────────────────────────────────────────────────────
const cps = (s: string): number[] => Array.from(s, (c) => c.codePointAt(0)!);
const hx = (n: number): string => 'U+' + n.toString(16).toUpperCase().padStart(4, '0');
const hxs = (a: number[]): string => a.map(hx).join(' ');

// The canonical P1 repro: pure-Hebrew "Dana Cohen" (first strong char is RTL).
const DANA = 'דנה כהן';
// toVisualOrder(DANA) === 'ןהכ הנד' :  ן  ה  כ  ␠  ה  נ  ד   (ן = U+05DF must be leftmost).
const DANA_VISUAL = [0x05df, 0x05d4, 0x05db, 0x20, 0x05d4, 0x05e0, 0x05d3];
// The double-reversed BUG order (what fontkit's second reversal paints): logical order.
const DANA_LOGICAL = [0x05d3, 0x05e0, 0x05d4, 0x20, 0x05db, 0x05d4, 0x05df];

/**
 * PAINT-ORDER geometry (signal 1): the code-point sequence pdf-lib actually paints,
 * left→right, using the EXACT font object + `layout()` call its embedder uses. NOT a
 * pdf.js `.str` / vision reconstruction.
 */
async function paintOrder(name: string, bold = false): Promise<number[]> {
  const doc = await PDFDocument.create();
  const nf = await embedCoverFonts(doc, true); // force the DejaVu (Unicode) path
  const font = nf.pick(name, bold) as unknown as { embedder?: { font?: { layout(t: string): { glyphs: Array<{ codePoints: number[] }> } } } };
  const fk = font?.embedder?.font;
  assert.ok(fk && typeof fk.layout === 'function', `expected a reachable DejaVu fontkit layout for ${JSON.stringify(name)}`);
  const prepared = nf.prepare(name); // == toVisualOrder(sanitize(name)) — the string pdf-lib is handed
  const glyphs = fk.layout(prepared).glyphs; // pdf-lib's exact paint call
  return glyphs.flatMap((g) => g.codePoints);
}

describe('RTL paint geometry — toVisualOrder must be the SOLE bidi authority (F-010 P1)', () => {
  it('pure-Hebrew "דנה כהן" paints ן (U+05DF) FIRST/leftmost — NOT re-reversed to logical order', async () => {
    const painted = await paintOrder(DANA);
    assert.equal(painted[0], 0x05df, `first-painted glyph must be ן (U+05DF); got ${hx(painted[0])} — paint order ${hxs(painted)}`);
    assert.deepEqual(painted, DANA_VISUAL, `painted order ${hxs(painted)} must equal visual order ${hxs(DANA_VISUAL)} (ן leftmost)`);
    assert.notDeepEqual(painted, DANA_LOGICAL, 'painted order must NOT be the double-reversed logical order (the shipped bug)');
  });

  it('painted order EQUALS toVisualOrder output verbatim — fontkit adds ZERO reordering (the fix invariant)', async () => {
    for (const name of [DANA, 'שלום', 'כהן משפחה', 'אברהם יצחק']) {
      const painted = await paintOrder(name);
      const expected = cps(toVisualOrder(name));
      assert.deepEqual(painted, expected, `${JSON.stringify(name)}: painted ${hxs(painted)} != toVisualOrder ${hxs(expected)}`);
    }
  });

  it('applies to the BOLD DejaVu face too (both regular+bold subsets are LTR-forced)', async () => {
    const painted = await paintOrder(DANA, true);
    assert.deepEqual(painted, DANA_VISUAL, `bold face must paint the same correct visual order; got ${hxs(painted)}`);
  });

  // ── regression guards: the mixed/label lines that ALREADY rendered correctly (and
  // hid the bug) must stay byte-identical. Their VISUAL order is Latin-first ⇒ fontkit
  // never reversed them ⇒ the LTR-force is a no-op here (byte-UNCHANGED). ────────────
  it('mixed Hebrew+Latin doc name stays verbatim — "Cycle8" island intact, Hebrew reversed exactly once', async () => {
    const painted = await paintOrder('חוזה בדיקה Cycle8');
    assert.deepEqual(painted, cps(toVisualOrder('חוזה בדיקה Cycle8')));
    assert.deepEqual(painted, cps('Cycle8 הקידב הזוח'), 'Latin-first mixed line unchanged by the fix');
  });

  it('"Signer N: <hebrew>" label line stays verbatim — label left of the reversed-once Hebrew value', async () => {
    const painted = await paintOrder('Signer 1: דנה כהן');
    assert.deepEqual(painted, cps(toVisualOrder('Signer 1: דנה כהן')));
    assert.deepEqual(painted, cps('Signer 1: ןהכ הנד'), 'label line unchanged by the fix');
  });

  it('LTR non-Latin scripts (Cyrillic, Greek) paint verbatim — forced-LTR never reorders them', async () => {
    for (const name of ['Иван Иванов', 'Γιώργος Παπαδόπουλος']) {
      const painted = await paintOrder(name);
      assert.deepEqual(painted, cps(name), `${JSON.stringify(name)} must paint identically to its logical order`);
      assert.deepEqual(painted, cps(toVisualOrder(name)), 'toVisualOrder is already a no-op for LTR scripts');
    }
  });
});

// ── signal 2: parse the ACTUAL rendered page bytes ────────────────────────────
/** Inflate every FlateDecode stream (and keep raw bytes for any uncompressed one). */
function inflateStreams(pdf: Uint8Array): string[] {
  const raw = Buffer.from(pdf);
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const s = raw.indexOf(Buffer.from('stream', 'latin1'), i);
    if (s === -1) break;
    let start = s + 6;
    if (raw[start] === 0x0d) start++;
    if (raw[start] === 0x0a) start++;
    const e = raw.indexOf(Buffer.from('endstream', 'latin1'), start);
    if (e === -1) break;
    let end = e;
    if (raw[end - 1] === 0x0a) end--;
    if (raw[end - 1] === 0x0d) end--;
    const body = raw.subarray(start, end);
    try {
      out.push(inflateSync(body).toString('latin1'));
    } catch {
      out.push(body.toString('latin1')); // uncompressed stream (e.g. an un-flated CMap)
    }
    i = e + 9;
  }
  return out;
}

/** Drawn glyph IDs from the content stream's `<hex> Tj` (subset CIDs, 2 bytes each). */
function extractTjGlyphIds(content: string): number[] {
  const m = content.match(/<([0-9A-Fa-f]+)>\s*Tj/);
  assert.ok(m, 'content stream must contain a <hex> Tj text-show');
  const hex = m[1]!;
  const ids: number[] = [];
  for (let i = 0; i < hex.length; i += 4) ids.push(parseInt(hex.slice(i, i + 4), 16));
  return ids;
}

/** Parse a ToUnicode CMap (bfchar + bfrange) → Map<subsetGlyphId, unicodeCodePoint>. */
function parseToUnicode(cmap: string): Map<number, number> {
  const map = new Map<number, number>();
  const u16 = (h: string) => parseInt(h.slice(0, 4), 16); // BMP: first UTF-16BE unit
  let blk: RegExpExecArray | null;
  const charBlocks = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((blk = charBlocks.exec(cmap))) {
    const rx = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let e: RegExpExecArray | null;
    while ((e = rx.exec(blk[1]!))) map.set(parseInt(e[1]!, 16), u16(e[2]!));
  }
  const rangeBlocks = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((blk = rangeBlocks.exec(cmap))) {
    const rx = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let e: RegExpExecArray | null;
    while ((e = rx.exec(blk[1]!))) {
      const lo = parseInt(e[1]!, 16), hi = parseInt(e[2]!, 16), dst = u16(e[3]!);
      for (let c = lo, d = dst; c <= hi; c++, d++) map.set(c, d);
    }
  }
  return map;
}

describe('RTL paint geometry — END-TO-END on the rendered page bytes (ToUnicode-resolved)', () => {
  it('the rendered page paints ן (U+05DF) at the SMALLEST x for "דנה כהן" (raw glyph order, no reconstruction)', async () => {
    const doc = await PDFDocument.create();
    const nf = await embedCoverFonts(doc, true);
    const page = doc.addPage([320, 100]);
    page.drawText(nf.prepare(DANA), { x: 20, y: 44, size: 24, font: nf.pick(DANA, false) });
    const bytes = await doc.save({ useObjectStreams: false });

    const streams = inflateStreams(bytes);
    const content = streams.find((s) => /\bTj\b/.test(s) && /\bBT\b/.test(s));
    assert.ok(content, 'located the page content stream');
    const drawnIds = extractTjGlyphIds(content);

    const cmapText = streams.find((s) => /beginbfchar|beginbfrange/.test(s));
    assert.ok(cmapText, 'located the ToUnicode CMap stream');
    const toUni = parseToUnicode(cmapText);

    const drawnUnicode = drawnIds.map((id) => {
      const u = toUni.get(id);
      assert.ok(u != null, `ToUnicode has no mapping for drawn glyph id ${id} (drawn ids ${drawnIds.join(',')})`);
      return u;
    });

    assert.equal(drawnUnicode[0], 0x05df, `first-painted glyph on the page must be ן (U+05DF); got ${hx(drawnUnicode[0]!)} — page paint order ${hxs(drawnUnicode)}`);
    assert.deepEqual(drawnUnicode, DANA_VISUAL, `rendered-page paint order ${hxs(drawnUnicode)} must be visual order ${hxs(DANA_VISUAL)}`);
  });
});

describe('forceLtrLayout — installs the LTR wrap on the embedded fontkit font (guarded)', () => {
  it('marks BOTH embedded DejaVu faces (regular + bold) as LTR-forced via embedCoverFonts', async () => {
    const doc = await PDFDocument.create();
    const nf = await embedCoverFonts(doc, true);
    for (const bold of [false, true]) {
      const fk = (nf.pick(DANA, bold) as unknown as { embedder: { font: { __ltrForced?: boolean } } }).embedder.font;
      assert.equal(fk.__ltrForced, true, `${bold ? 'bold' : 'regular'} DejaVu face must be LTR-forced by embedCoverFonts`);
    }
  });

  it('is idempotent — a second forceLtrLayout does NOT re-wrap / double-reverse', async () => {
    const doc = await PDFDocument.create();
    const nf = await embedCoverFonts(doc, true);
    const font = nf.pick(DANA, false);
    forceLtrLayout(font); // second application on the same face — must be a no-op
    forceLtrLayout(font); // third, for good measure
    const glyphs = (font as unknown as { embedder: { font: { layout(t: string): { glyphs: Array<{ codePoints: number[] }> } } } })
      .embedder.font.layout(toVisualOrder(DANA)).glyphs;
    assert.deepEqual(glyphs.flatMap((g) => g.codePoints), DANA_VISUAL, 'still paints correct visual order after repeated wrapping');
  });

  it('throws LOUDLY if pdf-lib no longer exposes the fontkit layout (no silent RTL regress on a dep bump)', () => {
    assert.throws(() => forceLtrLayout({} as never), /cannot reach fontkit layout/i, 'no embedder → throw');
    assert.throws(() => forceLtrLayout({ embedder: {} } as never), /cannot reach fontkit layout/i, 'embedder without .font → throw');
    assert.throws(() => forceLtrLayout({ embedder: { font: {} } } as never), /cannot reach fontkit layout/i, 'font without .layout → throw');
  });
});
