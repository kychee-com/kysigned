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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dkimSign, sealMessage, type ARCSealOptions } from 'mailauth';
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

// F-45.1 / AC-271 / AC-278 — a provider that signs under its own fallback domain
// because the signer's domain has no DKIM switched on. The gate verdict stays
// `misaligned`; only the diagnosis rides along on the rejected outcome.
describe('processForward — provider no-DKIM diagnosis (F-45.1)', () => {
  const GOOGLE_FALLBACK = 'example-com.20251104.gappssmtp.com';
  const MICROSOFT_FALLBACK = 'contoso.onmicrosoft.com';

  async function signAs(raw: string, domains: string[]): Promise<string> {
    const res = await dkimSign(raw, {
      canonicalization: 'relaxed/relaxed',
      signTime: new Date('2026-06-13T10:00:00Z'),
      signatureData: domains.map((signingDomain) => ({ signingDomain, selector: 'test', privateKey, algorithm: 'rsa-sha256' })),
    });
    return res.signatures + raw;
  }

  function resolverFor(domains: string[]): DkimResolver {
    const served = new Set(domains.map((d) => `test._domainkey.${d}`));
    return async (name, rrtype) => {
      if (String(rrtype).toLowerCase() === 'txt' && served.has(name)) return [[txtRecord]];
      const e = new Error('ENOTFOUND') as Error & { code?: string };
      e.code = 'ENOTFOUND';
      throw e;
    };
  }

  it('Google Workspace fallback signature → misaligned + google_workspace (AC-271)', async () => {
    const h = seedPool();
    const raw = await signAs(buildForward(), [GOOGLE_FALLBACK]);
    const r = await processForward(raw, { pool: h.pool, verdicts: PASS, dkimResolver: resolverFor([GOOGLE_FALLBACK]) });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') {
      assert.equal(r.code, 'misaligned');
      assert.equal(r.providerNoDkim, 'google_workspace');
    }
    assert.equal(h.signers[0].status, 'pending');
  });

  it('Microsoft 365 fallback signature → misaligned + microsoft_365 (AC-278)', async () => {
    const h = seedPool({ signerEmail: 'alice@contoso.com' });
    const raw = await signAs(buildForward({ from: 'Alice <alice@contoso.com>' }), [MICROSOFT_FALLBACK]);
    const r = await processForward(raw, { pool: h.pool, verdicts: PASS, dkimResolver: resolverFor([MICROSOFT_FALLBACK]) });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') {
      assert.equal(r.code, 'misaligned');
      assert.equal(r.providerNoDkim, 'microsoft_365');
    }
    assert.equal(h.signers[0].status, 'pending');
  });

  it('a verifying signature under any other domain → misaligned, no diagnosis', async () => {
    const h = seedPool();
    const raw = await signAs(buildForward(), ['relay.example.net']);
    const r = await processForward(raw, { pool: h.pool, verdicts: PASS, dkimResolver: resolverFor(['relay.example.net']) });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') {
      assert.equal(r.code, 'misaligned');
      assert.equal(r.providerNoDkim, undefined);
    }
  });

  it('an own-domain signature beside the fallback one → no diagnosis (the domain HAS DKIM)', async () => {
    const h = seedPool();
    const raw = await signAs(buildForward(), ['example.com', GOOGLE_FALLBACK]);
    // Only the fallback key is served, so the own-domain signature cannot pass.
    const r = await processForward(raw, { pool: h.pool, verdicts: PASS, dkimResolver: resolverFor([GOOGLE_FALLBACK]) });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') {
      assert.equal(r.code, 'misaligned');
      assert.equal(r.providerNoDkim, undefined);
    }
  });

  it('an unsigned forward → rejected, no diagnosis', async () => {
    const h = seedPool();
    const r = await processForward(buildForward(), { pool: h.pool, verdicts: PASS, dkimResolver: resolverFor([]) });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') assert.equal(r.providerNoDkim, undefined);
  });

  it('a tampered fallback signature → invalid_signature, no diagnosis', async () => {
    const h = seedPool();
    const signed = await signAs(buildForward(), [GOOGLE_FALLBACK]);
    const tampered = signed.replace('Forwarded message', 'Forwarded MESSAGE (edited)');
    const r = await processForward(tampered, { pool: h.pool, verdicts: PASS, dkimResolver: resolverFor([GOOGLE_FALLBACK]) });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') {
      assert.equal(r.code, 'invalid_signature');
      assert.equal(r.providerNoDkim, undefined);
    }
  });
});

