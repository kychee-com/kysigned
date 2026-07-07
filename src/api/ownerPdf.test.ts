/**
 * F8.12 — Creator canonical-PDF download (owner-checked handler) tests.
 *
 * Pure, dependency-injected handler: getEnvelope + getPdfBlob are faked, so
 * these tests exercise the owner-check + retention (410) logic with no DB.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleGetEnvelopePdfForOwner,
  type EnvelopeRowForOwnerPdf,
  type OwnerPdfDeps,
} from './ownerPdf.ts';

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

function envelope(overrides: Partial<EnvelopeRowForOwnerPdf> = {}): EnvelopeRowForOwnerPdf {
  return {
    id: 'env-1',
    sender_email: 'alice@example.com',
    document_name: 'acme-approval',
    document_hash: 'a'.repeat(64),
    status: 'active',
    pdf_storage_key: null,
    pdf_deleted_at: null,
    completed_at: null,
    ...overrides,
  };
}

function deps(over: Partial<OwnerPdfDeps> = {}): OwnerPdfDeps {
  return {
    getEnvelope: async () => envelope(),
    getPdfBlob: async () => PDF_BYTES,
    ...over,
  };
}

describe('handleGetEnvelopePdfForOwner — F8.12', () => {
  it('returns the canonical PDF bytes when the authenticated email owns the envelope', async () => {
    const r = await handleGetEnvelopePdfForOwner(deps(), 'env-1', 'alice@example.com');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.bytes, PDF_BYTES);
      assert.equal(r.filename, 'acme-approval.pdf');
    }
  });

  it('owner match is case-insensitive', async () => {
    const r = await handleGetEnvelopePdfForOwner(deps(), 'env-1', 'ALICE@Example.com');
    assert.equal(r.ok, true);
  });

  it('denies (403) when the authenticated email does not own the envelope', async () => {
    const r = await handleGetEnvelopePdfForOwner(deps(), 'env-1', 'mallory@example.com');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 403);
  });

  it('denies (403) when the envelope has no sender_email', async () => {
    const r = await handleGetEnvelopePdfForOwner(
      deps({ getEnvelope: async () => envelope({ sender_email: null }) }),
      'env-1',
      'alice@example.com',
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 403);
  });

  it('returns 401 when no authenticated email is present', async () => {
    const r = await handleGetEnvelopePdfForOwner(deps(), 'env-1', null);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 401);
  });

  it('returns 404 when the envelope does not exist', async () => {
    const r = await handleGetEnvelopePdfForOwner(
      deps({ getEnvelope: async () => null }),
      'missing',
      'alice@example.com',
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 404);
  });

  it('returns 410 Gone with envelope-state context when the blob is retention-deleted (F8.6)', async () => {
    const r = await handleGetEnvelopePdfForOwner(
      deps({
        getEnvelope: async () =>
          envelope({ status: 'voided', pdf_deleted_at: '2026-05-27T00:00:00Z' }),
        getPdfBlob: async () => null,
      }),
      'env-1',
      'alice@example.com',
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 410);
      assert.equal(r.error, 'pdf_deleted');
      assert.ok(r.context);
      assert.equal(r.context!['envelope_status'], 'voided');
      assert.equal(r.context!['pdf_deleted_at'], '2026-05-27T00:00:00Z');
      assert.equal(r.context!['document_hash'], 'a'.repeat(64));
    }
  });

  it('owner check happens BEFORE the blob fetch (a non-owner never learns retention state)', async () => {
    let blobFetched = false;
    const r = await handleGetEnvelopePdfForOwner(
      deps({
        getPdfBlob: async () => {
          blobFetched = true;
          return PDF_BYTES;
        },
      }),
      'env-1',
      'mallory@example.com',
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 403);
    assert.equal(blobFetched, false, 'getPdfBlob must not be called for a non-owner');
  });

  it('derives the storage key from document_hash when pdf_storage_key is unset', async () => {
    let usedKey = '';
    await handleGetEnvelopePdfForOwner(
      deps({
        getPdfBlob: async (key) => {
          usedKey = key;
          return PDF_BYTES;
        },
      }),
      'env-1',
      'alice@example.com',
    );
    assert.equal(usedKey, `envelopes/${'a'.repeat(64)}/document.pdf`);
  });

  it('prefers an explicit pdf_storage_key when present', async () => {
    let usedKey = '';
    await handleGetEnvelopePdfForOwner(
      deps({
        getEnvelope: async () => envelope({ pdf_storage_key: 'custom/key.pdf' }),
        getPdfBlob: async (key) => {
          usedKey = key;
          return PDF_BYTES;
        },
      }),
      'env-1',
      'alice@example.com',
    );
    assert.equal(usedKey, 'custom/key.pdf');
  });
});
