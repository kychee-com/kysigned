/**
 * SignInScreen.tsx — unified sign-in screen used by `<RequireAuth/>` and the
 * marketing landing page (`/?intent=signin`). (2F.AUTH7 baseline.)
 *
 * AUTH7 ships the magic-link path (lifted from DashboardPage's pre-AUTH7
 * inline form). AUTH8 will layer passkey-first logic on top — same component,
 * same API surface, with a passkey probe + WebAuthn ceremony added before
 * the magic-link fallback.
 *
 * Cookie session model (F2.1.7): the server sets `kysigned_session` on
 * /v1/auth/token; this component never sees the run402 tokens. On success,
 * we broadcast `signed-in` to other tabs so AuthContext re-fetches there too.
 */
import { useEffect, useRef, useState } from 'react';
import { telemetryEvent, telemetryEventOnce } from '../lib/telemetry';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiPost } from '../lib/api';
import { friendlySignInError, friendlyGoogleError, GENERIC_ERROR, GOOGLE_FAILED, SIGNIN_SEND_FAILED, SIGNIN_THROTTLED } from '../lib/friendlyError';
import {
  fetchAuthMethods,
  startGoogleSignIn,
  readGoogleHash,
  takeGoogleDraftStash,
} from './google';
import { readAttributionForSubmit } from '../lib/attribution';
import { isValidEmail } from '../lib/validateEmail';
import { hardNavigate } from '../lib/hardNavigate';
import { broadcastAuthEvent, useAuth } from './auth-core';
import {
  passkeysSupported,
  signInWithPasskey,
  conditionalMediationAvailable,
  startConditionalPasskeyLogin,
} from './passkey';


interface SignInScreenProps {
  /** Optional override for the rendered title (defaults to "Sign in"). */
  title?: string;
  /**
   * F-38.3 / AC-230 — WHICH gate the visitor met: 'direct' (landed on the
   * sign-in route), 'redirect' (bounced here from a signed-out attempt at a
   * protected route — RequireAuth passes this), or 'send' (the F-39.3 gate at
   * the end of a guest draft — the envelope editor passes this). 'send' also
   * flips the waiting state to the ON THIS DEVICE instruction (F-39.6).
   */
  telemetryTrigger?: 'direct' | 'redirect' | 'send';
  /**
   * F-39.3 — embedding hook: when provided, a session appearing in this
   * browser calls this EXACTLY ONCE instead of navigating away, so the page
   * holding a draft (the envelope editor) keeps its state and owns what
   * happens next (the held send). Absent → the classic navigate-to-dashboard.
   */
  onSignedIn?: () => void;
  /**
   * F-40 — the pending-send handle this sign-in belongs to. Sent with the
   * magic-link request so the emailed link carries it (DD-57), which is what
   * lets ANY browser that opens the link finish the send.
   */
  draftId?: string;
  /**
   * F-40.1 — called with the address the visitor just typed, immediately BEFORE
   * the magic-link request, and its result becomes the link's `draft_id`. The
   * draft's binding IS its security model, so it cannot be stored before the
   * address is known; and it must be stored before the link is sent, or the link
   * could arrive pointing at nothing. Throwing here sends no link and leaves the
   * visitor on the gate with a message: fail closed.
   */
  prepareDraft?: (email: string) => Promise<string>;
  /** F-40 — prefill for a resend on a restored draft (AC-240): the address is
   *  already known, so nobody retypes what they already gave. */
  initialEmail?: string;
  /**
   * F-41.6 — the send gate's Google path has no address at gate time, so the
   * draft is stored CEREMONY-bound (no email) immediately before the ceremony
   * starts; the returned handle rides the ceremony server-side and the claim
   * binds the establishing session's address (DD-59). Absent on the deliberate
   * and protected-page gates (no draft to hold).
   */
  prepareCeremonyDraft?: () => Promise<string>;
}

/** F-40 — where a landing tab goes once the token has been exchanged. */
function landingDestination(draftId: string | null): string {
  return draftId
    ? `/dashboard/create?draft=${encodeURIComponent(draftId)}&claim=1`
    : '/dashboard';
}

