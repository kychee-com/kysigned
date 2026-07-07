/**
 * uploadGuard tests — the backend upload-size cap (F-3.5a / AC-7; F-004).
 *
 * Boundary lock for the server-side guard that API/agent clients can't bypass.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PDF_BYTES, isUploadTooLarge, uploadTooLargeMessage } from './uploadGuard.js';

describe('uploadGuard — backend upload-size cap (F-004 / F-3.5a)', () => {
  it('the cap is 3,000,000 bytes (mirrors frontend pdfSize.ts, safe under the 6 MiB invoke wall)', () => {
    assert.equal(MAX_PDF_BYTES, 3_000_000);
  });

  it('rejects strictly above the cap; accepts at or below (boundary)', () => {
    assert.equal(isUploadTooLarge(MAX_PDF_BYTES + 1), true);
    assert.equal(isUploadTooLarge(MAX_PDF_BYTES), false);
    assert.equal(isUploadTooLarge(MAX_PDF_BYTES - 1), false);
    assert.equal(isUploadTooLarge(0), false);
  });

  it('flags the real-world repro size (3.548 MiB → too large)', () => {
    assert.equal(isUploadTooLarge(3_548_000), true);
  });

  it('the message states the actual size and the 3 MB maximum', () => {
    const msg = uploadTooLargeMessage(3_548_000);
    assert.match(msg, /too large/i);
    assert.match(msg, /3\.5 MB/); // the actual size
    assert.match(msg, /maximum is 3 MB/);
  });
});
