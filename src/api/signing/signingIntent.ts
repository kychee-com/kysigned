/**
 * Signing-intent gate — F-6.3 (spec v0.4.0, evidence-bundle "forward-to-sign" model).
 *
 * The signer FORWARDS the signing-request email (with the canonical PDF attached)
 * and types the intent line at the very top, above the client's forwarded-message
 * marker. This gate decides whether that first line is the signing intent.
 *
 * F-6.3: the first NON-EMPTY plain-text line above the forwarded-message marker,
 * after CTE decoding and whitespace normalization, must EQUAL the words
 * `i sign this document` compared case-insensitively, with nothing else on that
 * line EXCEPT an optional trailing `.` or `!` (with or without a leading space).
 * Content on lines BELOW the first is ignored (client signature blocks, the
 * quoted thread, the forwarded message itself). Any other first line → rejection
 * bounce (F-7 / AC-15).
 *
 * This is a WHOLE-LINE exact match: trailing words, a negation, reservations,
 * or the legacy `I SIGN` phrase all FAIL because
 * the normalized first line does not equal the canonical phrase. This single
 * check subsumes the old `validateApprovalBody` (leads-with) + `checkSignatureLineExact`
 * (same-line trailing-text) pair.
 *
 * Capitalization is NEVER a rejection cause (AC-15): user-facing copy renders the
 * line in sentence case precisely so caps are never implied as required, but any
 * capitalization the signer types is accepted.
 */

export const CANONICAL_INTENT = 'i sign this document';

export interface SigningIntentResult {
  valid: boolean;
  /** Why it was rejected (absent when valid). */
  reason?: 'no_intent_line' | 'wrong_phrase';
  /**
   * The first non-empty line as received (whitespace-normalized, capped) — used
   * by the F-7 corrective bounce to quote back exactly what the signer wrote.
   */
  detectedLine?: string;
}

/**
 * Decode a quoted-printable part body enough to judge the first line: join soft
 * line-breaks (RFC 2045 §6.7), drop a lone trailing `=` (Outlook emits the part
 * with a trailing soft break before the MIME boundary), and resolve `=XX` hex
 * escapes to their raw byte. The canonical phrase carries no QP escapes and is
 * far below the 76-char wrap, so for a clean send this is a no-op — but a signer
 * who pastes punctuation or whose client wraps still gets a faithful first line.
 */
