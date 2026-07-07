/**
 * mimeHeaders tests — shared RFC-5322 header extraction (code-review consolidation).
 * One canonical From/Subject/header parser replaces the near-copies previously in
 * inboundHandler, evaluateReply, operatorPreCheckPipeline, and checkReplyMembership.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getHeaderValue, extractAddressFromValue, extractFrom, extractSubject, decodeMimeHeader } from './mimeHeaders.js';
import { parseEnvelopeToken } from '../subjectToken.js';

function raw(headers: string, body = 'I SIGN'): string {
  return headers.replace(/\n/g, '\r\n') + '\r\n\r\n' + body + '\r\n';
}

describe('extractAddressFromValue', () => {
  it('extracts from `Name <addr>`', () => {
    assert.equal(extractAddressFromValue('Alice Example <alice@test.com>'), 'alice@test.com');
  });
  it('extracts a bare address', () => {
    assert.equal(extractAddressFromValue('alice@test.com'), 'alice@test.com');
  });
  it('extracts from an RFC-comment form `addr (Name)` (no angle brackets)', () => {
    assert.equal(extractAddressFromValue('alice@test.com (Alice)'), 'alice@test.com');
  });
  it('lowercases the result', () => {
    assert.equal(extractAddressFromValue('ALICE@TEST.COM'), 'alice@test.com');
  });
  it('falls back to the trimmed value when there is no address', () => {
    assert.equal(extractAddressFromValue('  not-an-address  '), 'not-an-address');
  });
});

describe('getHeaderValue', () => {
  it('returns the value of a named header (case-insensitive name)', () => {
    assert.equal(getHeaderValue(raw('From: a@b.com\nSubject: hi'), 'subject'), 'hi');
  });
  it('unfolds a continuation (folded) header', () => {
    assert.equal(getHeaderValue(raw('Subject: part one\n  part two'), 'subject'), 'part one part two');
  });
  it('returns the first occurrence when a header repeats', () => {
    assert.equal(getHeaderValue(raw('Subject: first\nSubject: second'), 'subject'), 'first');
  });
  it('returns empty string when the header is absent', () => {
    assert.equal(getHeaderValue(raw('From: a@b.com'), 'subject'), '');
  });
});

describe('extractFrom', () => {
  it('extracts the bare From address (angle form)', () => {
    assert.equal(extractFrom(raw('From: Test User <creator@example.com>\nSubject: x')), 'creator@example.com');
  });
  it('extracts the bare From from an RFC-comment form', () => {
    assert.equal(extractFrom(raw('From: creator@example.com (Test User)\nSubject: x')), 'creator@example.com');
  });
  it('returns empty string when there is no From header', () => {
    assert.equal(extractFrom(raw('Subject: x')), '');
  });
});

describe('extractSubject', () => {
  it('extracts the Subject value', () => {
    assert.equal(extractSubject(raw('From: a@b.com\nSubject: Re: [hash] [id] go')), 'Re: [hash] [id] go');
  });
  it('returns empty string when there is no Subject', () => {
    assert.equal(extractSubject(raw('From: a@b.com')), '');
  });
});

// ---------------------------------------------------------------------------
// RFC 2047 encoded-word decoding (regression: 2026-06-24 prod bug).
//
// A non-ASCII char ANYWHERE in the document name (em-dash, smart quote, accent,
// non-Latin script) forces the sending/forwarding client to encode the WHOLE
// Subject as RFC 2047 encoded-words, often FOLDED across several words. The
// `[ksgn-<id>]` routing token is then split across words (e.g. `…c7aa76?= =?…a6677`)
// and Q-encoded (`[`→`=5B`, `-`→`=2D`), so a regex over the RAW header finds no
// `[ksgn-` literal → the forward dropped as `no_subject_tokens` and the signature
// was silently lost. extractSubject MUST decode (per §6.2, dropping the linear
// whitespace between adjacent encoded-words) before token extraction.
// Fixtures below are the EXACT Subject headers Gmail / iCloud / Outlook produced
// when Barry forwarded envelope e5efe8ac (doc name "ACME Approval Form 42-B —…").
// ---------------------------------------------------------------------------
const EXPECTED_ID = 'e5efe8ac-34a7-4791-8163-1c7aa76a6677';
const GMAIL_SUBJ =
  '=?UTF-8?Q?Fwd=3A_Signature_requested=3A_=22ACME_Approval_Form_42=2DB_?= ' +
  '=?UTF-8?Q?=E2=80=94_kysigned_provider_e2e=22_=5Bksgn=2De5efe8ac34a7479181631c7aa76?= ' +
  '=?UTF-8?Q?a6677=5D?=';
const ICLOUD_SUBJ =
  '=?utf-8?Q?Fwd:_Signature_requested:_"ACME_Approval_Form_42-B_?= ' +
  '=?utf-8?Q?=E2=80=94_kysigned_provider_e2e"_[ksgn-e5efe8ac34a7479?= ' +
  '=?utf-8?Q?181631c7aa76a6677]?=';
const OUTLOOK_SUBJ =
  '=?big5?B?Rnc6IFNpZ25hdHVyZSByZXF1ZXN0ZWQ6ICJBQ01FIEFwcHJvdmFsIEZvcm0gNDIt?= ' +
  '=?big5?B?QiChWCBreXNpZ25lZCBwcm92aWRlciBlMmUiIFtrc2duLWU1ZWZlOGFjMzRhNzQ3?= ' +
  '=?big5?Q?9181631c7aa76a6677]?=';

describe('decodeMimeHeader — RFC 2047 encoded-words (AC-11 routing robustness)', () => {
  it('passes ASCII headers through unchanged (fast path, no `=?`)', () => {
    assert.equal(decodeMimeHeader('Re: [hash] [id] go'), 'Re: [hash] [id] go');
    assert.equal(decodeMimeHeader(''), '');
  });

  it('decodes a single B (base64) word', () => {
    // base64("Hello") = SGVsbG8=
    assert.equal(decodeMimeHeader('=?UTF-8?B?SGVsbG8=?='), 'Hello');
  });

  it('decodes a single Q word (_ = space, =XX = byte)', () => {
    assert.equal(decodeMimeHeader('=?UTF-8?Q?a_=5Bb=5D?='), 'a [b]');
  });

  it('drops the linear whitespace BETWEEN adjacent encoded-words (§6.2) — rejoins split text', () => {
    // "wxyz" split across two words with a fold-space between must rejoin to "wxyz".
    assert.equal(decodeMimeHeader('=?UTF-8?Q?wx?= =?UTF-8?Q?yz?='), 'wxyz');
  });

  it('PRESERVES whitespace between an encoded-word and adjacent plain text', () => {
    assert.equal(decodeMimeHeader('=?UTF-8?Q?hi?= there'), 'hi there');
    assert.equal(decodeMimeHeader('plain =?UTF-8?Q?hi?='), 'plain hi');
  });

  it('decodes a UTF-8 em-dash (=E2=80=94) and a big5 charset word', () => {
    assert.match(decodeMimeHeader('=?UTF-8?Q?=E2=80=94?='), /—/);
    // big5 B word containing ASCII "[ksgn-" survives regardless of charset support.
    assert.match(decodeMimeHeader(OUTLOOK_SUBJ), /\[ksgn-/);
  });

  it('reconstructs the CONTIGUOUS [ksgn-…] token from each real client subject', () => {
    for (const [label, subj] of [['gmail', GMAIL_SUBJ], ['icloud', ICLOUD_SUBJ], ['outlook', OUTLOOK_SUBJ]] as const) {
      assert.match(
        decodeMimeHeader(subj),
        /\[ksgn-e5efe8ac34a7479181631c7aa76a6677\]/i,
        `${label}: token must be contiguous after decode`,
      );
    }
  });
});

describe('extractSubject — decodes RFC 2047 so routing finds the token (prod bug 2026-06-24)', () => {
  for (const [label, subj] of [['gmail', GMAIL_SUBJ], ['icloud', ICLOUD_SUBJ], ['outlook', OUTLOOK_SUBJ]] as const) {
    it(`routes the ${label} forward to its envelope (was dropped no_subject_tokens)`, () => {
      const decoded = extractSubject(raw(`From: x@${label}.com\nSubject: ${subj}`));
      assert.equal(parseEnvelopeToken(decoded), EXPECTED_ID, `${label} subject → envelope id`);
    });
  }

  it('handles the on-the-wire FOLDED header (CRLF + leading space between words)', () => {
    // Real clients fold each encoded-word onto its own continuation line.
    const folded =
      'From: x@example.com\n' +
      'Subject: =?UTF-8?Q?Fwd=3A_=22ACME_42=2DB_?=\n' +
      ' =?UTF-8?Q?=E2=80=94_e2e=22_=5Bksgn=2De5efe8ac34a7479181631c7aa76?=\n' +
      ' =?UTF-8?Q?a6677=5D?=';
    assert.equal(parseEnvelopeToken(extractSubject(raw(folded))), EXPECTED_ID);
  });

  it('still returns a plain ASCII subject verbatim (no regression)', () => {
    assert.equal(
      extractSubject(raw('From: a@b.com\nSubject: Fwd: Sign [ksgn-e5efe8ac34a7479181631c7aa76a6677]')),
      'Fwd: Sign [ksgn-e5efe8ac34a7479181631c7aa76a6677]',
    );
  });
});