export function SignInScreen({
  title = 'Sign in',
  telemetryTrigger = 'direct',
  onSignedIn,
  draftId,
  prepareDraft,
  initialEmail,
  prepareCeremonyDraft,
}: SignInScreenProps) {
  const { user, refresh } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [emailInput, setEmailInput] = useState(initialEmail ?? '');
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState('');
  const [exchanging, setExchanging] = useState(false);
  // null = probing; true = the browser offers passkey AUTOFILL (so no explicit
  // passkey button is needed); false = no autofill → show the manual passkey link.
  const [autofillAvailable, setAutofillAvailable] = useState<boolean | null>(null);
  const conditionalStarted = useRef(false);
  // F-41.1 — the platform's provider answer; null while probing, and the button
  // renders only on an explicit true (platform-off forks get the email-only gate).
  const [googleAvailable, setGoogleAvailable] = useState<boolean | null>(null);
  const [googleStarting, setGoogleStarting] = useState(false);
  const emailValid = isValidEmail(emailInput);

  // F-41.1 — feature-detect the Google option (server-cached; failure = false).
  useEffect(() => {
    let cancelled = false;
    void fetchAuthMethods().then((m) => {
      if (!cancelled) setGoogleAvailable(m.google);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // F-41 — the same-tab Google landing: the callback hash (`#code`/`#error` +
  // the ceremony id) beside the magic link's `?token=`. Consumed exactly once
  // (the hash is stripped immediately, so a refresh cannot replay it).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const parsed = readGoogleHash(window.location.hash);
    if (!parsed) return;
    const clean = new URL(window.location.href);
    clean.hash = '';
    window.history.replaceState({}, '', clean.toString());

    if (parsed.kind === 'error') {
      // F-41.6 / AC-252 — a failed or refused ceremony with a held draft puts
      // the visitor back in front of their own document (the F-40.3 restore);
      // without one, the gate explains in plain words and stays usable.
      const stashed = takeGoogleDraftStash();
      if (stashed) {
        hardNavigate(
          `/dashboard/create?draft=${encodeURIComponent(stashed)}&signin_failed=1&reason=${encodeURIComponent(parsed.error)}`,
        );
        return;
      }
      setError(friendlyGoogleError(parsed.error));
      return;
    }

    setExchanging(true);
    apiPost<{
      ok?: boolean;
      email?: string;
      linked?: boolean;
      claim?: { status: number; envelope_id?: string; already_sent?: boolean };
    }>('/v1/auth/google/exchange', { code: parsed.code, ceremony: parsed.ceremony })
      .then((result) => {
        if (result.linked) {
          // Connect-Google round trip: back to Sign-in methods, connected.
          hardNavigate('/account/passkeys?linked=1');
          return;
        }
        if (!result.ok || !result.email) {
          setError(GENERIC_ERROR);
          setExchanging(false);
          return;
        }
        broadcastAuthEvent({ type: 'signed-in', email: result.email });
        const claim = result.claim;
        if (claim?.envelope_id) {
          // The ceremony's held draft was claimed and sent (AC-251) — land on it.
          takeGoogleDraftStash();
          hardNavigate(`/dashboard/envelope/${encodeURIComponent(claim.envelope_id)}`);
          return;
        }
        if (claim && claim.status !== 200) {
          // Signed in, but the send was refused (no credit, allowlist — F-39.4):
          // the editor's standard restored-draft path owns what happens next.
          const stashed = takeGoogleDraftStash();
          if (stashed) {
            hardNavigate(`/dashboard/create?draft=${encodeURIComponent(stashed)}&claim=1`);
            return;
          }
        }
        takeGoogleDraftStash();
        hardNavigate('/dashboard');
      })
      .catch(() => {
        const stashed = takeGoogleDraftStash();
        if (stashed) {
          hardNavigate(
            `/dashboard/create?draft=${encodeURIComponent(stashed)}&signin_failed=1&reason=google`,
          );
          return;
        }
        setError(GOOGLE_FAILED);
        setExchanging(false);
      });
  }, []);

  // F-38.3 (AC-216) — the sign-in prompt became visible. Once per page load
  // (eventOnce), naming the trigger; config-gated inside the module.
  useEffect(() => {
    telemetryEventOnce('signin_prompt', telemetryTrigger);
  }, [telemetryTrigger]);

  // Cross-tab pivot: when AuthContext picks up a signed-in user (via the
  // BroadcastChannel from another tab that completed the magic-link exchange,
  // or via visibilitychange re-fetching /v1/auth/user when the user focuses
  // this tab), navigate away from the sign-in screen. The `?next=` query
  // preserved by AppHeader's Sign-in link tells us where to go; default to
  // /dashboard.
  // F-39.3 — embedded (send-gate) mode: the embedding page owns the moment a
  // session appears. Ref-guarded so re-renders and fresh user identities can
  // never re-fire the held send (AC-225's exactly-once).
  const signedInFired = useRef(false);
  useEffect(() => {
    if (!user) return;
    if (onSignedIn) {
      if (signedInFired.current) return;
      signedInFired.current = true;
      onSignedIn();
      return;
    }
    const params = new URLSearchParams(location.search);
    const next = params.get('next');
    // Land on the dashboard after sign-in. `next` only redirects to a REAL
    // protected path (e.g. /dashboard/create the user was bounced from) — a
    // bare `/` (signed in from the marketing home) goes to the dashboard, not
    // back to marketing.
    const dest = next && next.startsWith('/') && next !== '/' ? next : '/dashboard';
    navigate(dest, { replace: true });
  }, [user, location.search, navigate, onSignedIn]);

  // Magic-link landing: the URL carries ?token=<...>, so THIS tab is the one the
  // mail client opened. F-40 — it is the destination, not a waiting room. On
  // success it goes wherever the journey continues (a held draft → the editor,
  // which claims and sends; otherwise the dashboard), and on FAILURE it carries
  // the draft handle to the editor so the visitor gets their filled-in document
  // back instead of an apology with nothing behind it (AC-240).
  //
  // Both destinations are full-page navigations, so the SPA re-hydrates auth from
  // the freshly-set session cookie rather than racing in-memory state.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const tokenFromUrl = params.get('token');
    if (!tokenFromUrl) return;
    // The handle rides the URL precisely BECAUSE it survives a failed exchange
    // (DD-57) — read it before anything can go wrong.
    const draftFromUrl = params.get('draft');
    // Strip the token from the URL bar so a refresh/copy-paste doesn't re-use it.
    const clean = new URL(window.location.href);
    clean.searchParams.delete('token');
    window.history.replaceState({}, '', clean.toString());

    setExchanging(true);
    apiPost<{ ok?: boolean; email?: string; draft_id?: string; error?: string }>('/v1/auth/token', { token: tokenFromUrl })
      .then((result) => {
        if (!result.ok || !result.email) {
          // A 200 without an email is a server-contract violation, not a stale
          // link — the stale/expired case throws (401) and is mapped below.
          setError(GENERIC_ERROR);
          setExchanging(false);
          return;
        }
        broadcastAuthEvent({ type: 'signed-in', email: result.email });
        // Prefer the SERVER's copy of the handle (bound to the token) over the
        // URL's, falling back to the URL when the link predates client_state.
        hardNavigate(landingDestination(result.draft_id ?? draftFromUrl));
      })
      .catch((e) => {
        // A dead link with a draft behind it is not an error page: it is the
        // visitor's own document, plus an explanation and a way to try again.
        if (draftFromUrl) {
          hardNavigate(
            `/dashboard/create?draft=${encodeURIComponent(draftFromUrl)}&signin_failed=1`,
          );
          return;
        }
        setError(friendlySignInError(e));
        setExchanging(false);
      });
  }, [refresh]);

  // Passkey autofill (conditional UI, "option 1"): on a browser that supports it,
  // start a background usernameless WebAuthn request so the device's passkeys
  // appear inside the email field's autofill — and ONLY when the device has one.
  // No passkey on the device → nothing shows, no misleading button. When autofill
  // ISN'T available we fall back to the manual passkey link below. Best-effort:
  // any failure/abort is silent (email sign-in still works).
  useEffect(() => {
    if (conditionalStarted.current) return;
    if (!passkeysSupported()) {
      setAutofillAvailable(false);
      return;
    }
    conditionalStarted.current = true;
    const ctrl = new AbortController();
    let cancelled = false;
    (async () => {
      const available = await conditionalMediationAvailable();
      if (cancelled) return;
      setAutofillAvailable(available);
      if (!available) return;
      const result = await startConditionalPasskeyLogin({ signal: ctrl.signal });
      if (cancelled || !result.ok || !result.email) return;
      broadcastAuthEvent({ type: 'signed-in', email: result.email });
      void refresh();
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [refresh]);

  // "Check your email" → auto-advance. While this tab waits, poll the session:
  // clicking the magic link in ANOTHER tab sets the session cookie, which is
  // shared across same-origin tabs, so the next /v1/auth/user check here sees the
  // session and the navigate effect moves this tab to the dashboard. Robust even
  // when the cross-tab broadcast is missed (the bug where the original tab stayed
  // stuck on "check your email").
  useEffect(() => {
    if (!magicLinkSent || user) return;
    const id = setInterval(() => {
      void refresh();
    }, 2500);
    return () => clearInterval(id);
  }, [magicLinkSent, user, refresh]);

  const attemptPasskey = async () => {
    setError('');
    const result = await signInWithPasskey({ email: emailInput.trim() || undefined });
    if (result.ok && result.email) {
      broadcastAuthEvent({ type: 'signed-in', email: result.email });
      void refresh();
      return;
    }
    // Surface a friendly message but DON'T fall through to magic-link
    // automatically — the user explicitly chose passkey and may want to retry
    // rather than receive a magic-link email they didn't ask for.
    setError(result.error || 'Passkey sign-in failed. Try again or use the email sign-in link.');
  };

  // F-41.1 — the Google path: the ceremony leaves this page (same-tab redirect),
  // so a send-gate draft is committed FIRST (ceremony-bound, DD-59) exactly like
  // the email path stores before its link goes out. Fail closed: no draft
  // stored → no ceremony started → the visitor keeps their filled-in form.
  const attemptGoogle = async () => {
    if (googleStarting) return;
    telemetryEvent('signin_google', telemetryTrigger);
    setError('');
    setGoogleStarting(true);
    try {
      let handle = draftId;
      if (!handle && prepareCeremonyDraft) {
        handle = await prepareCeremonyDraft();
      }
      const attribution = readAttributionForSubmit();
      const url = await startGoogleSignIn({
        trigger: telemetryTrigger,
        ...(handle ? { draftHandle: handle } : {}),
        ...(attribution ? { attribution } : {}),
      });
      hardNavigate(url);
    } catch {
      setError(friendlyGoogleError('auth_google_unavailable'));
      setGoogleStarting(false);
    }
  };

  const requestMagicLink = async () => {
    if (!isValidEmail(emailInput)) return;
    // F-38.3 — the magic-link submit (the act only; the address never rides
    // telemetry — the identifier-free rail).
    telemetryEvent('signin_submit');
    setError('');
    // F-40.1 — the draft is stored FIRST, with the address now known, so the
    // link can never arrive pointing at nothing. A failure here sends no link.
    let handle = draftId;
    if (!handle && prepareDraft) {
      try {
        handle = await prepareDraft(emailInput.trim());
      } catch {
        setError(SIGNIN_SEND_FAILED);
        return;
      }
    }
    try {
      // F-37 — the attribution rider: the email submit runs in the browser
      // that holds the gclid capture (the link may be opened on another
      // device), so the capture travels with THIS request. Null (organic, or
      // attribution disabled — the fork default) sends no field at all.
      const attribution = readAttributionForSubmit();
      const sent = await apiPost<{ throttled?: boolean }>('/v1/auth/magic-link', {
        email: emailInput.trim(),
        ...(attribution ? { attribution } : {}),
        // F-40 / DD-57 - the emailed link carries the draft handle, which is what
        // lets ANY browser that opens it finish the send.
        ...(handle ? { draft_id: handle } : {}),
      });
      // F-027 — say so when the platform refused to send, instead of showing a
      // waiting state for an email that will never arrive.
      if (sent?.throttled) setError(SIGNIN_THROTTLED);
      setMagicLinkSent(true);
    } catch {
      setError(SIGNIN_SEND_FAILED);
    }
  };

  const exchangePastedToken = async () => {
    if (!tokenInput.trim()) return;
    setError('');
    // Accept either a bare token OR a full magic-link URL pasted from the
    // email (extract ?token=). Solves the "I don't see a token to copy" UX.
    let token = tokenInput.trim();
    try {
      const maybeUrl = new URL(token);
      const fromQuery = maybeUrl.searchParams.get('token');
      if (fromQuery) token = fromQuery;
    } catch {
      // not a URL — use raw input
    }
    try {
      const result = await apiPost<{ ok?: boolean; email?: string; error?: string }>('/v1/auth/token', { token });
      if (result.ok && result.email) {
        broadcastAuthEvent({ type: 'signed-in', email: result.email });
        void refresh();
      } else {
        setError(GENERIC_ERROR);
      }
    } catch (e) {
      setError(friendlySignInError(e));
    }
  };

  // Full-page load (not client-side nav) so the dashboard re-hydrates auth from
  // the freshly-set session cookie — robust against any in-memory state race
  // (the bug where "Continue to dashboard" bounced back to the sign-in form).
  const goToDashboard = () => {
    hardNavigate('/dashboard');
  };

  if (exchanging) {
    return (
      <div data-testid="signin-screen" className="max-w-lg mx-auto px-4 py-20 text-center">
        <div className="animate-spin h-6 w-6 border-4 border-gray-300 border-t-gray-900 rounded-full mx-auto" />
        <p className="text-sm text-gray-500 mt-4">Signing you in…</p>
      </div>
    );
  }

  return (
    <div data-testid="signin-screen" className="max-w-lg mx-auto px-4 py-20 text-center">
      {/* The largest on-page use of the brand mark (56px). It was the worst
          victim of the fixed-size raster; a vector has no resolution ceiling. */}
      <img
        src="/logo.svg"
        alt="kysigned"
        width={56}
        height={56}
        className="w-14 h-14 rounded-xl mx-auto mb-5"
      />
      <h1 className="text-2xl font-semibold mb-4">{title}</h1>
      {/* F-39.6 — ONE screen serves sign-up AND sign-in: no separate
          registration exists, and a first-time creator must learn that here,
          not bounce off looking for a "create account" button. */}
      <p className="text-gray-500 mb-1">
        Sign in or create your account with your email.
      </p>
      <p className="text-sm text-gray-500 mb-6">
        New here? Your account is created on your first sign-in.
      </p>

      {!magicLinkSent ? (
        <div className="space-y-3">
          {/* Option 1 — passkey AUTOFILL (conditional UI). The email field carries
              `autocomplete="username webauthn"`, so on a supporting browser the
              device's passkeys surface in its autofill dropdown — and only when
              one exists. The manual passkey link below appears ONLY when autofill
              isn't available, so we never show a passkey button to someone who
              has no passkey (AC-41 passkey-first, the no-misleading-button way). */}
          <input
            type="email"
            name="email"
            autoComplete="username webauthn"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            onFocus={() => telemetryEventOnce('signin_email_focus')}
            placeholder="your@email.com"
            className="w-full min-h-[44px] border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            onKeyDown={(e) => e.key === 'Enter' && requestMagicLink()}
            data-testid="signin-email"
          />
          {emailInput.trim() !== '' && !emailValid && (
            <p className="text-left text-xs text-gray-500" data-testid="signin-email-hint">
              Enter a valid email address.
            </p>
          )}
          <button
            onClick={requestMagicLink}
            disabled={!emailValid}
            className={`w-full px-6 py-3 rounded-lg font-medium transition-colors duration-150 ${
              emailValid
                ? 'bg-gray-900 text-white hover:bg-gray-700 active:bg-gray-950 cursor-pointer'
                : 'bg-gray-200 text-gray-500 cursor-not-allowed'
            }`}
            data-testid="signin-send-link"
          >
            Send sign-in link
          </button>
          {passkeysSupported() && autofillAvailable === false && (
            <button
              onClick={attemptPasskey}
              className="w-full min-h-[44px] flex items-center justify-center text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2 cursor-pointer"
              data-testid="signin-passkey"
            >
              Sign in with a passkey instead
            </button>
          )}

          {/* F-41.1 (AC-244) — the Google option, on every arrival of this one
              screen, rendered only when the PLATFORM reports it available; a
              platform-off fork gets the email-only gate with nothing dangling. */}
          {googleAvailable === true && (
            <>
              <div className="flex items-center gap-3 text-xs text-gray-400" aria-hidden="true">
                <span className="flex-1 h-px bg-gray-200" />
                or
                <span className="flex-1 h-px bg-gray-200" />
              </div>
              <button
                onClick={attemptGoogle}
                disabled={googleStarting}
                className="w-full min-h-[44px] flex items-center justify-center gap-2 px-6 py-3 rounded-lg font-medium border border-gray-300 bg-white text-gray-900 hover:bg-gray-50 active:bg-gray-100 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                data-testid="signin-google"
              >
                <svg className="w-4 h-4" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                </svg>
                Continue with Google
              </button>
            </>
          )}

          {/* F-39.6 / AC-228 — the gate answers the fear before the field:
              why an account exists, what it costs (nothing, 4 free), and —
              prominently, size+weight emphasis (AC-231, never color alone) —
              that SIGNERS never need any of this. Long version: FAQ. */}
          <div className="mt-8 text-left bg-gray-50 border border-gray-100 rounded-xl p-5" data-testid="signin-why">
            <h2 className="text-sm font-semibold text-gray-900 mb-2">Why do I need to sign in?</h2>
            <p className="text-sm text-gray-600 leading-relaxed">
              Your account is where your sent documents live: track who has signed, get the completed
              signing record, and keep your credits. Your first 4 documents are free. No credit card needed.
            </p>
            <p className="text-base font-bold text-gray-900 mt-4 leading-snug" data-testid="signin-signers-note">
              Only people SENDING documents need an account. Signers never sign in: they just
              forward the email, and that&rsquo;s it.
            </p>
            {/* F-024 — ALWAYS a new tab: at the send gate this tab holds the
                draft (in-tab state is the F-39.3 design), so an in-tab
                navigation here silently destroys the envelope. Barry hit it
                live. New-tab on every arrival of the screen, for consistency. */}
            <a
              href="/faq#why-sign-in"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center min-h-[44px] mt-1 text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2"
              data-testid="signin-why-faq-link"
            >
              Read more in the FAQ &rarr;
            </a>
          </div>
        </div>
      ) : (
        <div className="space-y-4" data-testid="signin-check-email">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-blue-50 mx-auto">
            <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
          </div>
          <p className="text-sm text-gray-700">
            Check your email at <span className="font-medium">{emailInput}</span>. Click the sign-in link.
          </p>
          {telemetryTrigger === 'send' ? (
            // F-40 / AC-237 — the draft now lives on the service, so the link
            // works from anywhere. This used to shout ON THIS DEVICE, which was
            // true of the old tab-only draft and is false now: a phone-side
            // click FINISHES the send rather than stranding a desktop draft.
            <p className="text-base font-semibold text-gray-900 mb-4" data-testid="gate-any-device-note">
              Open it on any device. Your document is saved, so whichever one you use will send it.
            </p>
          ) : (
            <p className="text-xs text-gray-500 mb-4">
              This tab continues automatically once you click the link.
            </p>
          )}
          {telemetryTrigger !== 'send' && (
            // Hidden at the send gate: this is a FULL navigation to /dashboard,
            // which would leave the held draft behind. The session poll +
            // onSignedIn fire the held send by themselves.
            <button
              onClick={goToDashboard}
              data-testid="signin-continue"
              className="w-full px-6 py-3 bg-gray-900 text-white rounded-lg font-medium transition-colors duration-150 hover:bg-gray-700 active:bg-gray-950 cursor-pointer"
            >
              I&rsquo;ve clicked the link &mdash; continue
            </button>
          )}
          <details className="text-xs text-gray-500 mt-6">
            <summary className="cursor-pointer hover:text-gray-600">
              Sign-in link not working in your email? Paste the URL here
            </summary>
            <div className="mt-3 space-y-2">
              <p className="text-xs text-gray-500">
                Open the sign-in email, right-click the “Sign in to kysigned” link and choose “Copy link address”,
                then paste the full URL below.
              </p>
              <input
                type="text"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={`${typeof window !== 'undefined' ? window.location.origin : 'https://your-domain.example'}/dashboard?token=...`}
                className="w-full min-h-[44px] border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                onKeyDown={(e) => e.key === 'Enter' && exchangePastedToken()}
              />
              <button
                onClick={exchangePastedToken}
                className="w-full px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium transition-colors duration-150 hover:bg-gray-700 active:bg-gray-950 cursor-pointer"
              >
                Sign In
              </button>
            </div>
          </details>
        </div>
      )}

      {error && <p className="text-red-500 text-sm mt-4" data-testid="signin-error">{error}</p>}
    </div>
  );
}