function decodeQuotedPrintable(content: string): string {
  return content
    .replace(/=\r?\n/g, '')
    .replace(/=$/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Decode a base64 part body to the same latin1-bytes-as-string form the QP path
 * yields (each char code = one raw byte), so the first-line + nbsp logic applies
 * identically. Outlook base64-encodes the WHOLE text part as soon as the forwarded
 * body carries a non-ASCII char (e.g. the em-dash in a document name, echoed in the
 * quoted original), so the typed "I sign this document" would otherwise be read as a
 * base64 blob → wrong_phrase. Uses `atob` (web-standard, in Node + browsers) to stay
 * isomorphic with the offline web verifier. Lenient: strips non-alphabet chars (MIME
 * line wraps) and re-pads; never throws.
 */
function decodeBase64Text(content: string): string {
  const clean = content.replace(/[^A-Za-z0-9+/]/g, '');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  try {
    return atob(padded);
  } catch {
    return content; // degrade, never crash — a bad blob just fails the phrase match
  }
}

/** CTE-decode a part body for first-line judging: quoted-printable, base64, else 7bit/8bit identity. */
function decodeCteText(content: string, cte?: string): string {
  const enc = (cte ?? '').toLowerCase();
  if (enc === 'quoted-printable') return decodeQuotedPrintable(content);
  if (enc === 'base64') return decodeBase64Text(content);
  return content;
}

/**
 * Reduce an HTML body to candidate text lines for the intent gate. iPhone / Apple
 * Mail forwards HTML-ONLY (no text/plain part), with the typed intent line at the
 * top of `<body>` before a `<br>`, the "Sent from my iPhone" signature, and the
 * forwarded message below. We drop head/style/script, turn block boundaries
 * (`<br>`, `</div>`, `</p>`, `<blockquote>`, …) into newlines, strip the remaining
 * tags, and decode the handful of entities a typed line can carry — so the existing
 * first-non-empty-line logic applies unchanged and naturally stops at the typed
 * line. The signer's provider DKIM body-hash covers this HTML verbatim, so reading
 * the gesture from it is no weaker than from a text/plain part. (F-6.3 / AC-15.)
 */
function htmlToIntentText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    // block boundaries (open AND close) → newline, isolating the first typed line
    // above the signature + the forwarded message that follow it.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:div|p|blockquote|li|h[1-6]|tr|table|ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '') // strip remaining inline tags
    // decode the entities a typed intent line can plausibly carry.
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Whitespace-normalize a single line per F-6.3: collapse every run of whitespace
 * (including tabs and the non-breaking space — both as U+00A0 and as the raw
 * UTF-8 byte-pair 0xC2 0xA0 that a latin1 read of Gmail's `&nbsp;` produces) to a
 * single ASCII space, then trim the ends. Returns the lower-cased result so the
 * caller compares case-insensitively (AC-15).
 */
function normalizeLine(line: string): string {
  return stripWhitespace(line).toLowerCase();
}

/** The same whitespace collapse as {@link normalizeLine} but preserving case — for echoing the offending line back in the bounce. */
function stripWhitespace(line: string): string {
  return line
    .replace(/Â /g, ' ') // raw UTF-8 nbsp byte-pair (latin1 read of &nbsp;)
    .replace(/\s+/g, ' ') // collapse all whitespace (JS \s includes U+00A0) → single space
    .trim();
}

/**
 * The first non-empty line of a forwarded reply's text/plain part, case-preserved
 * and whitespace-collapsed (NOT lower-cased) — the verbatim line the signer typed.
 * `validateSigningIntent` only surfaces `detectedLine` on rejection; the bundle
 * signature page (F-8.1) needs the verbatim line for an ACCEPTED signature too.
 * Returns null when the part has no visible first line. Reuses the same QP-decode +
 * whitespace rules as the gate so the rendered line matches what the gate saw.
 */
export function firstIntentLineVerbatim(content: string, cte?: string, isHtml = false): string | null {
  const cteDecoded = decodeCteText(content, cte);
  const decoded = isHtml ? htmlToIntentText(cteDecoded) : cteDecoded;
  for (const line of decoded.split(/\r\n|\n|\r/)) {
    if (normalizeLine(line) !== '') {
      const shown = stripWhitespace(line);
      return shown.length > 80 ? `${shown.slice(0, 80)}…` : shown;
    }
  }
  return null;
}

/**
 * Validate the signing intent on the first text/plain part of a forwarded reply.
 *
 * @param content the raw (still CTE-encoded) bytes of the first text/plain part,
 *                as extracted by `extractFirstTextPlain`.
 * @param cte     the part's Content-Transfer-Encoding (lowercased). `quoted-printable`
 *                AND `base64` are decoded (Outlook base64-encodes the whole text part
 *                when the forwarded body carries a non-ASCII char); 7bit/8bit/binary
 *                pass through unchanged.
 */
export function validateSigningIntent(content: string, cte?: string, isHtml = false): SigningIntentResult {
  const cteDecoded = decodeCteText(content, cte);
  // HTML-only forwards (iPhone / Apple Mail): reduce the markup to text first so the
  // same first-line rule applies to the typed line at the top of <body> (F-6.3).
  const decoded = isHtml ? htmlToIntentText(cteDecoded) : cteDecoded;

  // First NON-EMPTY line (a line is "empty" if it normalizes to ''). This skips
  // leading blank lines and nbsp-only lines, and naturally stops at the signer's
  // typed line — which sits above the client's forwarded-message marker.
  let rawFirst: string | null = null;
  let normFirst = '';
  for (const line of decoded.split(/\r\n|\n|\r/)) {
    const norm = normalizeLine(line);
    if (norm !== '') {
      rawFirst = line;
      normFirst = norm;
      break;
    }
  }

  if (rawFirst === null) {
    // Nothing visible was typed above the forward (or the whole part is blank).
    return { valid: false, reason: 'no_intent_line' };
  }

  // Accept the canonical phrase with an optional trailing "." or "!" (with or
  // without a leading space) — "i sign this document." / "i sign this document !"
  // (Barry QA). A "?", trailing words, or a negation still fail: only a run of
  // spaces + "." / "!" at the very END of the line is forgiven.
  if (normFirst.replace(/[\s.!]+$/, '') === CANONICAL_INTENT) {
    return { valid: true };
  }

  const shown = stripWhitespace(rawFirst);
  return {
    valid: false,
    reason: 'wrong_phrase',
    detectedLine: shown.length > 80 ? `${shown.slice(0, 80)}…` : shown,
  };
}
