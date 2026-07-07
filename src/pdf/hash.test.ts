import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computePdfHash, decodePdfBase64 } from './hash.js';

describe('computePdfHash', () => {
  it('should compute SHA-256 of bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = computePdfHash(bytes);
    assert.equal(hash.length, 64); // 32 bytes = 64 hex chars
    assert.ok(/^[0-9a-f]+$/.test(hash));
  });

  it('should be deterministic', () => {
    const bytes = new Uint8Array([10, 20, 30]);
    assert.equal(computePdfHash(bytes), computePdfHash(bytes));
  });

  it('should produce different hashes for different inputs', () => {
    const a = computePdfHash(new Uint8Array([1]));
    const b = computePdfHash(new Uint8Array([2]));
    assert.notEqual(a, b);
  });
});

describe('decodePdfBase64', () => {
  it('should decode base64 to Uint8Array', () => {
    const original = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const base64 = Buffer.from(original).toString('base64');
    const decoded = decodePdfBase64(base64);
    assert.deepEqual(decoded, original);
  });
});
