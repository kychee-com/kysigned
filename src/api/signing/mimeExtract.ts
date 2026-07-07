/**
 * MIME extraction for the intent-line check (F3.3.6.5 / F3.3.3(e)).
 *
 * Returns the FIRST `text/plain` part of a raw RFC-822 message — the body region
 * the "I sign this document" intent check must inspect. Handles both shapes seen
 * across every mainstream client in the 8-sample study
 * (the operator's private client-sample corpus):
 *   - single-part `text/plain`               (Apple Mail; Outlook plain/default)
 *   - `multipart/alternative`, first text/plain part (Gmail; Outlook rich)
 *
 * This locates the intent-line body region ONLY. The DKIM signature is verified
 * over the ORIGINAL raw MIME (the `bh=` body hash covers the whole body), so we
 * never reconstruct or re-hash a synthetic message.
 *
 * Returns `null` when there is no `text/plain` part. iPhone / Apple Mail DO forward
 * HTML-only (no text/plain), so the intent callers use `extractSigningText` below —
 * it falls back to the `text/html` part rather than rejecting the forward (F-6.3).
 */

// Isomorphic (browser + Node): no node:buffer — base64/latin1 decode via the
// web-standard `atob` + charCode mapping, so the offline web verifier (F-10.1)
// can share this exact MIME extractor with the Node signing path.
function base64ToBytes(b64: string): Uint8Array {
  // Lenient like Node's `Buffer.from(b64, 'base64')`: drop any non-alphabet
  // characters (whitespace AND post-completion corruption) and re-pad, so a
  // tampered attachment decodes to wrong bytes (→ "modified" verdict) rather than
  // making the strict `atob` throw. The verifier must degrade, never crash.
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function latin1ToBytes(s: string): Uint8Array {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
  return u;
}

export interface TextPlainPart {
  /** Raw (still CTE-encoded) bytes of the part body, as text. */
  content: string;
  /** Content-Transfer-Encoding of the part, lowercased; defaults to '7bit'. */
  cte: string;
  /** charset of the part, lowercased; defaults to 'us-ascii' (RFC 2045 default). */
  charset: string;
}

/**
 * A decoded PDF attachment from a forwarded message (F-6.4 / #32.1). When the
 * signer forwards the signing-request email, the canonical PDF rides along as a
 * `application/pdf` (or `.pdf`-named) MIME part, usually base64-encoded. The
 * return-what-we-sent gate decodes it to raw bytes to SHA-256 against the stored
 * canonical PDF.
 */
export interface PdfAttachment {
  /** Filename from Content-Disposition `filename=` or Content-Type `name=`, or null. */
  filename: string | null;
  /** The part's Content-Type media type, lowercased. */
  mediaType: string;
  /** Decoded raw bytes of the attachment. */
  bytes: Uint8Array;
}

const HEADER_BODY_SEP = /\r\n\r\n|\n\n/;

/** Split a MIME section into { headers, body } at the first blank line. */
function splitHeadersBody(section: string): { headers: string; body: string } {
  const m = HEADER_BODY_SEP.exec(section);
  if (!m) return { headers: section, body: '' };
  return {
    headers: section.slice(0, m.index),
    body: section.slice(m.index + m[0].length),
  };
}

/**
 * Unfold (RFC 5322 §2.2.3) + parse headers into a lowercased-name map.
 * First occurrence wins (duplicate critical headers are rejected upstream
 * per F3.3.3(h); this parser only needs a stable read).
 */
function parseHeaders(headerSection: string): Record<string, string> {
  const unfolded = headerSection.replace(/\r?\n[ \t]+/g, ' ');
  const out: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name in out) continue;
    out[name] = line.slice(colon + 1).trim();
  }
  return out;
}

interface ParsedContentType {
  mediaType: string;
  boundary?: string;
  charset?: string;
}

/** Parse a Content-Type value into { mediaType, boundary, charset } (all lowercased). */
function parseContentType(value: string | undefined): ParsedContentType {
  if (!value) return { mediaType: 'text/plain' }; // RFC 2045 default
  const mediaType = (value.split(';')[0] ?? '').trim().toLowerCase();
  const boundaryM = /boundary\s*=\s*"?([^";\s]+)"?/i.exec(value);
  const charsetM = /charset\s*=\s*"?([^";\s]+)"?/i.exec(value);
  return {
    mediaType,
    boundary: boundaryM?.[1],
    charset: charsetM?.[1]?.toLowerCase(),
  };
}

function asPart(headers: Record<string, string>, body: string): TextPlainPart {
  const ct = parseContentType(headers['content-type']);
  return {
    content: body,
    cte: (headers['content-transfer-encoding'] || '7bit').trim().toLowerCase(),
    charset: ct.charset || 'us-ascii',
  };
}

/**
 * Split a multipart body into its parts by boundary (RFC 2046 §5.1): each part
 * is delimited by a `--boundary` line; the closing delimiter is `--boundary--`.
 * Drops the preamble (before the first delimiter) and the epilogue/closing.
 */
function splitMultipart(body: string, boundary: string): string[] {
  const chunks = body.split(`--${boundary}`);
  const parts: string[] = [];
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i] ?? '';
    if (chunk.startsWith('--')) break; // closing delimiter `--boundary--`
    parts.push(chunk.replace(/^\r?\n/, '')); // strip the CRLF after the delimiter line
  }
  return parts;
}

