/**
 * processForward — the signing event, end-to-end (F-6 / AC-13..AC-19, AC-62).
 *
 * Drives the whole Phase-6 pipeline against an in-memory pool: membership →
 * idempotency → active → sender-auth → classical DKIM (real mailauth, offline via
 * a generated key) → intent → attachment → record. Forwards that reject BEFORE the
 * DKIM step use unsigned messages; the DKIM/intent/attachment cases are genuinely
 * DKIM-signed with a PDF that hashes to the envelope's canonical document_hash.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { dkimSign } from 'mailauth';
import { processForward } from './processForward.js';
import { sha256Hex } from './attachmentCheck.js';
import { createInboundRepliesMemoryPool } from '../../db/inboundReplies.testpool.js';
import type { DkimResolver } from './dkimVerify.js';

const ENV_UUID = '18267982-ca76-45dc-a294-e86039a6343d';
const ENV_HEX = '18267982ca7645dca294e86039a6343d';
const PDF = new Uint8Array(Buffer.from('%PDF-1.7\nacme contract body\n%%EOF\n', 'latin1'));
const PDF_SHA = sha256Hex(PDF);

let privateKey = '';
let txtRecord = '';

before(() => {
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKey = kp.privateKey;
  const der = kp.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  txtRecord = `v=DKIM1; k=rsa; p=${der}`;
});

function b64(bytes: Uint8Array): string {
  return (Buffer.from(bytes).toString('base64').match(/.{1,64}/g) ?? []).join('\r\n');
}

function buildForward(opts: {
  from?: string;
  token?: string;
  intentLine?: string;
  pdf?: Uint8Array | null;
} = {}): string {
  const from = opts.from ?? 'Alice <alice@example.com>';
  const token = opts.token ?? `[ksgn-${ENV_HEX}]`;
  const intent = opts.intentLine ?? 'I sign this document';
  const pdf = opts.pdf === undefined ? PDF : opts.pdf;
  const lines = [
    `From: ${from}`,
    'To: reply-to-sign@kysigned.com',
    `Subject: Fwd: Please sign "acme" ${token}`,
    'Date: Fri, 13 Jun 2026 10:00:00 +0000',
    'Message-ID: <fwd@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BOUND"',
    '',
    '--BOUND',
    'Content-Type: text/plain; charset=us-ascii',
    '',
    intent,
    '',
    '---------- Forwarded message ---------',
    'From: kysigned <reply-to-sign@kysigned.com>',
    '',
  ];
  if (pdf) {
    lines.push(
      '--BOUND',
      'Content-Type: application/pdf; name="acme.pdf"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="acme.pdf"',
      '',
      b64(pdf),
    );
  }
  lines.push('--BOUND--', '');
  return lines.join('\r\n');
}

/**
 * Like buildForward but HTML-ONLY — NO text/plain part (iPhone / Apple Mail forward
 * this way). The typed intent sits at the top of <body>, then <br>, the iPhone
 * signature, and the forwarded message; the PDF rides along the same. Proves the
 * intent gate reads the text/html part when there is no text/plain (Barry QA).
 */
function buildForwardHtmlOnly(opts: { from?: string; token?: string; intentLine?: string } = {}): string {
  const from = opts.from ?? 'Alice <alice@example.com>';
  const token = opts.token ?? `[ksgn-${ENV_HEX}]`;
  const intent = opts.intentLine ?? 'I sign this document';
  return [
    `From: ${from}`,
    'To: forward-to-sign@kysigned.com',
    `Subject: Fwd: Please sign "acme" ${token}`,
    'Date: Fri, 13 Jun 2026 10:00:00 +0000',
    'Message-ID: <fwd-iphone@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BOUND"',
    '',
    '--BOUND',
    'Content-Type: text/html; charset=utf-8',
    '',
    `<html><head><meta http-equiv="content-type" content="text/html; charset=utf-8"></head>` +
      `<body dir="auto">${intent}&nbsp;<br id="lineBreakAtBeginningOfSignature">` +
      `<div>Sent from my iPhone</div>` +
      `<div><br><blockquote type="cite">Begin forwarded message:<br>From: kysigned</blockquote></div></body></html>`,
    '',
    '--BOUND',
    'Content-Type: application/pdf; name="acme.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="acme.pdf"',
    '',
    b64(PDF),
    '--BOUND--',
    '',
  ].join('\r\n');
}

