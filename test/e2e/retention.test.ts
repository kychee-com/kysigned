/**
 * E2E test: retention sweep — DD-13 scenario 3.
 *
 * F8.6 ephemeral PDF retention. Flow:
 *   1. Create + complete an envelope via reply-to-sign
 *   2. Simulate the run402/SES delivery webhook
 *   3. Trigger the scheduled sweep function via /admin/v1/sweep/run
 *   4. Assert the envelope's PDF metadata reports `pdf_deleted_at` set
 *
 * Updated for reply-to-sign in 2R.24 (was Method A Ed25519).
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

interface CreateEnvelopeBody {
  envelope_id: string;
  document_hash: string;
  signing_links: Array<{ email: string; link: string }>;
}

interface EnvelopeStateBody {
  id: string;
  status: string;
  pdf_deleted_at?: string | null;
  signers: Array<{
    email: string;
    completion_email_provider_msg_id?: string | null;
  }>;
}

function buildReplyMime(from: string, envelopeId: string, docHash: string, docName: string): string {
  return [
    `From: ${from}`,
    `To: reply-to-sign@kysigned.com`,
    `Subject: Re: Sign "${docName}" [${envelopeId}] [${docHash}]`,
    `DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=sel; h=from:to:subject; b=fake`,
    '',
    'I SIGN',
  ].join('\r\n');
}

describe('e2e: retention sweep (DD-13 scenario 3 — F8.6)', () => {
  it('completes an envelope via reply-to-sign, simulates SES delivery, sweeps PDF', async (t) => {
    await skipIfUnreachable(t);

    const docName = `ACME Approval (retention test, e2e ${shortId()})`;
    const pdfBase64 = await makeAcmePdfBase64();
    const signer = makeSigner('signer1');
    const create = await apiPost<CreateEnvelopeBody>('/v1/envelope', {
      pdf_base64: pdfBase64,
      document_name: docName,
      signers: [signer],
    });
    assert.equal(create.status, 201);
    const envelopeId = create.body.envelope_id;
    const docHash = create.body.document_hash;

    // 2. Reply-to-sign
    const rawMime = buildReplyMime(signer.email, envelopeId, docHash, docName);
    const replyRes = await apiPost('/v1/inbound/reply', { raw_mime: rawMime });
    assert.equal(replyRes.status, 200);

    // 3. Wait for completion + capture the completion_email_provider_msg_id
    const completed = await pollUntil<EnvelopeStateBody>(
      async () => (await apiGet<EnvelopeStateBody>(`/v1/envelope/${envelopeId}`)).body,
      (env) =>
        env.status === 'completed' &&
        !!env.signers[0]?.completion_email_provider_msg_id,
      { timeoutMs: 120_000, intervalMs: 2_000, description: 'envelope completed + provider msg id set' }
    );
    const providerMsgId = completed.signers[0]!.completion_email_provider_msg_id!;
    assert.ok(providerMsgId, 'completion_email_provider_msg_id must be set after completion');

    // 4. Simulate run402/SES delivery webhook
    const webhookRes = await apiPost('/webhooks/v1/email', {
      event: 'delivery',
      mailbox_id: 'mbx_e2e',
      message_id: providerMsgId,
      to_address: signer.email,
    });
    assert.equal(webhookRes.status, 200, `webhook: ${JSON.stringify(webhookRes.body)}`);

    // 5. Trigger the sweep function
    const sweepRes = await apiPost('/admin/v1/sweep/run', {});
    assert.ok(
      sweepRes.status === 200 || sweepRes.status === 202,
      `sweep run: ${JSON.stringify(sweepRes.body)}`
    );

    // 6. Confirm pdf_deleted_at is now set
    const finalState = await pollUntil<EnvelopeStateBody>(
      async () => (await apiGet<EnvelopeStateBody>(`/v1/envelope/${envelopeId}`)).body,
      (env) => !!env.pdf_deleted_at,
      { timeoutMs: 30_000, intervalMs: 1_000, description: 'pdf_deleted_at set after sweep' }
    );
    assert.ok(finalState.pdf_deleted_at, 'pdf must be deleted after sweep');
  });
});
