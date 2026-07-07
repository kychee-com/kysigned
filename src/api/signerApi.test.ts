/**
 * signerApi.test.ts — the signer's read-only review-info + PDF endpoints.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import type { DbPool } from '../db/pool.js';
import { handleSignerInfo, handleSignerPdf, type SigningInfo } from './signerApi.js';

const SIGNER = {
  id: 's1', envelope_id: 'env1', email: 'alice@x.com', name: 'Alice',
  status: 'pending', verification_level: 2, signing_token: 'tok9',
};
function envelope(over: Record<string, unknown> = {}) {
  return {
    id: 'env1', sender_email: 'bob@x.com', document_name: 'NDA', document_hash: 'h',
    status: 'active', created_at: new Date('2026-06-01'),
    completed_at: null, pdf_storage_key: 'key1', expiry_at: null, pdf_deleted_at: null,
    consent_language_version: '1.0', completion_distributed_at: null, internal_test: false,
    source_hash: null, ...over,
  };
}

function fakePool(opts: { signer?: unknown; env?: unknown; blobB64?: string } = {}) {
  const pool: DbPool = {
    async query(text: string) {
      if (text.includes('FROM envelope_signers') && text.includes('signing_token')) {
        return { rows: opts.signer ? [opts.signer] : [], rowCount: opts.signer ? 1 : 0 } as never;
      }
      if (text.includes('FROM envelopes')) {
        return { rows: opts.env ? [opts.env] : [], rowCount: opts.env ? 1 : 0 } as never;
      }
      if (text.includes('pdf_blobs')) {
        return { rows: opts.blobB64 ? [{ bytes_b64: opts.blobB64 }] : [], rowCount: opts.blobB64 ? 1 : 0 } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    },
    async end() {},
  };
  return pool;
}

/** A real N-page PDF — assembleCanonicalPdf needs loadable PDFs, not stub bytes. */
async function realPdf(pages: number): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([200, 200]);
  return d.save();
}

describe('handleSignerInfo', () => {
  it('returns SigningInfo for a valid token+envelope', async () => {
    const r = await handleSignerInfo(
      { pool: fakePool({ signer: SIGNER, env: envelope() }) }, 'env1', 'tok9',
    );
    assert.equal(r.status, 200);
    const info = r.body as SigningInfo;
    assert.equal(info.envelope_id, 'env1');
    assert.equal(info.signer_email, 'alice@x.com');
    assert.equal(info.sender_email, 'bob@x.com');
    assert.equal(info.already_signed, false);
    assert.equal(info.status, 'active');
  });
  it('reports already_signed + completed_at when applicable', async () => {
    const r = await handleSignerInfo(
      { pool: fakePool({ signer: { ...SIGNER, status: 'signed' }, env: envelope({ status: 'completed', completed_at: new Date('2026-06-10') }) }) },
      'env1', 'tok9',
    );
    const info = r.body as SigningInfo;
    assert.equal(info.already_signed, true);
    assert.equal(info.completed_at, new Date('2026-06-10').toISOString());
  });
  it('includes the configured signing email when provided', async () => {
    const r = await handleSignerInfo(
      {
        pool: fakePool({ signer: SIGNER, env: envelope() }),
        signingEmail: 'forward-to-sign@kysigned5.mail.run402.com',
      },
      'env1',
      'tok9',
    );
    const info = r.body as SigningInfo;
    assert.equal(info.signing_email, 'forward-to-sign@kysigned5.mail.run402.com');
  });
  it('404s on an unknown token or a token bound to a different envelope', async () => {
    assert.equal((await handleSignerInfo({ pool: fakePool({ env: envelope() }) }, 'env1', 'nope')).status, 404);
    assert.equal((await handleSignerInfo({ pool: fakePool({ signer: SIGNER, env: envelope() }) }, 'OTHER', 'tok9')).status, 404);
  });
});

describe('handleSignerPdf', () => {
  it('returns the per-signer canonical P_i = cover ++ document (reviews EXACTLY what they sign)', async () => {
    const cover = await realPdf(1);
    const document = await realPdf(2);
    const queried: string[] = [];
    const getPdf = async (key: string) => {
      queried.push(key);
      return key.includes('/cover-') ? cover : key.endsWith('/document.pdf') ? document : null;
    };
    const r = await handleSignerPdf(
      { pool: fakePool({ signer: SIGNER, env: envelope({ pdf_storage_key: null, document_hash: 'abc' }) }), getPdf },
      'env1', 'tok9',
    );
    assert.equal(r.status, 200);
    assert.equal(r.contentType, 'application/pdf');
    const out = await PDFDocument.load(r.bytes!);
    assert.equal(out.getPageCount(), 3, 'cover (1 page) + document (2 pages) = 3');
    assert.ok(queried.includes('envelopes/abc/document.pdf'), 'derives the document key from document_hash');
    assert.ok(queried.includes('envelopes/abc/cover-tok9.pdf'), 'fetches the per-signer cover by token');
  });
  it('410s once the PDF has been retention-deleted (F-9.3)', async () => {
    const r = await handleSignerPdf(
      { pool: fakePool({ signer: SIGNER, env: envelope({ pdf_deleted_at: new Date() }) }) },
      'env1', 'tok9',
    );
    assert.equal(r.status, 410);
  });
  it('404s on a bad token / missing blob', async () => {
    assert.equal((await handleSignerPdf({ pool: fakePool({ env: envelope() }) }, 'env1', 'x')).status, 404);
    assert.equal((await handleSignerPdf({ pool: fakePool({ signer: SIGNER, env: envelope() }) }, 'env1', 'tok9')).status, 404); // no blob
  });
  it('falls back to the document alone if the per-signer cover blob is missing', async () => {
    const document = await realPdf(2);
    const getPdf = async (key: string) => (key.endsWith('/document.pdf') ? document : null);
    const r = await handleSignerPdf(
      { pool: fakePool({ signer: SIGNER, env: envelope({ pdf_storage_key: null }) }), getPdf },
      'env1', 'tok9',
    );
    assert.equal(r.status, 200);
    const out = await PDFDocument.load(r.bytes!);
    assert.equal(out.getPageCount(), 2, 'document only when no cover is stored');
  });
});
