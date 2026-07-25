/**
 * hardNavigate — the one place the SPA leaves itself.
 *
 * A few moments genuinely need a FULL page load rather than a client-side route
 * change: after a magic-link exchange the app must re-hydrate auth from the
 * freshly-set session cookie, and racing that against in-memory state is the bug
 * that once made "Continue to dashboard" bounce back to the sign-in form.
 *
 * It lives in its own module because `window.location.assign` is not redefinable
 * under jsdom, so a test cannot observe it in place. One named seam is honest
 * about that and keeps every caller's intent identical.
 */
export function hardNavigate(url: string): void {
  window.location.assign(url);
}
