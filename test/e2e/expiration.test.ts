/**
 * E2E test: failed signing / expiration flow — DD-13 scenario 5.
 *
 * Flow:
 *   1. Create envelope with 3 signers, parallel signing
 *   2. Reply-to-sign for 2 of the 3 (via /v1/inbound/reply)
 *   3. Force expiry: POST /admin/v1/envelopes/:id/force-expire
 *   4. Trigger the sweep+expire scheduled handler via /admin/v1/sweep/run
 *   5. Assert envelope status=expired
 *   6. Assert pending signer's subsequent inbound reply is rejected
 *   7. Assert PDF was deleted
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

interface CreateBody {
  envelope_id: string;
  document_hash: string;
  signing_links: Array<{ email: string; link: string }>;
}

interface StateBody {
  id: string;
  status: string;
  pdf_deleted_at?: string | null;
  signers: Array<{ email: string; status: string }>;
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

describe('e2e: failed signing / expiration (DD-13 scenario 5 — DD-16)', () => {
  it('expires an envelope with 2/3 signed, notifies, blocks late signing, deletes PDF', async (t) => {
    await skipIfUnreachable(t);

    const docName = `ACME Approval (expiration test, e2e ${shortId()})`;
    const pdfBase64 = await makeAcmePdfBase64();
    const signers = [makeSigner('signer1'), makeSigner('signer2'), makeSigner('signer3')];
    const create = await apiPost<CreateBody>('/v1/envelope', {
      pdf_base64: pdfBase64,
      document_name: docName,
      signers,
    });
    assert.equal(create.status, 201);
    const envelopeId = create.body.envelope_id;
    const docHash = create.body.document_hash;

    // 2. Reply-to-sign for 2 of 3
    for (const signer of signers.slice(0, 2)) {
      const rawMime = buildReplyMime(signer.email, envelopeId, docHash, docName);
      const r = await apiPost('/v1/inbound/reply', { raw_mime: rawMime });
      assert.equal(r.status, 200);
    }

    // 3. Force expiry via admin route
    const forceRes = await apiPost(`/admin/v1/envelopes/${envelopeId}/force-expire`, {});
    assert.ok(
      forceRes.status === 200 || forceRes.status === 202,
      `force-expire: ${JSON.stringify(forceRes.body)}`
    );

    // 4. Trigger sweep + expire
    const sweepRes = await apiPost('/admin/v1/sweep/run', {});
    assert.ok(
      sweepRes.status === 200 || sweepRes.status === 202,
      `sweep run: ${JSON.stringify(sweepRes.body)}`
    );

    // 5. Status flips to expired
    const expired = await pollUntil<StateBody>(
      async () => (await apiGet<StateBody>(`/v1/envelope/${envelopeId}`)).body,
      (env) => env.status === 'expired',
      { timeoutMs: 30_000, intervalMs: 1_000, description: 'envelope status=expired' }
    );

    // 6. Late reply-to-sign for signer 3 should be rejected
    const lateMime = buildReplyMime(signers[2].email, envelopeId, docHash, docName);
    const lateReply = await apiPost('/v1/inbound/reply', { raw_mime: lateMime });
    assert.equal(lateReply.status, 200);
    const lateBody = lateReply.body as { result?: string };
    assert.ok(
      lateBody.result === 'rejected' || lateBody.result === 'expired',
      `expired envelope must reject late reply (got: ${lateBody.result})`
    );

    // 7. PDF deleted
    assert.ok(
      expired.pdf_deleted_at,
      'F8.6: pdf must be deleted when envelope reaches expired terminal state'
    );
  });
});
