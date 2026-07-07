/**
 * Return-what-we-sent tests — F-6.4 / AC-14, plus the #32.1 PDF-part extraction.
 *
 * A forwarded reply must carry the canonical PDF back byte-identically. We extract
 * every PDF attachment from the raw MIME (base64/7bit/qp, application/pdf or
 * .pdf-named, at any multipart nesting), SHA-256 each, and accept only an exact
 * match to the stored canonical hash. No PDF part → missing; a PDF that differs by
 * even one byte → modified.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { extractPdfAttachments } from './mimeExtract.js';
import { checkForwardedAttachment, sha256Hex } from './attachmentCheck.js';

// A minimal but real PDF byte sequence ("%PDF-1.7" + body + "%%EOF").
const PDF_BYTES = new Uint8Array(
  Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1'),
);
const PDF_SHA = sha256Hex(PDF_BYTES);

function b64(bytes: Uint8Array, wrap = 0): string {
  const s = Buffer.from(bytes).toString('base64');
  if (!wrap) return s;
  return (s.match(new RegExp(`.{1,${wrap}}`, 'g')) ?? [s]).join('\r\n');
}

/** Build a multipart/mixed forward: typed text part + one attachment part. */
function forwardWith(opts: {
  bytes?: Uint8Array;
  cte?: string;
  contentType?: string;
  disposition?: string;
  omitAttachment?: boolean;
}): string {
  const lines = [
    'From: alice@example.com',
    'To: reply-to-sign@kysigned.com',
    'Subject: Fwd: Please sign [ksgn-abc]',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BOUND"',
    '',
    '--BOUND',
    'Content-Type: text/plain; charset=us-ascii',
    '',
    'I sign this document',
    '',
  ];
  if (!opts.omitAttachment) {
    const cte = opts.cte ?? 'base64';
    const body =
      cte === 'base64'
        ? b64(opts.bytes ?? PDF_BYTES, 64)
        : Buffer.from(opts.bytes ?? PDF_BYTES).toString('latin1');
    lines.push(
      '--BOUND',
      `Content-Type: ${opts.contentType ?? 'application/pdf; name="contract.pdf"'}`,
      `Content-Transfer-Encoding: ${cte}`,
      opts.disposition ?? 'Content-Disposition: attachment; filename="contract.pdf"',
      '',
      body,
    );
  }
  lines.push('--BOUND--', '');
  return lines.join('\r\n');
}

describe('extractPdfAttachments — #32.1 forwarded-PDF decoding', () => {
  it('decodes a base64 application/pdf part to exact bytes', () => {
    const atts = extractPdfAttachments(forwardWith({}));
    assert.equal(atts.length, 1);
    assert.equal(atts[0].mediaType, 'application/pdf');
    assert.equal(atts[0].filename, 'contract.pdf');
    assert.deepEqual([...atts[0].bytes], [...PDF_BYTES]);
  });

  it('detects a .pdf-named application/octet-stream attachment', () => {
    const atts = extractPdfAttachments(
      forwardWith({ contentType: 'application/octet-stream; name="contract.pdf"' }),
    );
    assert.equal(atts.length, 1);
    assert.deepEqual([...atts[0].bytes], [...PDF_BYTES]);
  });

  it('ignores non-PDF attachments (e.g. a .txt note)', () => {
    const atts = extractPdfAttachments(
      forwardWith({
        contentType: 'text/plain; name="note.txt"',
        disposition: 'Content-Disposition: attachment; filename="note.txt"',
      }),
    );
    assert.equal(atts.length, 0);
  });

  it('finds a PDF nested under multipart/mixed > multipart/alternative siblings', () => {
    const mime = [
      'From: bob@corp.example',
      'To: reply-to-sign@kysigned.com',
      'Content-Type: multipart/mixed; boundary="OUT"',
      '',
      '--OUT',
      'Content-Type: multipart/alternative; boundary="IN"',
      '',
      '--IN',
      'Content-Type: text/plain',
      '',
      'I sign this document',
      '--IN',
      'Content-Type: text/html',
      '',
      '<p>I sign this document</p>',
      '--IN--',
      '--OUT',
      'Content-Type: application/pdf; name="c.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      b64(PDF_BYTES, 64),
      '--OUT--',
      '',
    ].join('\r\n');
    const atts = extractPdfAttachments(mime);
    assert.equal(atts.length, 1);
    assert.deepEqual([...atts[0].bytes], [...PDF_BYTES]);
  });

  it('returns [] when there is no attachment', () => {
    assert.deepEqual(extractPdfAttachments(forwardWith({ omitAttachment: true })), []);
  });
});

describe('checkForwardedAttachment — F-6.4 byte-equality (AC-14)', () => {
  it('accepts a byte-identical canonical PDF', () => {
    const r = checkForwardedAttachment(forwardWith({}), PDF_SHA);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.sha256, PDF_SHA);
      assert.equal(r.filename, 'contract.pdf');
    }
  });

  it('rejects a one-byte-modified PDF as "modified"', () => {
    const tampered = new Uint8Array(PDF_BYTES);
    tampered[tampered.length - 2] ^= 0x01; // flip one bit, not the trailing newline
    const r = checkForwardedAttachment(forwardWith({ bytes: tampered }), PDF_SHA);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'modified');
  });

  it('rejects a forward with no PDF attachment as "missing"', () => {
    const r = checkForwardedAttachment(forwardWith({ omitAttachment: true }), PDF_SHA);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'missing');
  });

  it('accepts when one of several attachments matches the canonical hash', () => {
    const mime = [
      'From: a@b.com',
      'To: reply-to-sign@kysigned.com',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain',
      '',
      'I sign this document',
      '--B',
      'Content-Type: application/pdf; name="other.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      b64(new Uint8Array(Buffer.from('%PDF-decoy', 'latin1')), 64),
      '--B',
      'Content-Type: application/pdf; name="contract.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      b64(PDF_BYTES, 64),
      '--B--',
      '',
    ].join('\r\n');
    const r = checkForwardedAttachment(mime, PDF_SHA);
    assert.equal(r.ok, true);
  });

  it('treats a present-but-all-mismatching set as "modified", not "missing"', () => {
    const r = checkForwardedAttachment(
      forwardWith({ bytes: new Uint8Array(Buffer.from('%PDF-different', 'latin1')) }),
      PDF_SHA,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'modified');
  });

  it('handles a 7bit (un-encoded) attachment body', () => {
    const text = new Uint8Array(Buffer.from('%PDF-plain-7bit-body\n%%EOF\n', 'latin1'));
    const r = checkForwardedAttachment(
      forwardWith({ bytes: text, cte: '7bit' }),
      sha256Hex(text),
    );
    assert.equal(r.ok, true);
  });
});
