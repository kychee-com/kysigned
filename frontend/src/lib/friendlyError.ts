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
  "Sorry — something went wrong on our end. We've logged it and will look into it. Please try again in a moment.";

export function friendlyCreateError(status: number | undefined, message: string | undefined): string {
  if (!message) return GENERIC_ERROR;
  if (status !== undefined && status >= 500) return GENERIC_ERROR;
  if (/internal (function|server) error/i.test(message)) return GENERIC_ERROR;
  return message;
}
