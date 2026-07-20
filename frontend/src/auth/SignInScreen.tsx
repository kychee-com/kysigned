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
import { useLocation, useNavigate } from 'react-router-dom';
import { apiPost } from '../lib/api';
import { readAttributionForSubmit } from '../lib/attribution';
import { isValidEmail } from '../lib/validateEmail';
import { broadcastAuthEvent, useAuth } from './auth-core';
import {
  passkeysSupported,
  signInWithPasskey,
  conditionalMediationAvailable,
  startConditionalPasskeyLogin,
} from './passkey';

const CONFIRM_COUNTDOWN_SECONDS = 5;

interface SignInScreenProps {
  /** Optional override for the rendered title (defaults to "Sign in"). */
  title?: string;
}

export function SignInScreen({ title = 'Sign in' }: SignInScreenProps) {
  const { user, refresh } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [emailInput, setEmailInput] = useState('');
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState('');
  const [exchanging, setExchanging] = useState(false);
  const [signedInConfirmation, setSignedInConfirmation] = useState(false);
  // null = probing; true = the browser offers passkey AUTOFILL (so no explicit
  // passkey button is needed); false = no autofill → show the manual passkey link.
  const [autofillAvailable, setAutofillAvailable] = useState<boolean | null>(null);
  const conditionalStarted = useRef(false);
  const emailValid = isValidEmail(emailInput);

  // Magic-link confirmation card: counts down then tries to close the tab. A tab
  // opened from an email link usually CAN'T be closed by script (browser
  // security), so when the attempt no-ops we fall back to "you can close this".
  const [countdown, setCountdown] = useState(CONFIRM_COUNTDOWN_SECONDS);
  const [autoCloseActive, setAutoCloseActive] = useState(true);
  const [closeAttempted, setCloseAttempted] = useState(false);

  // Cross-tab pivot: when AuthContext picks up a signed-in user (via the
  // BroadcastChannel from another tab that completed the magic-link exchange,
  // or via visibilitychange re-fetching /v1/auth/user when the user focuses
  // this tab), navigate away from the sign-in screen. The `?next=` query
  // preserved by AppHeader's Sign-in link tells us where to go; default to
  // /dashboard. We DO NOT navigate while showing the post-token-exchange
  // confirmation card — that tab opened from the magic-link click and the
  // user explicitly chooses Continue/Close themselves.
  useEffect(() => {
    if (!user) return;
    if (signedInConfirmation) return;
    const params = new URLSearchParams(location.search);
    const next = params.get('next');
    // Land on the dashboard after sign-in. `next` only redirects to a REAL
    // protected path (e.g. /dashboard/create the user was bounced from) — a
    // bare `/` (signed in from the marketing home) goes to the dashboard, not
    // back to marketing.
    const dest = next && next.startsWith('/') && next !== '/' ? next : '/dashboard';
    navigate(dest, { replace: true });
  }, [user, signedInConfirmation, location.search, navigate]);

  // Magic-link forwarder: if the URL contains ?token=<...>, treat THIS render
  // as a post-magic-link landing and auto-exchange the token. Replaces the
  // copy of this logic that used to live in DashboardPage.tsx (AUTH4 era).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const tokenFromUrl = params.get('token');
    if (!tokenFromUrl) return;
    // Strip the token from the URL bar so a refresh/copy-paste doesn't re-use it.
    const clean = new URL(window.location.href);
    clean.searchParams.delete('token');
    window.history.replaceState({}, '', clean.toString());

    setExchanging(true);
    apiPost<{ ok?: boolean; email?: string; error?: string }>('/v1/auth/token', { token: tokenFromUrl })
      .then((result) => {
        if (!result.ok || !result.email) {
          setError(result.error || 'Magic link expired or invalid. Please request a new one.');
          return;
        }
        broadcastAuthEvent({ type: 'signed-in', email: result.email });
        void refresh();
        setSignedInConfirmation(true);
      })
      .catch((e) => setError((e as Error).message ?? 'Sign-in failed'))
      .finally(() => setExchanging(false));
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

  // Confirmation-card auto-close countdown. Decrements once a second; at zero it
  // attempts window.close() and (since that's usually blocked for tabs opened
  // from an email link) flips to the "you can close this tab" message.
  useEffect(() => {
    if (!signedInConfirmation || !autoCloseActive) return;
    if (countdown <= 0) {
      window.close();
      setCloseAttempted(true);
      setAutoCloseActive(false);
      return;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [signedInConfirmation, autoCloseActive, countdown]);

  // "Check your email" → auto-advance. While this tab waits, poll the session:
  // clicking the magic link in ANOTHER tab sets the session cookie, which is
  // shared across same-origin tabs, so the next /v1/auth/user check here sees the
  // session and the navigate effect moves this tab to the dashboard. Robust even
  // when the cross-tab broadcast is missed (the bug where the original tab stayed
  // stuck on "check your email").
  useEffect(() => {
    if (!magicLinkSent || user || signedInConfirmation) return;
    const id = setInterval(() => {
      void refresh();
    }, 2500);
    return () => clearInterval(id);
  }, [magicLinkSent, user, signedInConfirmation, refresh]);

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

  const requestMagicLink = async () => {
    if (!isValidEmail(emailInput)) return;
    setError('');
    try {
      // F-37 — the attribution rider: the email submit runs in the browser
      // that holds the gclid capture (the link may be opened on another
      // device), so the capture travels with THIS request. Null (organic, or
      // attribution disabled — the fork default) sends no field at all.
      const attribution = readAttributionForSubmit();
      await apiPost('/v1/auth/magic-link', {
        email: emailInput.trim(),
        ...(attribution ? { attribution } : {}),
      });
      setMagicLinkSent(true);
    } catch (e) {
      setError((e as Error).message ?? 'Failed to send sign-in link');
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
        setError(result.error || 'Invalid or expired token');
      }
    } catch (e) {
      setError((e as Error).message ?? 'Sign-in failed');
    }
  };

  const closeThisPage = () => {
    setAutoCloseActive(false);
    window.close();
    setCloseAttempted(true);
  };

  // Full-page load (not client-side nav) so the dashboard re-hydrates auth from
  // the freshly-set session cookie — robust against any in-memory state race
  // (the bug where "Continue to dashboard" bounced back to the sign-in form).
  const goToDashboard = () => {
    window.location.assign('/dashboard');
  };

  if (exchanging) {
    return (
      <div data-testid="signin-screen" className="max-w-lg mx-auto px-4 py-20 text-center">
        <div className="animate-spin h-6 w-6 border-4 border-gray-300 border-t-gray-900 rounded-full mx-auto" />
        <p className="text-sm text-gray-500 mt-4">Signing you in…</p>
      </div>
    );
  }

  // Post-magic-link success card. The original tab (if separate) is already
  // signed-in via BroadcastChannel; THIS tab offers "Continue" to /dashboard
  // or "Close this tab" so the user returns to the tab they started in.
  if (signedInConfirmation) {
    return (
      <div data-testid="signin-screen" className="max-w-lg mx-auto px-4 py-20 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-50 mb-6">
          <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold mb-3">Sign in successful</h1>
        <p className="text-gray-600 mb-6">
          You're signed in. This tab is no longer needed — your original tab is moving to your dashboard.
        </p>

        <div className="space-y-3">
          {!closeAttempted ? (
            <>
              <button
                onClick={closeThisPage}
                data-testid="confirm-close"
                className="w-full px-6 py-3 bg-gray-900 text-white rounded-lg font-medium transition-colors duration-150 hover:bg-gray-700 active:bg-gray-950 cursor-pointer"
              >
                Close this page
              </button>
              {autoCloseActive && (
                <p className="text-xs text-gray-400" data-testid="confirm-countdown">
                  This page will close in {countdown}s.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-gray-500" data-testid="confirm-close-hint">
              You can close this tab — you're signed in.
            </p>
          )}
          <button
            onClick={goToDashboard}
            data-testid="confirm-dashboard"
            className="w-full text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2 cursor-pointer"
          >
            or go to your dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="signin-screen" className="max-w-lg mx-auto px-4 py-20 text-center">
      <img
        src="/favicon.png"
        alt="kysigned"
        width={56}
        height={56}
        className="w-14 h-14 rounded-xl mx-auto mb-5"
      />
      <h1 className="text-2xl font-semibold mb-4">{title}</h1>
      <p className="text-gray-500 mb-6">
        Sign in with your email to view your dashboard.
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
            placeholder="your@email.com"
            className="w-full min-h-[44px] border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            onKeyDown={(e) => e.key === 'Enter' && requestMagicLink()}
            data-testid="signin-email"
          />
          {emailInput.trim() !== '' && !emailValid && (
            <p className="text-left text-xs text-gray-400" data-testid="signin-email-hint">
              Enter a valid email address.
            </p>
          )}
          <button
            onClick={requestMagicLink}
            disabled={!emailValid}
            className={`w-full px-6 py-3 rounded-lg font-medium transition-colors duration-150 ${
              emailValid
                ? 'bg-gray-900 text-white hover:bg-gray-700 active:bg-gray-950 cursor-pointer'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
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
          <p className="text-xs text-gray-500 mb-4">
            This tab continues automatically once you click the link — or use the button below.
          </p>
          <button
            onClick={goToDashboard}
            data-testid="signin-continue"
            className="w-full px-6 py-3 bg-gray-900 text-white rounded-lg font-medium transition-colors duration-150 hover:bg-gray-700 active:bg-gray-950 cursor-pointer"
          >
            I&rsquo;ve clicked the link &mdash; continue
          </button>
          <details className="text-xs text-gray-400 mt-6">
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

      {error && <p className="text-red-500 text-sm mt-4">{error}</p>}
    </div>
  );
}
