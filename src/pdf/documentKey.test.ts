/**
 * documentKey.test.ts — the shared document-blob key resolver.
 *
 * Regression guard for the completion-blocker bug: the shared document D is
 * stored at `envelopes/<hash>/document.pdf` on create, but the envelope row's
 * `pdf_storage_key` column is NEVER written, so the bundle assembler (which read
 * `envelope.pdf_storage_key` directly) bailed on every envelope → "completed on
 * the dashboard, no bundle email ever sent". `resolveDocumentKey` must fall back
 * to the derived key when the column is null.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { documentBlobKey, resolveDocumentKey } from './documentKey.js';

describe('documentKey', () => {
  it('documentBlobKey derives `envelopes/<hash>/document.pdf`', () => {
    assert.equal(documentBlobKey('abc123'), 'envelopes/abc123/document.pdf');
  });

  it('resolveDocumentKey uses the explicit pdf_storage_key when set', () => {
    assert.equal(
      resolveDocumentKey({ pdf_storage_key: 'envelopes/x/document.pdf', document_hash: 'h' }),
      'envelopes/x/document.pdf',
    );
  });

  it('resolveDocumentKey FALLS BACK to the derived key when pdf_storage_key is null (the completion-blocker fix)', () => {
    assert.equal(
      resolveDocumentKey({ pdf_storage_key: null, document_hash: 'deadbeef' }),
      'envelopes/deadbeef/document.pdf',
    );
  });

  it('store and read agree: the create-time key == the resolve fallback for the same hash', () => {
    const hash = 'f'.repeat(64);
    assert.equal(documentBlobKey(hash), resolveDocumentKey({ pdf_storage_key: null, document_hash: hash }));
  });
});
