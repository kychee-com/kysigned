import { describe, it, expect } from 'vitest';
import { friendlyCreateError, GENERIC_ERROR } from './friendlyError';

// 2026-06-21: the create page used to print the backend error string verbatim, so
// run402's opaque "Internal function error" (its catch-all for an uncaught throw)
// leaked straight to the creator. friendlyCreateError swaps opaque/5xx faults for a
// calm fallback while keeping genuinely-helpful 4xx validation messages.
describe('friendlyCreateError', () => {
  it('replaces the opaque run402 wrapper with the friendly fallback', () => {
    expect(friendlyCreateError(500, 'Internal function error')).toBe(GENERIC_ERROR);
  });

  it('replaces any 5xx (even with a message) with the friendly fallback', () => {
    expect(friendlyCreateError(503, 'upstream boom')).toBe(GENERIC_ERROR);
  });

  it('replaces an empty / missing message with the friendly fallback', () => {
    expect(friendlyCreateError(undefined, undefined)).toBe(GENERIC_ERROR);
    expect(friendlyCreateError(400, '')).toBe(GENERIC_ERROR);
  });

  it('passes a helpful 4xx validation message through unchanged', () => {
    const a = 'An envelope can have at most 20 signers.';
    expect(friendlyCreateError(400, a)).toBe(a);
    const b = 'Insufficient credit — please top up to send.';
    expect(friendlyCreateError(402, b)).toBe(b);
  });
});