async function sign(raw: string, signingDomain = 'example.com'): Promise<string> {
  const res = await dkimSign(raw, {
    canonicalization: 'relaxed/relaxed',
    signTime: new Date('2026-06-13T10:00:00Z'),
    signatureData: [{ signingDomain, selector: 'test', privateKey, algorithm: 'rsa-sha256' }],
  });
  return res.signatures + raw;
}

function resolver(serve = true): DkimResolver {
  return async (name, rrtype) => {
    if (serve && String(rrtype).toLowerCase() === 'txt' && name === 'test._domainkey.example.com') {
      return [[txtRecord]];
    }
    const e = new Error('ENOTFOUND') as Error & { code?: string };
    e.code = 'ENOTFOUND';
    throw e;
  };
}

function seedPool(opts: { envelopeStatus?: string; signerStatus?: string; signerEmail?: string } = {}) {
  const h = createInboundRepliesMemoryPool();
  h.envelopes.push({
    id: ENV_UUID,
    status: opts.envelopeStatus ?? 'active',
    document_name: 'acme',
    document_hash: PDF_SHA,
  });
  h.signers.push({
    id: 's-1',
    envelope_id: ENV_UUID,
    email: opts.signerEmail ?? 'alice@example.com',
    status: opts.signerStatus ?? 'pending',
    // Family B (F-6.4): the per-signer return-check target. The fixture forward
    // attaches `PDF` (its P_i), so this signer's sent_pdf_hash is PDF_SHA.
    sent_pdf_hash: PDF_SHA,
  });
  return h;
}

