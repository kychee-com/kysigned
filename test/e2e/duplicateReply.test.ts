/**
 * E2E test: duplicate reply — 2R.23.
 *
 * Send `I SIGN` twice for the same signer, verify the second is a no-op.
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
}): string {
  return [
    `From: ${opts.from}`,
    `To: reply-to-sign@kysigned.com`,
    `Subject: Re: Sign "Doc" [${opts.envelopeId}] [${opts.docHash}]`,
    `DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=sel; h=from:to:subject; b=fake`,
    '',
    'I SIGN',
  ].join('\r\n');
}

describe('e2e: duplicate reply (2R.23)', () => {
  it('sends I SIGN twice, second reply returns duplicate status', async (t) => {
    await skipIfUnreachable(t);

    const signer = makeSigner('dup');
    const pdfBase64 = await makeTestPdfBase64();

    // Create envelope
    const create = await apiPost<CreateEnvelopeResponseBody>('/v1/envelope', {
      pdf_base64: pdfBase64,
      document_name: `Duplicate test (e2e ${shortId()})`,
      signers: [signer],
    });
    assert.equal(create.status, 201);
    const { envelope_id: envelopeId, document_hash: docHash } = create.body;

    const rawMime = buildReplyMime({ from: signer.email, envelopeId, docHash });

    // First reply — should succeed
    const first = await apiPost('/v1/inbound/reply', { raw_mime: rawMime });
    assert.equal(first.status, 200);
    const firstBody = first.body as { result?: string };
    assert.equal(firstBody.result, 'signed', 'first reply should be accepted');

    // Second reply — should be a duplicate/no-op
    const second = await apiPost('/v1/inbound/reply', { raw_mime: rawMime });
    assert.equal(second.status, 200);
    const secondBody = second.body as { result?: string };
    assert.equal(secondBody.result, 'duplicate', 'second reply should be a no-op duplicate');

    // Signer should still be signed (not double-recorded)
    const state = await apiGet<EnvelopeStateBody>(`/v1/envelope/${envelopeId}`);
    const signerState = state.body.signers.find(s => s.email === signer.email);
    assert.equal(signerState?.status, 'signed');
  });
});
