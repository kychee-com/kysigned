/**
 * Signing-intent gate tests — F-6.3 / AC-15 (spec v0.4.0, evidence-bundle model).
 *
 * The first NON-EMPTY plain-text line of the forwarded message, after CTE decode
 * and whitespace normalization, must EQUAL `i sign this document`
 * case-insensitively with nothing else on that line. Lines below the first are
 * ignored (signatures, quoted thread, the forwarded marker + message). Any other
 * first line is rejected with the offending line captured for the corrective
 * bounce. Capitalization is never a rejection cause.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSigningIntent, firstIntentLineVerbatim, CANONICAL_INTENT } from './signingIntent.js';

describe('validateSigningIntent — first non-empty line == "i sign this document" (F-6.3)', () => {
  // --- Happy path: the canonical phrase in any capitalization (AC-15) ---

  it('accepts the phrase in sentence case (as displayed in copy)', () => {
    const r = validateSigningIntent('I sign this document');
    assert.equal(r.valid, true);
    assert.equal(r.reason, undefined);
  });

  it('accepts any capitalization — lower, ALL CAPS, Title, mixed (caps never rejected)', () => {
    for (const body of [
      'i sign this document',
      'I SIGN THIS DOCUMENT',
      'I Sign This Document',
      'i SiGn ThIs DoCuMeNt',
    ]) {
      const r = validateSigningIntent(body);
      assert.equal(r.valid, true, `should accept "${body}"`);
    }
  });

  it('accepts the phrase with leading blank lines', () => {
    assert.equal(validateSigningIntent('\r\n\r\nI sign this document').valid, true);
  });

  it('accepts the phrase with leading whitespace on its line', () => {
    assert.equal(validateSigningIntent('   I sign this document').valid, true);
  });

  it('accepts after ANY mix of blank lines + whitespace-only lines + leading spaces (Barry QA: press Enter and/or spaces, then the phrase)', () => {
    for (const body of [
      '\r\n\r\nI sign this document', // leading Enters only
      '   \r\n\t \r\nI sign this document', // whitespace-only lines (spaces, tab), then the phrase
      '\r\n   \r\n\t\r\n   I sign this document', // Enters + spaces-only + tab-only lines, then a leading-space phrase
      '\n\n  \t  i sign this document', // mixed newlines + spaces/tabs, lower-case phrase
      ' \r\n \r\n  I sign this document', // an nbsp-only line in the mix, then the phrase
    ]) {
      assert.equal(validateSigningIntent(body).valid, true, `should accept ${JSON.stringify(body)}`);
    }
  });

  it('accepts the phrase with trailing whitespace/newlines', () => {
    assert.equal(validateSigningIntent('I sign this document   \r\n\r\n').valid, true);
  });

  it('accepts internal whitespace variation (double spaces, tabs — normalized)', () => {
    for (const body of [
      'I  sign   this    document',
      'I\tsign\tthis\tdocument',
      'I \t sign  \t this \t document',
    ]) {
      assert.equal(validateSigningIntent(body).valid, true, `should normalize "${JSON.stringify(body)}"`);
    }
  });

  // --- Drop-below: content under the first line is ignored ---

  it('accepts the phrase above a Gmail forwarded-message marker (drop-below)', () => {
    const body =
      'I sign this document\r\n\r\n' +
      '---------- Forwarded message ---------\r\n' +
      'From: kysigned <reply-to-sign@kysigned.com>\r\n' +
      'Subject: Please sign — [ksgn-abc]\r\n';
    assert.equal(validateSigningIntent(body).valid, true);
  });

  it('accepts the phrase above a signature block (-- separator on a later line)', () => {
    assert.equal(validateSigningIntent('I sign this document\n\n-- \nAlice Smith\nSenior VP').valid, true);
  });

  it('accepts the phrase above an Apple "Begin forwarded message:" marker', () => {
    assert.equal(
      validateSigningIntent('I sign this document\n\nBegin forwarded message:\n\nFrom: ...').valid,
      true,
    );
  });

  // --- CTE + nbsp normalization ---

  it('decodes a quoted-printable trailing soft-break before judging', () => {
    // Outlook can emit a trailing "=" soft line-break artifact on the part.
    assert.equal(validateSigningIntent('I sign this document=\r\n', 'quoted-printable').valid, true);
  });

  it('normalizes a trailing non-breaking space (Gmail &nbsp;, U+00A0)', () => {
    assert.equal(validateSigningIntent('I sign this document ').valid, true);
  });

  it('normalizes the raw UTF-8 nbsp byte-pair (latin1 read: 0xC2 0xA0)', () => {
    assert.equal(validateSigningIntent('I sign this documentÂ ').valid, true);
  });

  // --- Reject: wrong phrase on the first line (AC-15) ---

  it('rejects the legacy "I SIGN" phrase (whole-line match, not leads-with)', () => {
    const r = validateSigningIntent('I SIGN');
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'wrong_phrase');
    assert.equal(r.detectedLine, 'I SIGN');
  });

  it('rejects same-line trailing words ("... NOT")', () => {
    const r = validateSigningIntent('I sign this document NOT');
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'wrong_phrase');
    assert.match(r.detectedLine ?? '', /NOT/);
  });

  it('rejects same-line reservations', () => {
    const r = validateSigningIntent('I sign this document, but with reservations');
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'wrong_phrase');
  });

  it('rejects a negation', () => {
    const r = validateSigningIntent('I do not sign this document');
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'wrong_phrase');
  });

  it('accepts a trailing "." or "!" (with or without a leading space) — Barry QA', () => {
    for (const body of [
      'I sign this document.',
      'I sign this document!',
      'I sign this document .',
      'I sign this document !',
      'i sign this document.',
      'I SIGN THIS DOCUMENT!',
      'I sign this document...',
    ]) {
      assert.equal(validateSigningIntent(body).valid, true, `should accept "${body}"`);
    }
  });

  it('still rejects a trailing "?" (only "." and "!" are forgiven)', () => {
    const r = validateSigningIntent('I sign this document?');
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'wrong_phrase');
  });

  it('rejects partial phrases', () => {
    for (const body of ['I sign', 'I sign this', 'sign this document', 'I sign the document']) {
      assert.equal(validateSigningIntent(body).valid, false, `should reject "${body}"`);
    }
  });

  it('rejects extra leading words on the same line', () => {
    assert.equal(validateSigningIntent('Hi! I sign this document').valid, false);
  });

  it('rejects when the phrase is buried below other text (first line wins)', () => {
    const r = validateSigningIntent('Please see my response below.\n\nI sign this document');
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'wrong_phrase');
    assert.equal(r.detectedLine, 'Please see my response below.');
  });

  it('rejects when the phrase appears only in quoted content', () => {
    const r = validateSigningIntent('Sure thing\n\n> I sign this document');
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'wrong_phrase');
  });

  it('rejects a bare forward with no typed intent line (first line is the marker)', () => {
    const body = '---------- Forwarded message ---------\nFrom: someone\nSubject: x';
    const r = validateSigningIntent(body);
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'wrong_phrase');
  });

  it('caps a very long offending first line in detectedLine', () => {
    const r = validateSigningIntent('x'.repeat(500));
    assert.equal(r.valid, false);
    assert.ok((r.detectedLine ?? '').length <= 81, 'detectedLine should be capped');
  });

  // --- Reject: no intent line at all ---

  it('rejects an empty body', () => {
    const r = validateSigningIntent('');
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'no_intent_line');
  });

  it('rejects a whitespace-only body', () => {
    const r = validateSigningIntent('   \r\n\r\n  \t  ');
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'no_intent_line');
  });

  it('rejects an nbsp-only body (no visible content)', () => {
    const r = validateSigningIntent(' \r\nÂ ');
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'no_intent_line');
  });

  it('exposes the canonical phrase constant in sentence-case-insensitive lower form', () => {
    assert.equal(CANONICAL_INTENT, 'i sign this document');
  });
});

describe('validateSigningIntent — base64-encoded parts (Outlook; non-ASCII body → base64, F-6.3 / AC-87)', () => {
  // A non-ASCII char anywhere in the forwarded body (e.g. the em-dash in the
  // document name, echoed in the quoted original) makes Outlook base64-encode the
  // WHOLE text part. The gate previously only decoded quoted-printable, so it read
  // the base64 blob as the "first line" → wrong_phrase (live, envelope e5efe8ac,
  // Outlook signer). It MUST decode base64 too. (Gmail/iCloud use QP → already OK.)
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

  it('decodes a base64 text/plain part before judging (was wrong_phrase on the raw blob)', () => {
    assert.equal(validateSigningIntent(b64('I sign this document'), 'base64').valid, true);
  });

  it('decodes the real Outlook structure — intent line above the "____" forwarded marker', () => {
    const body =
      'I sign this document\r\n' +
      '________________________________________\r\n' +
      'From: forward-to-sign@kysigned.com <forward-to-sign@kysigned.com>\r\n' +
      'Subject: Signature requested: "ACME Approval Form 42-B — kysigned" [ksgn-e5efe8ac34a7479181631c7aa76a6677]\r\n';
    assert.equal(validateSigningIntent(b64(body), 'base64').valid, true);
  });

  it('decodes base64 with leading blank lines, then the phrase', () => {
    assert.equal(validateSigningIntent(b64('\r\n\r\nI sign this document'), 'base64').valid, true);
  });

  it('decodes base64 that is MIME-wrapped (CRLF every 76 chars) — non-alphabet chars stripped', () => {
    const wrapped = b64('I sign this document').replace(/(.{8})/g, '$1\r\n');
    assert.equal(validateSigningIntent(wrapped, 'base64').valid, true);
  });

  it('rejects a wrong phrase INSIDE a base64 part (decoded, not the blob)', () => {
    const r = validateSigningIntent(b64('I agree'), 'base64');
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'wrong_phrase');
    assert.equal(r.detectedLine, 'I agree');
  });

  it('decodes a base64-encoded HTML-only part (Outlook rich forward)', () => {
    const html = '<body>I sign this document<br><blockquote>From: x<br>I do not sign</blockquote></body>';
    assert.equal(validateSigningIntent(b64(html), 'base64', true).valid, true);
  });

  it('firstIntentLineVerbatim decodes base64 too (signature page line)', () => {
    assert.equal(firstIntentLineVerbatim(b64('I sign this document'), 'base64'), 'I sign this document');
  });
});

describe('validateSigningIntent — HTML-only forwards (iPhone / Apple Mail, F-6.3 / AC-15)', () => {
  // iPhone / Apple Mail forwards HTML-ONLY (no text/plain part): the typed intent
  // sits at the top of <body>, then a <br>, the "Sent from my iPhone" signature,
  // and the forwarded message below. isHtml=true reduces the HTML to text first.
  const IPHONE_HTML =
    '<html><head><meta http-equiv="content-type" content="text/html; charset=utf-8"></head>' +
    '<body dir="auto">I sign this document&nbsp;<br id="lineBreakAtBeginningOfSignature">' +
    '<div>Sent from my iPhone</div>' +
    '<div><br><blockquote type="cite">Begin forwarded message:<br>From: kysigned</blockquote></div>' +
    '</body></html>';

  it('accepts the intent from an iPhone-style HTML body (no text/plain part)', () => {
    assert.equal(validateSigningIntent(IPHONE_HTML, '7bit', true).valid, true);
  });

  it('decodes a quoted-printable HTML body (=3D + soft breaks) before judging', () => {
    const qp = '<body dir=3D=\r\n"auto">I sign this document&nbsp;<br><div>Sent from my iPhone</div></body>';
    assert.equal(validateSigningIntent(qp, 'quoted-printable', true).valid, true);
  });

  it('reads intent ONLY from the first HTML line — forwarded content below is ignored', () => {
    const html = '<body>I sign this document<br><blockquote>From: x<br>I do not sign</blockquote></body>';
    assert.equal(validateSigningIntent(html, '7bit', true).valid, true);
  });

  it('rejects a wrong phrase in an HTML body (still gated)', () => {
    const r = validateSigningIntent('<body>I agree&nbsp;<br><div>Sent from my iPhone</div></body>', '7bit', true);
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'wrong_phrase');
  });

  it('rejects when the first HTML line is not the phrase (intent only buried in a quote)', () => {
    const r = validateSigningIntent('<body>Please see below<br><blockquote>I sign this document</blockquote></body>', '7bit', true);
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'wrong_phrase');
  });

  it('firstIntentLineVerbatim returns the clean typed line from HTML (for the signature page)', () => {
    assert.equal(firstIntentLineVerbatim(IPHONE_HTML, '7bit', true), 'I sign this document');
  });
});
