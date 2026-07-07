/**
 * blobKeys tests — F-013.
 *
 * The retention/deletion paths must enumerate an envelope's REAL blob keys
 * (shared document D + every per-signer cover), NOT the never-written
 * `pdf_storage_key` column. These are the exact keys the create/store path
 * writes (envelopes/<hash>/document.pdf, envelopes/<hash>/cover-<token>.pdf).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { coverBlobKey, envelopeBlobKeys } from './blobKeys.js';

describe('blobKeys', () => {
  it('coverBlobKey derives `envelopes/<hash>/cover-<token>.pdf`', () => {
    assert.equal(coverBlobKey('h1', 'tokA'), 'envelopes/h1/cover-tokA.pdf');
  });

  it('envelopeBlobKeys enumerates the shared document D + every signer cover', () => {
    const keys = envelopeBlobKeys(
      { document_hash: 'hh' },
      [{ signing_token: 't1' }, { signing_token: 't2' }],
    );
    assert.equal(keys.documentKey, 'envelopes/hh/document.pdf');
    assert.deepEqual(keys.coverKeys, ['envelopes/hh/cover-t1.pdf', 'envelopes/hh/cover-t2.pdf']);
    assert.deepEqual(keys.allKeys, [
      'envelopes/hh/document.pdf',
      'envelopes/hh/cover-t1.pdf',
      'envelopes/hh/cover-t2.pdf',
    ]);
  });

  it('envelopeBlobKeys handles a signer-less envelope (document only)', () => {
    const keys = envelopeBlobKeys({ document_hash: 'z' }, []);
    assert.deepEqual(keys.coverKeys, []);
    assert.deepEqual(keys.allKeys, ['envelopes/z/document.pdf']);
  });

  it('the derived keys match the create-time store keys (byte-for-byte format)', () => {
    // Guard against drift from envelope.ts create/store: `envelopes/${documentHash}/document.pdf`
    // and `envelopes/${documentHash}/cover-${s.signing_token}.pdf`.
    const hash = 'a'.repeat(64);
    const token = 'b'.repeat(64);
    const keys = envelopeBlobKeys({ document_hash: hash }, [{ signing_token: token }]);
    assert.equal(keys.documentKey, `envelopes/${hash}/document.pdf`);
    assert.equal(keys.coverKeys[0], `envelopes/${hash}/cover-${token}.pdf`);
  });
});