/**
 * Find the first leaf part of `mediaType` (e.g. 'text/plain' or 'text/html') in a
 * raw RFC-822 message, walking nested multiparts to any depth. Returns null when
 * absent. The DKIM body hash covers the whole body, so this only LOCATES the region
 * — it never reconstructs or re-hashes.
 */
function extractFirstPartOfType(rawMime: string, mediaType: string): TextPlainPart | null {
  const { headers: headerSection, body } = splitHeadersBody(rawMime);
  const headers = parseHeaders(headerSection);
  const ct = parseContentType(headers['content-type']);

  if (ct.mediaType === mediaType) {
    return asPart(headers, body);
  }

  if (ct.mediaType.startsWith('multipart/') && ct.boundary) {
    for (const partSection of splitMultipart(body, ct.boundary)) {
      const { headers: ph, body: pb } = splitHeadersBody(partSection);
      const partHeaders = parseHeaders(ph);
      const partCt = parseContentType(partHeaders['content-type']);
      if (partCt.mediaType === mediaType) {
        return asPart(partHeaders, pb);
      }
      // Nested multipart (e.g. multipart/mixed wrapping multipart/alternative).
      if (partCt.mediaType.startsWith('multipart/') && partCt.boundary) {
        const nested = extractFirstPartOfType(partSection, mediaType);
        if (nested) return nested;
      }
    }
    return null;
  }

  // Single-part of a different media type → not found.
  return null;
}

/** The first `text/plain` part of a raw RFC-822 message, or null (HTML-only). */
export function extractFirstTextPlain(rawMime: string): TextPlainPart | null {
  return extractFirstPartOfType(rawMime, 'text/plain');
}

/** The first `text/html` part — the intent-line fallback for HTML-only forwards. */
export function extractFirstTextHtml(rawMime: string): TextPlainPart | null {
  return extractFirstPartOfType(rawMime, 'text/html');
}

/** A text region carrying the signing intent, plus whether it came from HTML. */
export interface SigningTextPart extends TextPlainPart {
  /** true when the intent text came from a text/html part (no text/plain existed). */
  isHtml: boolean;
}

/**
 * The body region to read the signing intent from (F-6.3): the first `text/plain`
 * part when present, else the first `text/html` part — iPhone / Apple Mail forward
 * HTML-ONLY. Returns null only when the message has neither. Callers pass the
 * returned `isHtml` to `validateSigningIntent` / `firstIntentLineVerbatim` so an
 * HTML body is reduced to text before the first-line check.
 */
export function extractSigningText(rawMime: string): SigningTextPart | null {
  const plain = extractFirstTextPlain(rawMime);
  if (plain) return { ...plain, isHtml: false };
  const html = extractFirstTextHtml(rawMime);
  if (html) return { ...html, isHtml: true };
  return null;
}

/** Filename from Content-Disposition `filename=` (preferred) or Content-Type `name=`. */
function parseAttachmentFilename(headers: Record<string, string>): string | null {
  const cd = headers['content-disposition'];
  const fromDisposition = cd && /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  if (fromDisposition) return fromDisposition[1].trim();
  const ct = headers['content-type'];
  const fromName = ct && /name\s*=\s*"?([^";]+)"?/i.exec(ct);
  if (fromName) return fromName[1].trim();
  return null;
}

/** Decode a leaf part body to raw bytes per its Content-Transfer-Encoding. */
function decodePartBytes(body: string, cte: string): Uint8Array {
  const enc = (cte || '7bit').trim().toLowerCase();
  if (enc === 'base64') {
    return base64ToBytes(body);
  }
  if (enc === 'quoted-printable') {
    const decoded = body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return latin1ToBytes(decoded);
  }
  // 7bit / 8bit / binary — the body bytes are the content bytes (latin1 = 1:1).
  return latin1ToBytes(body);
}

function isPdfPart(mediaType: string, filename: string | null): boolean {
  return mediaType === 'application/pdf' || (!!filename && /\.pdf$/i.test(filename));
}

function collectPdfParts(section: string, out: PdfAttachment[]): void {
  const { headers: headerSection, body } = splitHeadersBody(section);
  const headers = parseHeaders(headerSection);
  const ct = parseContentType(headers['content-type']);

  if (ct.mediaType.startsWith('multipart/') && ct.boundary) {
    for (const part of splitMultipart(body, ct.boundary)) {
      collectPdfParts(part, out);
    }
    return;
  }

  const filename = parseAttachmentFilename(headers);
  if (isPdfPart(ct.mediaType, filename)) {
    // RFC 2046 §5.1.1: the CRLF immediately preceding the next boundary delimiter
    // belongs to the delimiter, not the part body. Strip that single framing
    // newline so binary/7bit/quoted-printable bytes hash byte-exactly. (base64
    // also strips internal whitespace in decodePartBytes, so this is a no-op there.)
    const framedBody = body.replace(/\r?\n$/, '');
    out.push({
      filename,
      mediaType: ct.mediaType,
      bytes: decodePartBytes(framedBody, headers['content-transfer-encoding'] ?? '7bit'),
    });
  }
}

/**
 * Collect every PDF attachment in a raw RFC-822 message (F-6.4 / #32.1): walks the
 * multipart tree to any depth and decodes each `application/pdf` (or `.pdf`-named)
 * leaf part to raw bytes. Non-PDF parts are skipped. Returns [] when none are found.
 */
export function extractPdfAttachments(rawMime: string): PdfAttachment[] {
  const out: PdfAttachment[] = [];
  collectPdfParts(rawMime, out);
  return out;
}
