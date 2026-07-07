/**
 * winAnsi — unit tests for the cover-font renderability predicate (#101).
 *
 * The cover draws with pdf-lib's WinAnsi (CP1252) Helvetica; `firstUnrenderableChar`
 * must accept EVERYTHING that font can draw (so we never reject currently-working
 * input) and reject everything it can't (so the renderer never 500s on it).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { firstUnrenderableChar, isWinAnsiEncodable } from './winAnsi.js';

describe('winAnsi — firstUnrenderableChar', () => {
  it('accepts printable ASCII (returns null)', () => {
    for (const s of ['alice@example.com', 'Acme Corp, LLC.', 'a-z A-Z 0-9 !#$%&*+/=?^_{|}~']) {
      assert.equal(firstUnrenderableChar(s), null, s);
    }
  });

  it('accepts Latin-1 accented characters that CP1252 encodes (José, Müller, Ångström…)', () => {
    for (const s of ['José', 'Müller', 'Ångström', 'Renée', 'Søren', 'naïve', 'Zoë', 'François', 'Çelik']) {
      assert.equal(firstUnrenderableChar(s), null, s);
    }
  });

  it('accepts the CP1252 typographic specials our legal copy uses (dashes, curly quotes, bullet, ellipsis, €, ™)', () => {
    for (const s of ['en–dash', 'em—dash', '‘curly’', '“quoted”', '• bullet', 'wait…', '€100', 'kysigned™']) {
      assert.equal(firstUnrenderableChar(s), null, s);
    }
  });

  it('rejects a Cyrillic homoglyph and reports its code point (#101 — the filed case)', () => {
    const bad = firstUnrenderableChar('user@gmaіl.com'); // U+0456 Cyrillic i
    assert.ok(bad);
    assert.equal(bad.char, 'і');
    assert.equal(bad.label, 'U+0456');
  });

  it('rejects CJK, Greek, Hebrew, Arabic and emoji', () => {
    assert.equal(firstUnrenderableChar('李雷')?.label, 'U+674E');
    assert.equal(firstUnrenderableChar('Αθήνα')?.label, 'U+0391');
    assert.ok(firstUnrenderableChar('שלום'));
    assert.ok(firstUnrenderableChar('سلام'));
    // Emoji are astral (surrogate pair) — reported by their true code point, not a lone surrogate.
    assert.equal(firstUnrenderableChar('hi 😀')?.label, 'U+1F600');
  });

  it('returns the FIRST offending character, left to right', () => {
    const bad = firstUnrenderableChar('ok then 李 then 雷');
    assert.equal(bad?.char, '李');
  });

  it('treats the empty string as renderable', () => {
    assert.equal(firstUnrenderableChar(''), null);
  });

  it('isWinAnsiEncodable is the boolean convenience', () => {
    assert.equal(isWinAnsiEncodable('Plain Name'), true);
    assert.equal(isWinAnsiEncodable('Боб'), false); // Cyrillic
  });
});
