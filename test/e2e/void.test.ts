/**
 * E2E test: void flow — DD-13 scenario 2.
 *
 * Flow:
 *   1. Create envelope with 2 signers
 *   2. POST /v1/envelope/:id/void
 *   3. Assert status=voided
 *   4. Assert subsequent /v1/sign/:id/:token returns 4xx (envelope is voided)
 *   5. Assert PDF was deleted (immediate-delete-on-void per F8.6)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiPost,
  apiGet,
  makeAcmePdfBase64,
  makeSigner,
  shortId,
  skipIfUnreachable,
} from './_helpers.js';

interface CreateEnvelopeResponseBody {
  envelope_id: string;
  status: string;
  document_hash: string;
  signing_links: Array<{ email: string; name: string; link: string }>;
}

interface EnvelopeStateBody {
  id: string;
  status: string;
  pdf_deleted_at?: string | null;
}

function tokenFromLink(link: string): { envelopeId: string; token: string } {
  const m = link.match(/\/sign\/([^/]+)\/([^/?#]+)/);
  if (!m) throw new Error(`bad signing link: ${link}`);
  return { envelopeId: m[1]!, token: m[2]! };
}

describe('e2e: void flow (DD-13 scenario 2 — F8.6 immediate-delete)', () => {
  it('voids an active envelope, deletes the PDF, blocks subsequent signing', async (t) => {
    await skipIfUnreachable(t);

    // 1. Create envelope — ACME form
    const pdfBase64 = await makeAcmePdfBase64();
    const create = await apiPost<CreateEnvelopeResponseBody>('/v1/envelope', {
      pdf_base64: pdfBase64,
      document_name: `ACME Approval (void test, e2e ${shortId()})`,
      signers: [makeSigner('signer1'), makeSigner('signer2')],
    });
    assert.equal(create.status, 201, `create envelope: ${JSON.stringify(create.body)}`);
    const envelopeId = create.body.envelope_id;
    const firstSignerLink = create.body.signing_links[0]!;

    // 2. Void
    const voidRes = await apiPost<{ id: string; status: string }>(
      `/v1/envelope/${envelopeId}/void`,
      {}
    );
    assert.equal(voidRes.status, 200, `void: ${JSON.stringify(voidRes.body)}`);
    assert.equal(voidRes.body.status, 'voided');

    // 3. Confirm status=voided
    const stateRes = await apiGet<EnvelopeStateBody>(`/v1/envelope/${envelopeId}`);
    assert.equal(stateRes.body.status, 'voided');
    assert.ok(
      stateRes.body.pdf_deleted_at,
      'F8.6: pdf_deleted_at must be set immediately on void'
    );

    // 4. Subsequent sign attempt must fail (not 200)
    const { token } = tokenFromLink(firstSignerLink.link);
    const signAttempt = await apiPost(`/v1/sign/${envelopeId}/${token}`, {
      method: 'email',
      signer_pubkey: 'a'.repeat(64),
      signature: 'b'.repeat(128),
    });
    assert.notEqual(signAttempt.status, 200, 'signing a voided envelope must fail');
    assert.notEqual(signAttempt.status, 201, 'signing a voided envelope must fail');
  });
});
