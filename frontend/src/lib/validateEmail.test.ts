import { describe, it, expect } from 'vitest';
import { isValidEmail } from './validateEmail';

describe('isValidEmail', () => {
  it('accepts well-formed addresses', () => {
    for (const v of ['a@b.co', 'alice@example.com', 'a.b+tag@sub.domain.org', 'x_y@z.io']) {
      expect(isValidEmail(v)).toBe(true);
    }
  });

  it('rejects empty / whitespace-only input', () => {
    for (const v of ['', '   ', '\t']) expect(isValidEmail(v)).toBe(false);
  });

  it('rejects malformed addresses (no @, no domain, no TLD, internal spaces)', () => {
    for (const v of ['alice', 'alice@', '@example.com', 'alice@example', 'a b@c.com', 'alice@ex ample.com']) {
      expect(isValidEmail(v)).toBe(false);
    }
  });

  it('trims surrounding whitespace before validating', () => {
    expect(isValidEmail('  alice@example.com  ')).toBe(true);
  });
});
