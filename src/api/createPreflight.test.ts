/**
 * createPreflight tests — #129: validate a create body deterministically WITHOUT
 * charging or creating, so a wallet/x402 agent can check inputs BEFORE paying
 * (a paid create that then fails app validation still consumes the on-chain
 * charge, since run402 settles before our function runs).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleCreatePreflight } from './createPreflight.js';
import { handleCreateEnvelope } from './envelope.js';
import type { CreateEnvelopeRequest } from './envelope.js';

// A minimal valid PDF (same fixture the create tests use, truncated header ok for shape checks).
const TINY_PDF_B64 =
  'JVBERi0xLjcKJYGBgYEKCjEgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgNCAwIFIgXQovQ291bnQgMQo+PgplbmRvYmoKCjIgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCj4+CmVuZG9iagoKMyAwIG9iago8PAovUHJvZHVjZXIgPEZFRkYwMDc0MDA2NTAwNzMwMDc0MDAyRDAwNjYwMDY5MDA3ODAwNzQwMDc1MDA3MjAwNjU+Ci9Nb2REYXRlIChEOjIwMjAwMTAxMDAwMDAwWikKL0NyZWF0b3IgPEZFRkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyMDAwMjgwMDY4MDA3NDAwNzQwMDcwMDA3MzAwM0EwMDJGMDAyRjAwNjcwMDY5MDA3NDAwNjgwMDc1MDA2MjAwMkUwMDYzMDA2RjAwNkQwMDJGMDA0ODAwNkYwMDcwMDA2NDAwNjkwMDZFMDA2NzAwMkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyOT4KL0NyZWF0aW9uRGF0ZSAoRDoyMDIwMDEwMTAwMDAwMFopCi9UaXRsZSA8RkVGRjAwNzQwMDY1MDA3MzAwNzQ+Cj4+CmVuZG9iagoKNCAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDEgMCBSCi9SZXNvdXJjZXMgPDwKL0ZvbnQgPDwKL0hlbHZldGljYS03MDk4NDgwNzg5IDUgMCBSCj4+Ci9YT2JqZWN0IDw8Cj4+Ci9FeHRHU3RhdGUgPDwKPj4KPj4KL01lZGlhQm94IFsgMCAwIDYxMiA3OTIgXQovQW5ub3RzIFsgXQovQ29udGVudHMgWyA2IDAgUiBdCj4+CmVuZG9iagoKNSAwIG9iago8PAovVHlwZSAvRm9udAovU3VidHlwZSAvVHlwZTEKL0Jhc2VGb250IC9IZWx2ZXRpY2EKL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcKPj4KZW5kb2JqCgo2IDAgb2JqCjw8Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGggOTYKPj4Kc3RyZWFtCnicK+RyCuEyUADBonQufY/UnLLUkszkRF1zA0sLEwsDcwtLBSMThZA0LhDpw2UIVgohQ3K5bMxNzEzNjc1NjAzMzMwszS3MTcxNzY3MTO0UQrK4QrS4XEO4ArkAobMWLQplbmRzdHJlYW0KZW5kb2JqCgp4cmVmCjAgNwowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTYgMDAwMDAgbiAKMDAwMDAwMDA3NiAwMDAwMCBuIAowMDAwMDAwMTI2IDAwMDAwIG4gCjAwMDAwMDA0OTggMDAwMDAgbiAKMDAwMDAwMDY5MyAwMDAwMCBuIAowMDAwMDAwNzkxIDAwMDAwIG4gCgp0cmFpbGVyCjw8Ci9TaXplIDcKL1Jvb3QgMiAwIFIKL0luZm8gMyAwIFIKPj4KCnN0YXJ0eHJlZgo5NTkKJSVFT0Y=';

const OK = {
  creator_email: 'agent@example.com',
  document_name: 'NDA',
  signers: [{ email: 'signer@example.com', name: 'S' }],
  pdf_base64: TINY_PDF_B64,
};

describe('handleCreatePreflight — #129 free pre-payment validation', () => {
  it('a valid body → 200 { ok: true }', async () => {
    const r = await handleCreatePreflight({ ...OK });
    assert.equal(r.status, 200);
    assert.equal((r.body as { ok: boolean }).ok, true);
  });

  it('a plus-alias signer → 400 validation_plus_alias (the exact reported case, caught BEFORE paying)', async () => {
    const r = await handleCreatePreflight({ ...OK, signers: [{ email: 'agent-smoke+signer@kychee.com', name: 'S' }] });
    assert.equal(r.status, 400);
    assert.equal((r.body as { code: string }).code, 'validation_plus_alias');
  });

  it('a malformed creator_email → 400 validation_creator_email', async () => {
    const r = await handleCreatePreflight({ ...OK, creator_email: 'nope' });
    assert.equal(r.status, 400);
    assert.equal((r.body as { code: string }).code, 'validation_creator_email');
  });

  it('creator_email is optional (a keyed/session create has no creator_email) — omitting it still validates the rest', async () => {
    const { creator_email: _drop, ...noEmail } = OK;
    const r = await handleCreatePreflight({ ...noEmail });
    assert.equal(r.status, 200);
  });

  it('neither pdf source → 400 validation_pdf', async () => {
    const { pdf_base64: _drop, ...noPdf } = OK;
    const r = await handleCreatePreflight({ ...noPdf });
    assert.equal(r.status, 400);
    assert.equal((r.body as { code: string }).code, 'validation_pdf');
  });

  it('missing document_name → 400 validation_document_name', async () => {
    const r = await handleCreatePreflight({ ...OK, document_name: '' });
    assert.equal(r.status, 400);
    assert.equal((r.body as { code: string }).code, 'validation_document_name');
  });

  it('no signers → 400 validation_signers', async () => {
    const r = await handleCreatePreflight({ ...OK, signers: [] });
    assert.equal(r.status, 400);
    assert.equal((r.body as { code: string }).code, 'validation_signers');
  });

  it('an oversize pdf_base64 → 400 rate_size_pdf', async () => {
    const oversize = Buffer.alloc(3_548_000, 0x41).toString('base64');
    const r = await handleCreatePreflight({ ...OK, pdf_base64: oversize });
    assert.equal(r.status, 400);
    assert.equal((r.body as { code: string }).code, 'rate_size_pdf');
  });
});

// ── AC-142 parity pin (49.1) — a preflight verdict must MATCH the real create ──
// The preflight's promise is "a PASS means these checks will not reject the paid
// create", which silently breaks if the create's deterministic validation gains
// or changes a code the preflight doesn't mirror. Drive BOTH handlers with the
// same defective body and assert the same 400 + the same taxonomy code. The
// create context uses THROWING stubs: every parity body must be rejected before
// any DB/email work, so a stub firing means the create stopped rejecting it.
describe('preflight ↔ create parity (AC-142)', () => {
  const throwingCtx = {
    pool: {
      query: async () => {
        throw new Error('parity body reached the DB — create no longer rejects it');
      },
      end: async () => {},
    },
    emailProvider: {
      send: async () => {
        throw new Error('parity body reached email — create no longer rejects it');
      },
    },
    baseUrl: 'https://kysigned.com',
    senderIdentity: 'creator@example.com',
  } as unknown as Parameters<typeof handleCreateEnvelope>[0];

  // creator_email is x402-route-only — the standard create never sees it, so the
  // shared parity bodies omit it (the preflight treats it as optional).
  const { creator_email: _drop, ...SHARED } = OK;

  const CASES: Array<{ name: string; body: Record<string, unknown>; code: string }> = [
    { name: 'neither pdf source', body: (({ pdf_base64: _p, ...rest }) => rest)({ ...SHARED }), code: 'validation_pdf' },
    { name: 'missing document_name', body: { ...SHARED, document_name: '' }, code: 'validation_document_name' },
    { name: 'no signers', body: { ...SHARED, signers: [] }, code: 'validation_signers' },
    {
      name: 'plus-alias signer',
      body: { ...SHARED, signers: [{ email: 'agent-smoke+signer@kychee.com', name: 'S' }] },
      code: 'validation_plus_alias',
    },
    {
      name: 'oversize pdf_base64',
      body: { ...SHARED, pdf_base64: Buffer.alloc(3_548_000, 0x41).toString('base64') },
      code: 'rate_size_pdf',
    },
    {
      name: 'decodable but non-PDF pdf_base64',
      body: { ...SHARED, pdf_base64: Buffer.from('not a pdf at all', 'utf8').toString('base64') },
      code: 'validation_pdf',
    },
  ];

  for (const c of CASES) {
    it(`${c.name} → the SAME 400 ${c.code} from preflight and create`, async () => {
      const pre = await handleCreatePreflight({ ...c.body });
      const create = await handleCreateEnvelope(throwingCtx, { ...c.body } as unknown as CreateEnvelopeRequest);
      assert.equal(pre.status, 400, 'preflight status');
      assert.equal(create.status, 400, 'create status');
      assert.equal((pre.body as { code: string }).code, c.code, 'preflight code');
      assert.equal(
        (create.body as { code?: string }).code,
        (pre.body as { code: string }).code,
        'create code must equal preflight code',
      );
    });
  }
});