describe('processForward — Microsoft 365, unsigned: the verified ARC first sealer (F-45.1, spec 0.73.0, AC-279)', () => {
  const MS_KEY = 'arcselector10001._domainkey.microsoft.com';
  const GOOGLE_KEY = 'arc-20240605._domainkey.google.com';
  let msPrivate = '';
  let msTxt = '';
  let googlePrivate = '';
  let googleTxt = '';

  before(() => {
    const pair = () => {
      const kp = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      return [kp.privateKey, `v=DKIM1; k=rsa; p=${kp.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')}`];
    };
    [msPrivate, msTxt] = pair();
    [googlePrivate, googleTxt] = pair();
  });

  /** Prepend an i=1 ARC set the way Exchange Online (or Gmail) seals outgoing mail. */
  async function sealAs(raw: string, signingDomain: string, selector: string, key: string): Promise<string> {
    // mailauth's createSeal reads `cv` and `authResults`, which its typings leave out.
    const opts: ARCSealOptions & { cv: string; authResults: string } = {
      signingDomain,
      selector,
      privateKey: key,
      cv: 'none',
      authResults: `mx.${signingDomain} 1; spf=none; dmarc=none; dkim=none; arc=none`,
      signTime: new Date('2026-06-13T10:00:01Z'),
    };
    return (await sealMessage(raw, opts)).toString('utf8') + raw;
  }
  const sealByMicrosoft = (raw: string) => sealAs(raw, 'microsoft.com', 'arcselector10001', msPrivate);

  /** Serves the named TXT records (plus the DKIM test key for `dkimDomains`) and records every lookup. */
  function recordingResolver(records: Record<string, string>, dkimDomains: string[] = []) {
    const lookups: string[] = [];
    const served = new Map(Object.entries(records));
    for (const d of dkimDomains) served.set(`test._domainkey.${d}`, txtRecord);
    const resolve: DkimResolver = async (name, rrtype) => {
      lookups.push(String(name));
      const txt = served.get(String(name));
      if (String(rrtype).toLowerCase() === 'txt' && txt) return [[txt]];
      const e = new Error('ENOTFOUND') as Error & { code?: string };
      e.code = 'ENOTFOUND';
      throw e;
    };
    return { resolve, lookups };
  }

  async function signAs(raw: string, domains: string[]): Promise<string> {
    const res = await dkimSign(raw, {
      canonicalization: 'relaxed/relaxed',
      signTime: new Date('2026-06-13T10:00:00Z'),
      signatureData: domains.map((signingDomain) => ({ signingDomain, selector: 'test', privateKey, algorithm: 'rsa-sha256' })),
    });
    return res.signatures + raw;
  }

  const CONTOSO = { from: 'Alice <alice@contoso.com>' };

  it('unsigned + a verifying Microsoft seal → rejected with the same gate code, diagnosed microsoft_365', async () => {
    const plain = await processForward(buildForward(CONTOSO), {
      pool: seedPool({ signerEmail: 'alice@contoso.com' }).pool,
      verdicts: PASS,
      dkimResolver: recordingResolver({ [MS_KEY]: msTxt }).resolve,
    });
    const h = seedPool({ signerEmail: 'alice@contoso.com' });
    const sealed = await sealByMicrosoft(buildForward(CONTOSO));
    const r = await processForward(sealed, { pool: h.pool, verdicts: PASS, dkimResolver: recordingResolver({ [MS_KEY]: msTxt }).resolve });
    assert.equal(r.outcome, 'rejected');
    assert.equal(plain.outcome, 'rejected');
    if (r.outcome === 'rejected' && plain.outcome === 'rejected') {
      assert.equal(r.code, plain.code, 'the gate code is unchanged by the seal');
      assert.equal(r.providerNoDkim, 'microsoft_365');
    }
    assert.equal(h.signers[0].status, 'pending', 'nothing is recorded signed');
  });

  it('unsigned + a Google seal → no diagnosis', async () => {
    const h = seedPool({ signerEmail: 'alice@contoso.com' });
    const sealed = await sealAs(buildForward(CONTOSO), 'google.com', 'arc-20240605', googlePrivate);
    const r = await processForward(sealed, { pool: h.pool, verdicts: PASS, dkimResolver: recordingResolver({ [GOOGLE_KEY]: googleTxt }).resolve });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') assert.equal(r.providerNoDkim, undefined);
  });

  it('unsigned + a Microsoft seal that no longer verifies (body edited) → no diagnosis', async () => {
    const h = seedPool({ signerEmail: 'alice@contoso.com' });
    const sealed = await sealByMicrosoft(buildForward(CONTOSO));
    const edited = sealed.replace('Forwarded message', 'Forwarded MESSAGE (edited)');
    assert.notEqual(edited, sealed);
    const r = await processForward(edited, { pool: h.pool, verdicts: PASS, dkimResolver: recordingResolver({ [MS_KEY]: msTxt }).resolve });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') assert.equal(r.providerNoDkim, undefined);
  });

  it('unsigned + a Microsoft seal whose key is missing from DNS → no diagnosis', async () => {
    const h = seedPool({ signerEmail: 'alice@contoso.com' });
    const sealed = await sealByMicrosoft(buildForward(CONTOSO));
    const r = await processForward(sealed, { pool: h.pool, verdicts: PASS, dkimResolver: recordingResolver({}).resolve });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') assert.equal(r.providerNoDkim, undefined);
  });

  it('a misaligned forward that Microsoft also sealed → judged by the fallback rules alone (no diagnosis)', async () => {
    const h = seedPool({ signerEmail: 'alice@contoso.com' });
    const sealed = await sealByMicrosoft(await signAs(buildForward(CONTOSO), ['relay.example.net']));
    const r = await processForward(sealed, {
      pool: h.pool,
      verdicts: PASS,
      dkimResolver: recordingResolver({ [MS_KEY]: msTxt }, ['relay.example.net']).resolve,
    });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') {
      assert.equal(r.code, 'misaligned');
      assert.equal(r.providerNoDkim, undefined);
    }
  });

  it('an own-domain signed forward that Microsoft also sealed → signed as before', async () => {
    const h = seedPool({ signerEmail: 'alice@contoso.com' });
    const sealed = await sealByMicrosoft(await signAs(buildForward(CONTOSO), ['contoso.com']));
    const r = await processForward(sealed, {
      pool: h.pool,
      verdicts: PASS,
      dkimResolver: recordingResolver({ [MS_KEY]: msTxt }, ['contoso.com']).resolve,
    });
    assert.equal(r.outcome, 'signed');
    assert.equal(h.signers[0].status, 'signed');
  });

  it('the seal check runs only for an unsigned forward (no extra lookup on any other path)', async () => {
    // mailauth already checks the latest ARC message signature inside verifyDkim, on
    // every path; the seal check is the one EXTRA lookup, and only the unsigned path pays it.
    const misaligned = recordingResolver({ [MS_KEY]: msTxt }, ['relay.example.net']);
    await processForward(await sealByMicrosoft(await signAs(buildForward(CONTOSO), ['relay.example.net'])), {
      pool: seedPool({ signerEmail: 'alice@contoso.com' }).pool,
      verdicts: PASS,
      dkimResolver: misaligned.resolve,
    });
    const unsigned = recordingResolver({ [MS_KEY]: msTxt });
    await processForward(await sealByMicrosoft(buildForward(CONTOSO)), {
      pool: seedPool({ signerEmail: 'alice@contoso.com' }).pool,
      verdicts: PASS,
      dkimResolver: unsigned.resolve,
    });
    const msLookups = (l: string[]) => l.filter((n) => n === MS_KEY).length;
    assert.equal(msLookups(unsigned.lookups), msLookups(misaligned.lookups) + 1);
  });
});

