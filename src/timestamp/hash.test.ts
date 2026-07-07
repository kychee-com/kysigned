import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertHash32 } from './hash.js';

describe('assertHash32 (AC-3 input guard)', () => {
  it('accepts a 32-byte Uint8Array', () => {
    assert.doesNotThrow(() => assertHash32(new Uint8Array(32)));
  });

  it('rejects the wrong length', () => {
    assert.throws(() => assertHash32(new Uint8Array(31)), /32-byte/);
    assert.throws(() => assertHash32(new Uint8Array(33)), /32-byte/);
    assert.throws(() => assertHash32(new Uint8Array(0)), /32-byte/);
  });

  it('rejects non-Uint8Array input with a TypeError', () => {
    assert.throws(() => assertHash32('x'.repeat(32) as unknown as Uint8Array), TypeError);
    assert.throws(() => assertHash32(null as unknown as Uint8Array), TypeError);
    assert.throws(() => assertHash32(Array(32).fill(0) as unknown as Uint8Array), TypeError);
  });
});
