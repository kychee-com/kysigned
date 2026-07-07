import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFirstTextPlain, extractSigningText } from './mimeExtract.js';

// Synthetic fixtures mirroring real client email samples (the operator keeps the
// real corpus private, as ground truth). The public repo stays self-contained:
// structurally-equivalent MIME, example addresses, no real DKIM sigs (the
// extractor cares only about MIME structure + the text/plain body, not the DKIM
// signature, which is verified separately).
const join = (...lines: string[]) => lines.join('\r\n');

// 03/04 — Apple Mail (single-part text/plain, 7bit). 04 has the iPhone signature.
const APPLE_MAC = join(
  'From: signer@example.com',
  'To: reply-to-sign@kysigned.com',
  'Subject: [hash] [env] Sign',
  'Content-Type: text/plain;',
  '\tcharset=us-ascii',
  'Content-Transfer-Encoding: 7bit',
  'Mime-Version: 1.0',
  '',
  'I SIGN',
  '',
);
const APPLE_IPHONE = join(
  'From: Signer Name <signer@example.com>',
  'Content-Type: text/plain; charset=us-ascii',
  'Content-Transfer-Encoding: 7bit',
  'Mime-Version: 1.0',
  '',
  'I SIGN',
  'Sent from my iPhone',
);

// 06/07 — Outlook plain/default (single-part text/plain, quoted-printable, iso-8859-1).
// The trailing "=" is a QP soft line-break.
const OUTLOOK_TEXT = join(
  'From: Nimrod Example <signer@example.com>',
  'Content-Type: text/plain; charset="iso-8859-1"',
  'Content-Transfer-Encoding: quoted-printable',
  'MIME-Version: 1.0',
  '',
  'I SIGN=',
);

// 00/01/02 — Gmail (multipart/alternative; text/plain first, then text/html; 7bit).
const GMAIL_MULTIPART = join(
  'From: Signer Name <signer@example.com>',
  'Content-Type: multipart/alternative; boundary="000000000000bddbad"',
  'MIME-Version: 1.0',
  '',
  '--000000000000bddbad',
  'Content-Type: text/plain; charset="UTF-8"',
  '',
  'I SIGN',
  '',
  '--000000000000bddbad',
  'Content-Type: text/html; charset="UTF-8"',
  '',
  '<div dir="ltr">I SIGN</div>',
  '',
  '--000000000000bddbad--',
  '',
);

// 05 — Outlook rich (multipart/alternative; both parts quoted-printable, iso-8859-1).
const OUTLOOK_RICH = join(
  'From: Nimrod Example <signer@example.com>',
  'Content-Type: multipart/alternative;',
  '\tboundary="_000_DU0P192_"',
  'MIME-Version: 1.0',
  '',
  '--_000_DU0P192_',
  'Content-Type: text/plain; charset="iso-8859-1"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'I SIGN',
  '',
  '--_000_DU0P192_',
  'Content-Type: text/html; charset="iso-8859-1"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<html><body><div>I SIGN</div></body></html>',
  '',
  '--_000_DU0P192_--',
);

// Negative — HTML-only with no text/plain part.
const HTML_ONLY = join(
  'From: signer@example.com',
  'Content-Type: text/html; charset="UTF-8"',
  'MIME-Version: 1.0',
  '',
  '<div>I SIGN</div>',
);

// Edge — multipart with text/html BEFORE text/plain; still find the text/plain part.
const MULTIPART_HTML_FIRST = join(
  'From: signer@example.com',
  'Content-Type: multipart/alternative; boundary="BOUND"',
  '',
  '--BOUND',
  'Content-Type: text/html; charset="UTF-8"',
  '',
  '<div>I SIGN</div>',
  '',
  '--BOUND',
  'Content-Type: text/plain; charset="UTF-8"',
  '',
  'I SIGN',
  '',
  '--BOUND--',
);

test('single-part text/plain 7bit (Apple Mac) → content + 7bit + charset', () => {
  const r = extractFirstTextPlain(APPLE_MAC);
  assert.ok(r, 'should extract a text/plain part');
  assert.equal(r!.cte, '7bit');
  assert.equal(r!.charset, 'us-ascii');
  assert.equal(r!.content.trim(), 'I SIGN');
});

test('single-part text/plain with trailing iPhone signature → full part content', () => {
  const r = extractFirstTextPlain(APPLE_IPHONE);
  assert.ok(r);
  assert.match(r!.content, /^I SIGN/);
  assert.match(r!.content, /Sent from my iPhone/);
  assert.equal(r!.cte, '7bit');
});

test('single-part text/plain quoted-printable iso-8859-1 (Outlook plain) → QP cte + soft-break content', () => {
  const r = extractFirstTextPlain(OUTLOOK_TEXT);
  assert.ok(r);
  assert.equal(r!.cte, 'quoted-printable');
  assert.equal(r!.charset, 'iso-8859-1');
  assert.match(r!.content, /^I SIGN=?/);
});

test('multipart/alternative (Gmail) → first text/plain part, not the html', () => {
  const r = extractFirstTextPlain(GMAIL_MULTIPART);
  assert.ok(r);
  assert.equal(r!.cte, '7bit');
  assert.equal(r!.charset, 'utf-8');
  assert.equal(r!.content.trim(), 'I SIGN');
  assert.doesNotMatch(r!.content, /<div/);
});

test('multipart/alternative quoted-printable (Outlook rich) → first text/plain part with QP cte', () => {
  const r = extractFirstTextPlain(OUTLOOK_RICH);
  assert.ok(r);
  assert.equal(r!.cte, 'quoted-printable');
  assert.equal(r!.charset, 'iso-8859-1');
  assert.equal(r!.content.trim(), 'I SIGN');
  assert.doesNotMatch(r!.content, /<html/);
});

test('HTML-only (no text/plain part) → null', () => {
  assert.equal(extractFirstTextPlain(HTML_ONLY), null);
});

test('multipart with text/html before text/plain → still finds text/plain', () => {
  const r = extractFirstTextPlain(MULTIPART_HTML_FIRST);
  assert.ok(r);
  assert.equal(r!.content.trim(), 'I SIGN');
});

// extractSigningText — text/plain first, else fall back to text/html (iPhone HTML-only).
test('extractSigningText prefers text/plain when present (isHtml=false)', () => {
  const r = extractSigningText(GMAIL_MULTIPART);
  assert.ok(r);
  assert.equal(r!.isHtml, false);
  assert.equal(r!.content.trim(), 'I SIGN');
});

test('extractSigningText falls back to text/html when there is NO text/plain (iPhone)', () => {
  const r = extractSigningText(HTML_ONLY);
  assert.ok(r);
  assert.equal(r!.isHtml, true);
  assert.match(r!.content, /I SIGN/);
});

test('extractSigningText returns null when there is neither text/plain nor text/html', () => {
  const pdfOnly = join('From: x@example.com', 'Content-Type: application/pdf; name="d.pdf"', '', 'JVBER');
  assert.equal(extractSigningText(pdfOnly), null);
});
