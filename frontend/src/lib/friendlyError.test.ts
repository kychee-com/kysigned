import { describe, it, expect } from 'vitest';
import {
  friendlyCreateError,
  friendlySignInError,
  friendlyCodeError,
  GENERIC_ERROR,
  SIGNIN_LINK_STALE,
  SESSION_EXPIRED,
  SIGNIN_SEND_FAILED,
  CODE_INVALID,
  CODE_EXHAUSTED,
  CODE_ALREADY_USED,
  CODE_TOO_MANY,
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
    for (const s of [
      GENERIC_ERROR, SIGNIN_LINK_STALE, SIGNIN_SEND_FAILED, SESSION_EXPIRED,
      CODE_INVALID, CODE_EXHAUSTED, CODE_ALREADY_USED, CODE_TOO_MANY,
    ]) {
      expect(s).not.toMatch(/—|–| - /);
    }
  });

  // 2026-07-25: a 401 at Send used to print the raw server string
  // ("Authentication required") on a filled form with no way to sign in. The
  // replacement notice must read as a next step, not as a fault, and must never
  // name the status or the transport.
  it('the session-expired notice states the recovery and leaks no transport detail', () => {
    expect(SESSION_EXPIRED).toMatch(/sign in again/i);
    expect(SESSION_EXPIRED).toMatch(/nothing was lost/i);
    expect(SESSION_EXPIRED).not.toMatch(/401|run402|authentication required|session token/i);
  });
});

// FC28.4 / AC-259 — the code-failure copy has to distinguish three outcomes the
// server now classifies: the challenge is dead (its link was clicked, or it was
// superseded), the verification budget is spent, and a plain wrong guess. Only
// the last one is the visitor's fault, so only the last one may say "try again".
describe('friendlyCodeError — the code failure reads like what actually happened', () => {
  it('an already-used challenge reads as the stale-email guidance, not as a typo', () => {
    const copy = friendlyCodeError(new ApiError('x', 401, { code: 'auth_code_used' }));
    expect(copy).toBe(CODE_ALREADY_USED);
    expect(copy).not.toMatch(/didn.t match|check the digits/i);
    expect(copy).toMatch(/newest email|fresh/i);
  });

  it('a spent verification budget reads as too-many, and names the one recovery', () => {
    const copy = friendlyCodeError(new ApiError('x', 401, { code: 'auth_code_too_many' }));
    expect(copy).toBe(CODE_TOO_MANY);
    expect(copy).not.toMatch(/didn.t match|check the digits/i);
    expect(copy).toMatch(/new sign-in email/i);
  });

  it('exhaustion and a plain wrong guess keep their existing copy', () => {
    expect(friendlyCodeError(new ApiError('x', 401, { code: 'auth_code_exhausted' }))).toBe(CODE_EXHAUSTED);
    expect(friendlyCodeError(new ApiError('x', 401, { code: 'auth_code_invalid' }))).toBe(CODE_INVALID);
  });

  it('an unmapped 401 still falls back to the retry copy (never a crash, never a false terminal)', () => {
    expect(friendlyCodeError(new ApiError('x', 401))).toBe(CODE_INVALID);
  });

  it('no code-failure copy names a status, a platform code or a vendor', () => {
    for (const s of [CODE_INVALID, CODE_EXHAUSTED, CODE_ALREADY_USED, CODE_TOO_MANY]) {
      expect(s).not.toMatch(/R402|run402|401|410|429|status/i);
    }
  });
});
