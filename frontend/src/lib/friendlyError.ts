/**
 * friendlyCreateError — map a thrown API error to user-facing copy (2026-06-21).
 *
 * Server-side faults must NOT leak raw/opaque strings (e.g. run402's
 * "Internal function error", its catch-all for an uncaught function throw) to the
 * creator. For a 5xx or an opaque message we show a calm, honest fallback; a clear
 * 4xx validation message (e.g. "At most 20 signers", "Insufficient credit") is
 * genuinely actionable, so it passes through unchanged.
 *
 * `status` comes from `ApiError.status` (api.ts attaches the HTTP status to the
 * thrown error); it's `undefined` for a network/parse failure, which we treat as
 * opaque.
 */
export const GENERIC_ERROR =
  "Sorry, something went wrong on our end. We've logged it and will look into it. Please try again in a moment.";

export function friendlyCreateError(status: number | undefined, message: string | undefined): string {
  if (!message) return GENERIC_ERROR;
  if (status !== undefined && status >= 500) return GENERIC_ERROR;
  if (/internal (function|server) error/i.test(message)) return GENERIC_ERROR;
  return message;
}

// ── Sign-in copy (GH#20 follow-up, 2026-07-20) ────────────────────────────────
//
// A failed magic-link exchange is a ROUTINE user event, not an edge case:
// run402 supersedes every prior link when a new one is requested (their #279),
// and Gmail threads the identical-subject sign-in emails with the OLDEST
// expanded on top — so users who request twice reliably click a dead link.
// The copy must say exactly what to do next. Never show the transport detail
// ("run402 returned status 401: …"); that lives on ApiError.reason for
// debugging. Style note: user-facing strings here avoid dash-as-pause
// (outbound writing rule) — the test pins that.

import { ApiError } from './api';

export const SIGNIN_LINK_STALE =
  'This sign-in link has expired or was replaced by a newer email. Open the newest email, or request a fresh link below.';

export const SIGNIN_SEND_FAILED =
  "Couldn't send the sign-in email. Please try again in a moment.";

/**
 * Shown at the send gate when a 401 sent the creator there (2026-07-25): the
 * server-side session died between page load and Send, or the SPA optimistically
 * took the signed-in path while auth was still hydrating. It is a NOTICE, not an
 * error: the draft is held, and signing in again dispatches it by itself. The raw
 * server string ("Authentication required") must never reach the creator.
 */
/**
 * F-40 / AC-240 — the landing tab's failure copy. A dead sign-in link is not an
 * error page: the visitor's document is still here, and the next step is one
 * button. Names no status code, no vendor and no transport detail.
 */
export const RESTORE_LINK_FAILED =
  'That sign-in link has expired or was already used. Your document is still here. Send yourself a fresh link and it goes out.';

export const RESTORE_DRAFT_GONE =
  'This document is no longer available. Drafts are kept for 7 days, and this one has been removed. Please start a new one.';

/** A restore failure → copy. Anything that is not a clean "gone" reads as a stale link. */
export function friendlyRestoreError(e: unknown): string {
  if (e instanceof ApiError && (e.status === 404 || e.code === 'not_found')) return RESTORE_DRAFT_GONE;
  return GENERIC_ERROR;
}

/**
 * F-027 (red team cycle 22) — the platform caps sign-in emails at 5 per address
 * per hour. We used to swallow that refusal and still say "check your email",
 * which is a lie the visitor has no way to debug: they wait for something that
 * was never sent. Naming it leaks nothing about account existence — it is a fact
 * about the address they just typed, and the answer is the same either way.
 */
export const SIGNIN_THROTTLED =
  'You have asked for several sign-in emails in a short time, so we paused sending. Please open the most recent one already in your inbox, or try again in about an hour.';

export const SESSION_EXPIRED =
  'Your sign-in expired before we could send. Sign in again and your document sends automatically. Nothing was lost.';

// ── F-41 (AC-247/AC-252) — Google sign-in copy. Plain words, next step named,
// no status code, no vendor reason string (the F-40.3 language bar). ──────────

/** The platform refuses a same-email Google sign-in until the account links
 *  Google (F-41.4): tell them the one path that works, in their own words. */
export const GOOGLE_ACCOUNT_EXISTS =
  'This email already has an account here. Sign in with your email link this once, then connect Google from Sign-in methods, and Google will work from then on.';

/** A Google identity can belong to one account only (no silent switching). */
export const GOOGLE_IDENTITY_TAKEN =
  'That Google account is already connected to a different sign-in here. Choose another Google account, or use your email link.';

export const GOOGLE_UNAVAILABLE =
  'Google sign-in is not available right now. Use the email sign-in link instead.';

export const GOOGLE_FAILED =
  'Google sign-in did not complete. You can try again, or use the email sign-in link.';

/** Map a callback `#error=<code>` (or a start/exchange failure) to copy. */
export function friendlyGoogleError(code: string | null | undefined): string {
  switch (code) {
    case 'account_exists_requires_link':
      return GOOGLE_ACCOUNT_EXISTS;
    case 'identity_already_linked':
      return GOOGLE_IDENTITY_TAKEN;
    case 'domain_not_allowed':
      return 'This service is restricted to approved email domains. Sign in with your work Google account.';
    case 'auth_google_unavailable':
      return GOOGLE_UNAVAILABLE;
    default:
      return GOOGLE_FAILED;
  }
}

/** Map a thrown token-exchange failure to actionable sign-in copy. */
export function friendlySignInError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'auth_signin_failed' || e.status === 401) return SIGNIN_LINK_STALE;
    return friendlyCreateError(e.status, e.message);
  }
  // Network/parse failures (TypeError etc.) are opaque to the user.
  return GENERIC_ERROR;
}
