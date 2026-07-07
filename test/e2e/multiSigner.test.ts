/**
 * E2E test: multi-signer happy path — DD-13 scenario 1, rewritten for reply-to-sign (2R.21).
 *
 * Flow:
 *   1. POST /v1/envelope with 3 signers, parallel signing
 *   2. For each signer, construct a synthetic MIME reply with `I SIGN`
 *   3. POST /v1/inbound/reply with the raw MIME
 *   4. Poll /v1/envelope/:id until status=completed
 *   5. Assert all 3 signers are marked signed
 *   6. Verify by hash returns results
 *
 * Note: DKIM validation is bypassed in e2e mode (the server's inbound handler
 * uses an injectable DKIM validator; when the e2e bypass token is present, the
 * service-repo wires a permissive validator).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiPost,
  apiGet,
  makeAcmePdfBase64,
  makeSigner,
  pollUntil,
  shortId,
  skipIfUnreachable,
} from './_helpers.js';

interface CreateEnvelopeResponseBody {
  envelope_id: string;
  status: string;
  document_hash: string;
  status_url: string;
  verify_url: string;
  signing_links: Array<{ email: string; name: string; link: string }>;
}

interface EnvelopeStateBody {
  id: string;
  status: string;
  completion_tx?: string | null;
  signers: Array<{
    email: string;
    name: string;
    status: string;
    signing_method?: string | null;
    tx_hash?: string | null;
  }>;
}

interface VerifyByHashBody {
  verified: boolean;
  document_hash?: string;
  results?: unknown[];
  message?: string;
}

/**
 * Build a synthetic MIME message that simulates a signer replying `I SIGN`
 * to the signing email. The Subject includes [envelopeId] [docHash] as the
 * inbound handler expects (2R.15 template format).
 */
function buildReplyMime(opts: {
  from: string;
  envelopeId: string;
  docHash: string;
  documentName: string;
  body?: string;
}): string {
  const subject = `Re: Sign "${opts.documentName}" [${opts.envelopeId}] [${opts.docHash}]`;
  return [
    `From: ${opts.from}`,
    `To: reply-to-sign@kysigned.com`,
    `Subject: ${subject}`,
    `DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=sel; h=from:to:subject; b=fake`,
    '',
    opts.body ?? 'I SIGN',
  ].join('\r\n');
}

describe('e2e: multi-signer reply-to-sign happy path (2R.21)', () => {
  it('creates a 3-signer envelope, replies I SIGN for each, completes, verifies', async (t) => {
    await skipIfUnreachable(t);

    // 1. Build envelope payload — ACME approval form with 3 signers
    const pdfBase64 = await makeAcmePdfBase64();
    const docName = `ACME Approval Form 42-B (e2e ${shortId()})`;
    const signers = [
      makeSigner('signer1'),
      makeSigner('signer2'),
      makeSigner('signer3'),
    ];

    // 2. Create envelope
    const create = await apiPost<CreateEnvelopeResponseBody>('/v1/envelope', {
      pdf_base64: pdfBase64,
      document_name: docName,
      signers,
    });
    assert.equal(create.status, 201, `create envelope failed: ${JSON.stringify(create.body)}`);
    assert.ok(create.body.envelope_id, 'envelope_id present');
    assert.equal(create.body.signing_links.length, 3, 'three signing links returned');
    const envelopeId = create.body.envelope_id;
    const documentHash = create.body.document_hash;

    // 3. For each signer, simulate a reply-to-sign by POSTing to /v1/inbound/reply
    for (const signer of signers) {
      const rawMime = buildReplyMime({
        from: signer.email,
        envelopeId,
        docHash: documentHash,
        documentName: docName,
      });
      const replyRes = await apiPost('/v1/inbound/reply', { raw_mime: rawMime });
      assert.ok(
        replyRes.status === 200,
        `inbound reply for ${signer.email} failed (${replyRes.status}): ${JSON.stringify(replyRes.body)}`
      );
    }

    // 4. Poll for completion
    const finalState = await pollUntil<EnvelopeStateBody>(
      async () => {
        const r = await apiGet<EnvelopeStateBody>(`/v1/envelope/${envelopeId}`);
        return r.body;
      },
      (env) => env.status === 'completed',
      { timeoutMs: 120_000, intervalMs: 2_000, description: 'envelope completed' }
    );

    // 5. Assertions on final state
    assert.equal(finalState.status, 'completed', 'final status is completed');
    assert.equal(finalState.signers.length, 3, '3 signers');
    for (const s of finalState.signers) {
      assert.equal(s.status, 'signed', `signer ${s.email} is signed`);
    }

    // 6. Verify by hash
    const verifyRes = await apiGet<VerifyByHashBody>(`/v1/verify?hash=${documentHash}`);
    assert.equal(verifyRes.status, 200);
  });
});