/**
 * The GENERATED corporate Microsoft 365 forward (spec 0.73.1, AC-279): no real corporate
 * sample exists, so `scripts/gen-m365-no-dkim-mock.mjs` builds one in Exchange Online's
 * layout, unsigned, sealed i=1 as `microsoft.com` with a stand-in key whose public half
 * rides in the .json. See `fixtures/README.md`.
 */
describe('processForward — the GENERATED Microsoft 365 corporate forward (F-45.1, spec 0.73.1, AC-279)', () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const MOCK_EML = readFileSync(join(FIXTURES, 'm365-corporate-no-dkim.GENERATED.eml'), 'utf8');
  const MOCK = JSON.parse(readFileSync(join(FIXTURES, 'm365-corporate-no-dkim.GENERATED.json'), 'utf8')) as {
    generated: boolean;
    envelope: { id: string; hex: string; documentName: string };
    signer: { email: string; domain: string };
    attachment: { sha256: string };
    standInKeys: Record<string, string>;
  };
  const MS_KEY = 'arcselector10001._domainkey.microsoft.com';

  function serving(records: Record<string, string>): DkimResolver {
    return async (name, rrtype) => {
      const txt = records[String(name)];
      if (String(rrtype).toLowerCase() === 'txt' && txt) return [[txt]];
      const e = new Error('ENOTFOUND') as Error & { code?: string };
      e.code = 'ENOTFOUND';
      throw e;
    };
  }

  function seedMockEnvelope() {
    const h = createInboundRepliesMemoryPool();
    h.envelopes.push({ id: MOCK.envelope.id, status: 'active', document_name: MOCK.envelope.documentName, document_hash: MOCK.attachment.sha256 });
    h.signers.push({ id: 's-mock', envelope_id: MOCK.envelope.id, email: MOCK.signer.email, status: 'pending', sent_pdf_hash: MOCK.attachment.sha256 });
    return h;
  }

  it("the generated mock is marked GENERATED and has Microsoft's no-DKIM shape", () => {
    assert.equal(MOCK.generated, true);
    assert.match(MOCK_EML, /^X-Kysigned-Fixture: GENERATED MOCK, not real mail\./);
    assert.doesNotMatch(MOCK_EML, /^DKIM-Signature:/im, 'no DKIM signature, as Microsoft sends a no-DKIM domain');
    const seals = MOCK_EML.match(/^ARC-Seal:[^]*?(?=^\S)/gim) ?? [];
    assert.equal(seals.length, 1, 'exactly one ARC set');
    const seal = seals[0].replace(/\r?\n\s+/g, ' ');
    for (const tag of ['i=1;', 'd=microsoft.com;', 's=arcselector10001;', 'cv=none;']) assert.ok(seal.includes(tag), tag);
    assert.match(MOCK_EML, /^ARC-Authentication-Results: i=1; mx\.microsoft\.com 1; spf=none; dmarc=none; dkim=none; arc=none$/m);
    assert.match(MOCK_EML, new RegExp(`^From: .*@${MOCK.signer.domain.replaceAll('.', '\\.')}>`, 'm'));
    assert.match(MOCK_EML, new RegExp(`\\[ksgn-${MOCK.envelope.hex}\\]`));
    assert.deepEqual(Object.keys(MOCK.standInKeys), [MS_KEY]);
  });

  it('a generated Microsoft 365 corporate forward with DKIM off → rejected, diagnosed microsoft_365 (AC-279)', async () => {
    const h = seedMockEnvelope();
    const r = await processForward(MOCK_EML, { pool: h.pool, verdicts: PASS, dkimResolver: serving(MOCK.standInKeys) });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') {
      assert.equal(r.envelopeId, MOCK.envelope.id);
      assert.equal(r.signerEmail, MOCK.signer.email);
      assert.equal(r.providerNoDkim, 'microsoft_365');
    }
    assert.equal(h.signers[0].status, 'pending', 'nothing is recorded signed');
  });

  it("the same generated forward checked against any other key (the live service's view) → no diagnosis (AC-279)", async () => {
    const other = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const otherTxt = `v=DKIM1; k=rsa; p=${other.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')}`;
    const h = seedMockEnvelope();
    const r = await processForward(MOCK_EML, { pool: h.pool, verdicts: PASS, dkimResolver: serving({ [MS_KEY]: otherTxt }) });
    assert.equal(r.outcome, 'rejected');
    if (r.outcome === 'rejected') assert.equal(r.providerNoDkim, undefined, 'a seal Microsoft did not make never names Microsoft');
    assert.equal(h.signers[0].status, 'pending');
  });
});