const PASS = { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' };

describe('processForward — the signing event (F-6)', () => {
  it('records a fully-valid forward as signed (AC-13)', async () => {
    const h = seedPool();
    const raw = await sign(buildForward());
    const r = await processForward(raw, { pool: h.pool, verdicts: PASS, dkimResolver: resolver() });

    assert.equal(r.outcome, 'signed');
    if (r.outcome === 'signed') {
      assert.equal(r.envelopeId, ENV_UUID);
      assert.equal(r.signerEmail, 'alice@example.com');
      assert.equal(r.signingDomain, 'example.com');
      assert.equal(r.selector, 'test'); // threaded through dkimPolicy (F-6.7)
    }
    assert.equal(h.signers[0].status, 'signed'); // actually recorded
  });

  // iPhone / Apple Mail forwards HTML-ONLY (no text/plain). The intent gate must
  // read the text/html part, or every iPhone signature is rejected no_intent_line
  // (Barry QA 2026-06-19 — the real failure).
  it('records an HTML-only iPhone forward as signed — no text/plain part (Barry QA)', async () => {
    const h = seedPool();
    const raw = await sign(buildForwardHtmlOnly());
    const r = await processForward(raw, { pool: h.pool, verdicts: PASS, dkimResolver: resolver() });
    assert.equal(r.outcome, 'signed');
    assert.equal(h.signers[0].status, 'signed');
  });

  it('rejects an HTML-only forward whose first visible line is the wrong phrase', async () => {
    const h = seedPool();
    const raw = await sign(buildForwardHtmlOnly({ intentLine: 'I agree' }));
    const r = await processForward(raw, { pool: h.pool, verdicts: PASS, dkimResolver: resolver() });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') assert.equal(r.code, 'wrong_phrase');
  });

  // Family B (DD-9): the return-check is PER-SIGNER — a forward must return THIS
  // signer's own P_i, not just any attachment matching the shared document.
  it('rejects a forward matching the envelope docHash but NOT this signer\'s sent_pdf_hash', async () => {
    const h = createInboundRepliesMemoryPool();
    h.envelopes.push({ id: ENV_UUID, status: 'active', document_name: 'acme', document_hash: PDF_SHA });
    // The forward attaches PDF (hash = PDF_SHA = the envelope docHash), but this
    // signer's OWN P_i hash differs → the per-signer return-check must reject it.
    h.signers.push({ id: 's-1', envelope_id: ENV_UUID, email: 'alice@example.com', status: 'pending', sent_pdf_hash: 'f'.repeat(64) });
    const raw = await sign(buildForward());
    const r = await processForward(raw, { pool: h.pool, verdicts: PASS, dkimResolver: resolver() });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') assert.equal(r.code, 'attachment_modified');
  });

  it('drops a forward with no envelope token silently (AC-16)', async () => {
    const h = seedPool();
    const r = await processForward(buildForward({ token: '' }), { pool: h.pool, verdicts: PASS });
    assert.equal(r.outcome, 'dropped');
    if (r.outcome === 'dropped') assert.equal(r.reason, 'no_subject_tokens');
    assert.equal(h.signers[0].status, 'pending'); // unchanged
  });

  it('drops a forward from a non-member address silently (AC-16)', async () => {
    const h = seedPool();
    const r = await processForward(buildForward({ from: 'mallory@evil.com' }), { pool: h.pool, verdicts: PASS });
    assert.equal(r.outcome, 'dropped');
    if (r.outcome === 'dropped') assert.equal(r.reason, 'not_a_signer');
  });

  it('treats a duplicate forward from an already-signed signer as a no-op (AC-18)', async () => {
    const h = seedPool({ signerStatus: 'signed' });
    const r = await processForward(buildForward(), { pool: h.pool, verdicts: PASS });
    assert.equal(r.outcome, 'already_signed');
  });

  // A superseded signer (creator edited them after they signed) RE-signs onto a
  // manual-seal envelope still parked in awaiting_seal. It must record, not bounce
  // "no longer active" (Barry QA — the real failure).
  it('records a re-signing superseded signer on an awaiting_seal envelope (Barry QA)', async () => {
    const h = seedPool({ envelopeStatus: 'awaiting_seal', signerStatus: 'superseded' });
    const raw = await sign(buildForward());
    const r = await processForward(raw, { pool: h.pool, verdicts: PASS, dkimResolver: resolver() });
    assert.equal(r.outcome, 'signed');
    assert.equal(h.signers[0].status, 'signed');
  });

  // AC-26: a forward arriving after void/expiry gets the explanatory bounce
  // (envelope_inactive → forwardNotifier renders the F-7 note) and CHANGES NO STATE
  // (the signer stays pending — no signature is recorded). The bounce path is the
  // same for any non-active status; void + expiry are asserted explicitly because
  // AC-26 names both, completed because a late forward after everyone has signed is
  // the most common real-world case.
  for (const status of ['voided', 'expired', 'completed'] as const) {
    it(`rejects a forward to a ${status} envelope and changes no state (AC-26)`, async () => {
      const h = seedPool({ envelopeStatus: status });
      const r = await processForward(buildForward(), { pool: h.pool, verdicts: PASS });
      assert.equal(r.outcome, 'rejected');
      if (r.outcome === 'rejected') {
        assert.equal(r.code, 'envelope_inactive');
        assert.match(r.reason, new RegExp(status)); // names the actual status for the note
      }
      assert.equal(h.signers[0].status, 'pending'); // AC-26: no signature recorded
    });
  }

  // F-6.2a — the SPF/DMARC rejection is OPT-IN (default record-only). With enforcement
  // ON, a hard FAIL rejects before the DKIM lookup; with it OFF (default), the same
  // FAIL is recorded but does NOT block (DKIM stays the primary gate).
  it('rejects an SES SPF-fail before the DKIM lookup when enforcement is ON (F-6.2a)', async () => {
    const h = seedPool();
    const r = await processForward(buildForward(), { pool: h.pool, verdicts: { spf: 'FAIL', dmarc: 'PASS' }, enforceSenderAuth: true });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') assert.equal(r.code, 'spf_fail');
    assert.equal(h.signers[0].status, 'pending');
  });

  it('rejects an SES DMARC-fail when enforcement is ON (F-6.2a)', async () => {
    const h = seedPool();
    const r = await processForward(buildForward(), { pool: h.pool, verdicts: { spf: 'PASS', dmarc: 'FAIL' }, enforceSenderAuth: true });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') assert.equal(r.code, 'dmarc_fail');
  });

  it('records a hard FAIL but does NOT reject when enforcement is OFF (default record-only, AC-62)', async () => {
    const h = seedPool();
    const signed = await sign(buildForward());
    // enforceSenderAuth omitted (default false): the SPF FAIL is recorded, not enforced.
    const r = await processForward(signed, { pool: h.pool, verdicts: { spf: 'FAIL', dmarc: 'PASS' }, dkimResolver: resolver() });
    assert.equal(r.outcome, 'signed');
    if (r.outcome === 'signed') assert.deepEqual(r.verdicts, { spf: 'FAIL', dmarc: 'PASS' }); // still recorded
  });

  it('rejects a forward whose body was altered after signing → invalid_signature (AC-17)', async () => {
    const h = seedPool();
    const signed = await sign(buildForward());
    // Alter a body region the signature covers (the forwarded-marker line, which
    // is base64-free and not itself a gate input) so the failure isolates to DKIM.
    const tampered = signed.replace('Forwarded message', 'Forwarded MESSAGE (edited)');
    const r = await processForward(tampered, { pool: h.pool, verdicts: PASS, dkimResolver: resolver() });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') assert.equal(r.code, 'invalid_signature');
    assert.equal(h.signers[0].status, 'pending');
  });

  it('rejects when the DKIM key is missing from DNS → missing_key (AC-17)', async () => {
    const h = seedPool();
    const raw = await sign(buildForward());
    const r = await processForward(raw, { pool: h.pool, verdicts: PASS, dkimResolver: resolver(false) });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') assert.equal(r.code, 'missing_key');
  });

  it('rejects a wrong intent line (DKIM-valid) → wrong_phrase, capturing the line (AC-15)', async () => {
    const h = seedPool();
    const raw = await sign(buildForward({ intentLine: 'I SIGN' }));
    const r = await processForward(raw, { pool: h.pool, verdicts: PASS, dkimResolver: resolver() });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') {
      assert.equal(r.code, 'wrong_phrase');
      assert.equal(r.detail, 'I SIGN');
    }
  });

  it('rejects a forward with no PDF attachment → attachment_missing (AC-14)', async () => {
    const h = seedPool();
    const raw = await sign(buildForward({ pdf: null }));
    const r = await processForward(raw, { pool: h.pool, verdicts: PASS, dkimResolver: resolver() });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') assert.equal(r.code, 'attachment_missing');
  });

  it('rejects a forward whose PDF differs by one byte → attachment_modified (AC-14)', async () => {
    const h = seedPool();
    const tamperedPdf = new Uint8Array(PDF);
    tamperedPdf[5] ^= 0x01;
    const raw = await sign(buildForward({ pdf: tamperedPdf }));
    const r = await processForward(raw, { pool: h.pool, verdicts: PASS, dkimResolver: resolver() });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') assert.equal(r.code, 'attachment_modified');
  });

  it('is idempotent: processing the same valid forward twice signs exactly once (AC-18)', async () => {
    const h = seedPool();
    const raw = await sign(buildForward());
    const first = await processForward(raw, { pool: h.pool, verdicts: PASS, dkimResolver: resolver() });
    const second = await processForward(raw, { pool: h.pool, verdicts: PASS, dkimResolver: resolver() });
    assert.equal(first.outcome, 'signed');
    assert.equal(second.outcome, 'already_signed');
    assert.equal(h.signers[0].status, 'signed');
  });
});
