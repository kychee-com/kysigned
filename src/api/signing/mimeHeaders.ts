/**
 * mimeHeaders — shared RFC-5322 header extraction for the inbound forward path.
 *
 * ONE canonical parser for the From / Subject / arbitrary-header reads consumed by
 * the forward-processing pipeline — `checkReplyMembership` (extractSubject /
 * extractFrom) and `dkimVerify` (extractFrom). From-extraction is uniformly robust,
 * notably the bare-address fallback for the RFC-5322 comment form `addr (Name)`
 * (no angle brackets), so a real signer is never silently dropped/misaligned.
 */
import { Buffer } from 'node:buffer';

/** The header block (everything before the first empty line). */
function headerSection(rawMime: string): string {
  const crlf = rawMime.indexOf('\r\n\r\n');
  const lf = rawMime.indexOf('\n\n');
  const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf : lf;
  return end >= 0 ? rawMime.slice(0, end) : rawMime;
}

/** First value of a named header (case-insensitive), RFC-5322 continuation lines unfolded. */
export function getHeaderValue(rawMime: string, name: string): string {
  const unfolded = headerSection(rawMime).replace(/\r?\n[ \t]+/g, ' ');
  const target = name.toLowerCase();
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    if (line.slice(0, i).trim().toLowerCase() === target) return line.slice(i + 1).trim();
  }
  return '';
}

/**
 * Extract the bare email address (lowercased) from a header value:
 *   `Display Name <addr>` → addr; else the first bare `addr@addr` token (handles
 *   the RFC-5322 comment form `addr (Name)`); else the whole trimmed value.
 */
export function extractAddressFromValue(value: string): string {
  const angle = value.match(/<([^>]+)>/);
  if (angle) return angle[1].trim().toLowerCase();
  const bare = value.match(/[^\s<>]+@[^\s<>]+/);
  return (bare ? bare[0] : value).trim().toLowerCase();
}

/** Bare From address (lowercased), or '' if there is no From header. */
export function extractFrom(rawMime: string): string {
  return extractAddressFromValue(getHeaderValue(rawMime, 'from'));
}

/**
 * RFC 2047 encoded-word (`=?charset?B|Q?text?=`) decoder for a header VALUE.
 *
 * A forwarding client encodes the WHOLE Subject as soon as it carries ANY non-ASCII
 * char (em-dash, smart quote, accent, non-Latin script) and FOLDS it across several
 * encoded-words. The `[ksgn-<id>]` routing token is then split across words and, in
 * Q-encoding, `[`→`=5B` / `-`→`=2D` — so a regex over the RAW header finds no
 * `[ksgn-` literal and the forward drops as `no_subject_tokens`, silently losing the
 * signature (prod bug, 2026-06-24). We must decode before reading the token and —
 * per §6.2 — DROP the linear whitespace separating two ADJACENT encoded-words (else
 * a token split `…c7aa76?= =?…a6677` keeps a stray space and the 32-hex run breaks).
 * Whitespace bordering NON-encoded text is preserved. Bytes are decoded per charset
 * (TextDecoder, latin1 fallback); the ASCII token survives any charset. Input with
 * no encoded-word is returned unchanged.
 */
const ENCODED_WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;

function decodeEncodedWordBytes(encoding: string, text: string): Buffer {
  if (encoding.toLowerCase() === 'b') return Buffer.from(text, 'base64');
  // Q-encoding: `_` is a space; `=XX` is a hex byte; everything else is literal.
  const decoded = text
    .replace(/_/g, ' ')
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  return Buffer.from(decoded, 'latin1');
}

function bytesToText(charset: string, bytes: Buffer): string {
  try {
    return new TextDecoder(charset.trim().toLowerCase()).decode(bytes);
  } catch {
    return bytes.toString('latin1'); // unknown charset — token chars are ASCII anyway
  }
}

export function decodeMimeHeader(value: string): string {
  if (!value || value.indexOf('=?') < 0) return value; // fast path: nothing encoded
  let out = '';
  let lastIndex = 0;
  let prevWasEncoded = false;
  ENCODED_WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENCODED_WORD.exec(value)) !== null) {
    const gap = value.slice(lastIndex, m.index);
    // §6.2: linear whitespace between two adjacent encoded-words is NOT text.
    if (!(prevWasEncoded && /^[ \t\r\n]*$/.test(gap))) out += gap;
    out += bytesToText(m[1], decodeEncodedWordBytes(m[2], m[3]));
    lastIndex = m.index + m[0].length;
    prevWasEncoded = true;
  }
  out += value.slice(lastIndex);
  return out;
}

/**
 * Subject value (RFC 2047 decoded), or '' if there is no Subject header. Decoding
 * is what lets the `[ksgn-<id>]` token survive a non-ASCII document name (AC-11).
 */
export function extractSubject(rawMime: string): string {
  return decodeMimeHeader(getHeaderValue(rawMime, 'subject'));
}
