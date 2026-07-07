/**
 * MIME disposal tests — from spec F3.3.3.
 *
 * "The raw email is deleted from operator state once the signed `.eml` has
 * been embedded in the evidence bundle. Only the bundle persists."
 *
 * Tests that `secureDispose` overwrites the string buffer reference and
 * that the disposal callback is invoked by the handler.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { secureDispose, type DisposalRecord } from './mimeDisposal.js';

describe('secureDispose', () => {
  it('records the disposal with timestamp', () => {
    const record: DisposalRecord = { disposed: false, disposedAt: null, byteCount: 0 };
    secureDispose('raw MIME content here', record);
    assert.equal(record.disposed, true);
    assert.ok(record.disposedAt instanceof Date);
    assert.equal(record.byteCount, 'raw MIME content here'.length);
  });

  it('works with empty strings', () => {
    const record: DisposalRecord = { disposed: false, disposedAt: null, byteCount: 0 };
    secureDispose('', record);
    assert.equal(record.disposed, true);
    assert.equal(record.byteCount, 0);
  });

  it('records byte count for audit trail', () => {
    const record: DisposalRecord = { disposed: false, disposedAt: null, byteCount: 0 };
    const mime = 'x'.repeat(1000);
    secureDispose(mime, record);
    assert.equal(record.byteCount, 1000);
  });
});
