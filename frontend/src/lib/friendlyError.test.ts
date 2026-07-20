import { describe, it, expect } from 'vitest';
import {
  friendlyCreateError,
  friendlySignInError,
  GENERIC_ERROR,
  SIGNIN_LINK_STALE,
} from './friendlyError';
import { ApiError } from './api';

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

// GH#20 follow-up (2026-07-20): a user clicked a stale magic link and the screen
// printed "Sign-in failed (run402 returned status 401: Invalid, expired, or
// already used magic link token)" — vendor jargon where a human instruction
// belongs. Only the NEWEST link works (run402 supersedes prior tokens on each
// new request, their #279), and Gmail threads identical-subject sign-in emails
// with the OLDEST on top — so stale-link clicks are a routine event, not an
// edge case, and the copy must tell the user exactly what to do.
describe('friendlySignInError', () => {
  it('maps a stale/used/expired token exchange (401 auth_signin_failed) to the actionable copy', () => {
    const e = new ApiError('Sign-in failed', 401, {
      code: 'auth_signin_failed',
      reason: 'run402 returned status 401: Invalid, expired, or already used magic link token',
    });
    const msg = friendlySignInError(e);
    expect(msg).toBe(SIGNIN_LINK_STALE);
    expect(msg).toMatch(/newest email/i);
    expect(msg).not.toMatch(/run402|status 401/i);
  });

  it('maps a 5xx to the generic fallback and a network failure to the generic fallback', () => {
    expect(friendlySignInError(new ApiError('Internal function error', 500))).toBe(GENERIC_ERROR);
    expect(friendlySignInError(new TypeError('Failed to fetch'))).toBe(GENERIC_ERROR);
  });

  it('no user-facing copy in this module uses a dash-as-pause (outbound style rule)', () => {
    for (const s of [GENERIC_ERROR, SIGNIN_LINK_STALE]) {
      expect(s).not.toMatch(/—|–| - /);
    }
  });
});
