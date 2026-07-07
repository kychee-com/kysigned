/**
 * E2E test: non-matching reply — 2R.22.
 *
 * Send a reply without `I SIGN`, verify the inbound handler rejects it
 * and no signature is recorded.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiPost,
  apiGet,
  makeTestPdfBase64,
  makeSigner,
  shortId,
  skipIfUnreachable,
} from './_helpers.js';

interface CreateEnvelopeResponseBody {
  envelope_id: string;
  document_hash: string;
  signing_links: Array<{ email: string; name: string; link: string }>;
}

interface EnvelopeStateBody {
  id: string;
  status: string;
  signers: Array<{ email: string; status: string }>;
}

function buildReplyMime(opts: {
  from: string;
  envelopeId: string;
  docHash: string;
  body: string;
}): string {
  return [
    `From: ${opts.from}`,
    `To: reply-to-sign@kysigned.com`,
    `Subject: Re: Sign "Doc" [${opts.envelopeId}] [${opts.docHash}]`,
    `DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=sel; h=from:to:subject; b=fake`,
    '',
    opts.body,
  ].join('\r\n');
}

describe('e2e: non-matching reply (2R.22)', () => {
  it('rejects a reply without I SIGN and does not record a signature', async (t) => {
    await skipIfUnreachable(t);

    const signer = makeSigner('nomatch');
    const pdfBase64 = await makeTestPdfBase64();

    // Create envelope
    const create = await apiPost<CreateEnvelopeResponseBody>('/v1/envelope', {
      pdf_base64: pdfBase64,
      document_name: `Non-match test (e2e ${shortId()})`,
      signers: [signer],
    });
    assert.equal(create.status, 201);
    const { envelope_id: envelopeId, document_hash: docHash } = create.body;

    // Send a reply with random text (no I SIGN)
    const rawMime = buildReplyMime({
      from: signer.email,
      envelopeId,
      docHash,
      body: 'Sure thing, sounds good to me!',
    });
    const replyRes = await apiPost('/v1/inbound/reply', { raw_mime: rawMime });
    // The handler returns 200 (accepted the MIME) but the result should be 'rejected'
    assert.equal(replyRes.status, 200);
    const replyBody = replyRes.body as { result?: string };
    assert.equal(replyBody.result, 'rejected', 'non-matching reply should be rejected');

    // Verify signer is still pending
    const state = await apiGet<EnvelopeStateBody>(`/v1/envelope/${envelopeId}`);
    assert.equal(state.body.signers[0]?.status, 'pending', 'signer should still be pending');
  });
});
