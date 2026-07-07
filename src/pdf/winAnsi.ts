/**
 * winAnsi — is a string encodable by pdf-lib's WinAnsi standard font (Helvetica)?
 *
 * ROLE (post-#110). This is no longer the reject gate; that moved to
 * `nameFont.firstUnsupportedNameChar`, backed by the embedded DejaVu Sans glyph
 * coverage (which accepts Greek/Cyrillic/Hebrew/Arabic and rejects only CJK et al.).
 * `winAnsi` is now the FONT-PICKER helper: the cover / signature renderer draws a
 * string with the cheap, searchable `StandardFonts.Helvetica` when
 * `isWinAnsiEncodable` is true, and routes only non-WinAnsi strings to the embedded
 * DejaVu subset (nameFont.ts). Keeping the WinAnsi fast path means all the English
 * legal copy + Latin names render exactly as before (byte-identical, still searchable
 * in the content stream).
 *
 * It accepts the FULL CP1252 set: Western-European names (José, Müller, Ångström) and
 * the typographic characters the legal copy uses (en/em dashes, curly quotes, bullets,
 * ellipsis, euro). Everything else (Cyrillic, Greek, CJK, Arabic, Hebrew, Latin-Extended
 * such as Ł, emoji) is "not WinAnsi" and takes the DejaVu path.
 */

// The 27 CP1252 code points in 0x80–0x9F that map to a Unicode value > 0xFF. The
// rest of CP1252 is 0x20–0x7E and 0xA0–0xFF, which equal their Unicode code points
// one-to-one, so those are handled by range checks below.
const CP1252_HIGH: ReadonlySet<number> = new Set([
  0x20ac, // € (0x80)   euro
  0x201a, // ‚ (0x82)   single low-9 quote
  0x0192, // ƒ (0x83)   florin
  0x201e, // „ (0x84)   double low-9 quote
  0x2026, // … (0x85)   ellipsis
  0x2020, // † (0x86)   dagger
  0x2021, // ‡ (0x87)   double dagger
  0x02c6, // ˆ (0x88)   modifier circumflex
  0x2030, // ‰ (0x89)   per mille
  0x0160, // Š (0x8a)
  0x2039, // ‹ (0x8b)   single left angle quote
  0x0152, // Œ (0x8c)
  0x017d, // Ž (0x8e)
  0x2018, // ‘ (0x91)   left single quote
  0x2019, // ’ (0x92)   right single quote / apostrophe
  0x201c, // “ (0x93)   left double quote
  0x201d, // ” (0x94)   right double quote
  0x2022, // • (0x95)   bullet
  0x2013, // – (0x96)   en dash
  0x2014, // — (0x97)   em dash
  0x02dc, // ˜ (0x98)   small tilde
  0x2122, // ™ (0x99)   trademark
  0x0161, // š (0x9a)
  0x203a, // › (0x9b)   single right angle quote
  0x0153, // œ (0x9c)
  0x017e, // ž (0x9e)
  0x0178, // Ÿ (0x9f)
]);

/** True when a single Unicode code point is encodable by the cover's WinAnsi font. */
function isWinAnsiCodePoint(cp: number): boolean {
  if (cp >= 0x20 && cp <= 0x7e) return true; // printable ASCII
  if (cp >= 0xa0 && cp <= 0xff) return true; // Latin-1 supplement (1:1 in CP1252)
  return CP1252_HIGH.has(cp); // the 0x80–0x9F specials (€, dashes, curly quotes…)
}

export interface UnrenderableChar {
  /** The offending character itself (safe to embed in a JSON/HTTP error body). */
  char: string;
  /** `U+0456`-style code-point label for the user-facing message. */
  label: string;
}

/**
 * The first character of `text` the cover font cannot encode, or `null` when the
 * whole string is renderable. Iterates by code point, so astral characters (emoji,
 * rare CJK) are reported by their true code point rather than a lone surrogate.
 */
export function firstUnrenderableChar(text: string): UnrenderableChar | null {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (!isWinAnsiCodePoint(cp)) {
      return { char: ch, label: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}` };
    }
  }
  return null;
}

/** Convenience boolean: is every character of `text` renderable by the cover font? */
export function isWinAnsiEncodable(text: string): boolean {
  return firstUnrenderableChar(text) === null;
}
