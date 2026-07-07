/**
 * nameFont — #110 tests (Unicode name rendering on the cover / signature page).
 *
 * Two pure, hot-path helpers are TDD-covered here:
 *   (1) `firstUnsupportedNameChar` — the create-time gate predicate, backed by the
 *       EMBEDDED DejaVu Sans glyph coverage (so acceptance == renderability). DejaVu
 *       covers Latin/Greek/Cyrillic/Hebrew/Arabic but NOT CJK, which is exactly the
 *       D3 A+C boundary: Hebrew et al. render; Chinese/Japanese/Korean are rejected.
 *   (2) `toVisualOrder` — a PROPER Unicode Bidi Algorithm (bidi-js) that reorders a
 *       string into visual (draw) order so pdf-lib, which draws glyphs left-to-right
 *       with no bidi, renders Hebrew names correctly, keeps an LTR label/email inside
 *       an RTL line intact, and never touches pure-LTR strings (F-010). NO Arabic
 *       shaping (isolated forms — the documented A+C limitation).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { firstUnsupportedNameChar, toVisualOrder } from './nameFont.ts';

describe('nameFont — firstUnsupportedNameChar (DejaVu Sans coverage gate)', () => {
  it('accepts Latin + European accents (WinAnsi range)', () => {
    for (const s of ['Alice Smith', 'José Müller', 'François Œuvre', 'Åsa Ångström', 'Señor Niño']) {
      assert.equal(firstUnsupportedNameChar(s), null, `should accept "${s}"`);
    }
  });

  it('accepts Latin-Extended beyond WinAnsi (Polish ł, macron ā)', () => {
    assert.equal(firstUnsupportedNameChar('Łukasz Wałęsa'), null);
    assert.equal(firstUnsupportedNameChar('Kauaʻi Māori'.replace('ʻ', '')), null);
  });

  it('accepts Greek, Cyrillic, Hebrew and Arabic names', () => {
    assert.equal(firstUnsupportedNameChar('Αθανάσιος Παπαδόπουλος'), null, 'Greek');
    assert.equal(firstUnsupportedNameChar('Александр Солженицын'), null, 'Cyrillic');
    assert.equal(firstUnsupportedNameChar('אברהם יצחק'), null, 'Hebrew');
    assert.equal(firstUnsupportedNameChar('محمد بن عبد الله'), null, 'Arabic');
  });

  it('accepts the exact #110 Hebrew repro character ו (U+05D5)', () => {
    assert.equal(firstUnsupportedNameChar('ו'), null);
    assert.equal(firstUnsupportedNameChar('Document ו name'), null);
  });

  it('rejects Chinese / Japanese / Korean, naming the exact offending char + label', () => {
    const zh = firstUnsupportedNameChar('中文名字');
    assert.ok(zh, 'Chinese must be rejected');
    assert.equal(zh.char, '中');
    assert.equal(zh.label, 'U+4E2D');

    const ja = firstUnsupportedNameChar('あきら');
    assert.ok(ja, 'Hiragana must be rejected');
    assert.equal(ja.label, 'U+3042');

    const ko = firstUnsupportedNameChar('한국어');
    assert.ok(ko, 'Hangul must be rejected');
    assert.equal(ko.label, 'U+D55C');
  });

  it('reports the FIRST unsupported char in an otherwise-supported string', () => {
    const bad = firstUnsupportedNameChar('David 中 Smith');
    assert.ok(bad);
    assert.equal(bad.char, '中');
  });

  it('treats empty / whitespace / nullish as supported (no false reject)', () => {
    assert.equal(firstUnsupportedNameChar(''), null);
    assert.equal(firstUnsupportedNameChar('   \t\n'), null);
    assert.equal(firstUnsupportedNameChar(undefined as unknown as string), null);
  });
});

describe('nameFont — toVisualOrder (Unicode Bidi Algorithm, bidi-js)', () => {
  it('leaves pure-LTR text byte-identical (fast path — protects existing determinism)', () => {
    assert.equal(toVisualOrder('David Smith'), 'David Smith');
    assert.equal(toVisualOrder('José Müller (jose@example.com)'), 'José Müller (jose@example.com)');
    assert.equal(toVisualOrder('Αθήνα Москва'), 'Αθήνα Москва'); // Greek/Cyrillic are LTR
    assert.equal(toVisualOrder(''), '');
  });

  it('leaves Greek, Cyrillic and accented-Latin names unchanged (F-010 regression guard)', () => {
    // Cyrillic/Greek render fine on the same document — the defect is RTL-specific.
    assert.equal(toVisualOrder('Γιώργος Παπαδόπουλος'), 'Γιώργος Παπαδόπουλος');
    assert.equal(toVisualOrder('Иван Иванов'), 'Иван Иванов');
    assert.equal(toVisualOrder('Åsa Ångström'), 'Åsa Ångström');
  });

  it('reverses a single Hebrew word to visual order (reads RTL when drawn LTR)', () => {
    assert.equal(toVisualOrder('שלום'), 'םולש');
  });

  it('reverses a multi-word Hebrew name to correct visual order (no intra-word/word-order corruption)', () => {
    // דנה כהן reads right-to-left; the visual (draw) order is the full reversal.
    assert.equal(toVisualOrder('דנה כהן'), 'ןהכ הנד');
    assert.equal(toVisualOrder('כהן משפחה'), 'החפשמ ןהכ');
  });

  it('keeps an LTR label to the LEFT of an RTL value (F-010 symptom 3 — signature-page "Signer N:")', () => {
    assert.equal(toVisualOrder('Signer 1: דנה כהן'), 'Signer 1: ןהכ הנד');
    assert.equal(toVisualOrder('Document:    חוזה בדיקה'), 'Document:    הקידב הזוח');
  });

  it('keeps a trailing Latin+digit token as one LTR island in an RTL-base line (F-012: no "8Cycle")', () => {
    // A doc name mixing Hebrew with a trailing ASCII/digit token. First-strong is
    // Hebrew ⇒ RTL base, so the LTR island lands to the LEFT of the (reversed) Hebrew.
    // Per UBA W7 the European number after Latin letters takes L direction, so `Cycle8`
    // stays a single contiguous LTR run — it must NOT come out digit-first as "8Cycle".
    const out = toVisualOrder('חוזה בדיקה Cycle8');
    assert.equal(out, 'Cycle8 הקידב הזוח'); // exact visual (draw) order — same reversed Hebrew as the row above
    assert.ok(out.includes('Cycle8'), `Latin+digit token must stay LTR-intact: ${out}`);
    assert.ok(!out.includes('8Cycle'), `digit must not migrate before the letters: ${out}`);
  });

  it('keeps a Latin+digit island intact under an explicit-LTR base too (signature-page "Document:" path)', () => {
    // The signature page draws "Document:    <name>" as one string ⇒ first-strong is the
    // Latin label ⇒ LTR base, Hebrew reversed in place, the trailing Cycle8 still intact.
    assert.equal(toVisualOrder('Document:    חוזה בדיקה Cycle8'), 'Document:    הקידב הזוח Cycle8');
  });

  it('never reverses an ASCII/email run embedded in an RTL line (F-010 symptom 1)', () => {
    const out = toVisualOrder('דנה כהן <redteam-pilot@kysigned.com>');
    // The email + its angle brackets stay verbatim, left-to-right, readable — ASCII is
    // never touched by RTL reordering (the old code produced ">moc.dengisyk@...<").
    assert.ok(out.includes('<redteam-pilot@kysigned.com>'), `email must stay LTR-intact: ${out}`);
    assert.equal(out, '<redteam-pilot@kysigned.com> ןהכ הנד');
  });

  it('reorders only the Hebrew name inside an English affirmation sentence (F-010 symptom 2)', () => {
    // LTR base ("I,"): the two Hebrew words must NOT swap, and the email stays LTR.
    const out = toVisualOrder('I, דנה כהן (redteam-pilot@kysigned.com), sign this document.');
    assert.ok(out.includes('(redteam-pilot@kysigned.com)'), out);
    assert.equal(out, 'I, ןהכ הנד (redteam-pilot@kysigned.com), sign this document.');
  });
});
