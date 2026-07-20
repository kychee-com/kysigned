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

/** Map a thrown token-exchange failure to actionable sign-in copy. */
export function friendlySignInError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'auth_signin_failed' || e.status === 401) return SIGNIN_LINK_STALE;
    return friendlyCreateError(e.status, e.message);
  }
  // Network/parse failures (TypeError etc.) are opaque to the user.
  return GENERIC_ERROR;
}
