/**
 * SignInScreen.google.test.tsx — F-41.1 (AC-244) + F-41.6 (AC-252): the
 * Continue-with-Google button on the one sign-in screen, the same-tab landing
 * (`#code`/`#error` beside `?token`), and the friendly refusal copy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { apiPostMock, apiGetMock, hardNavigateMock, telemetryOnceMock, telemetryEventMock, authHolder } = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  apiGetMock: vi.fn(),
  hardNavigateMock: vi.fn(),
  telemetryOnceMock: vi.fn(),
  telemetryEventMock: vi.fn(),
  authHolder: { current: { user: null as null | { email: string }, loading: false, refresh: vi.fn(), signOut: vi.fn() } },
}));

vi.mock('./auth-core', () => ({
  useAuth: () => authHolder.current,
  broadcastAuthEvent: vi.fn(),
}));

vi.mock('./passkey', () => ({
  passkeysSupported: () => false,
  conditionalMediationAvailable: async () => false,
  startConditionalPasskeyLogin: async () => ({ ok: false }),
  signInWithPasskey: async () => ({ ok: false }),
}));

vi.mock('../lib/api', async (importActual) => {
  const actual = await importActual<typeof import('../lib/api')>();
  return { ...actual, apiPost: apiPostMock, apiGet: apiGetMock };
});

vi.mock('../lib/hardNavigate', () => ({ hardNavigate: hardNavigateMock }));

vi.mock('../lib/telemetry', () => ({
  telemetryEvent: telemetryEventMock,
  telemetryEventOnce: telemetryOnceMock,
  telemetryPageView: vi.fn(),
}));

import { SignInScreen } from './SignInScreen';
import { resetAuthMethodsCache, GOOGLE_DRAFT_STASH_KEY } from './google';
import { GOOGLE_ACCOUNT_EXISTS } from '../lib/friendlyError';

const CEREMONY = 'gc_00000000-0000-4000-8000-000000000001';
const HANDLE = 'ps_00000000-0000-4000-8000-000000000000.' + 'S'.repeat(43);

function renderScreen(props: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter>
      <SignInScreen {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiPostMock.mockReset();
  apiGetMock.mockReset();
  hardNavigateMock.mockReset();
  telemetryOnceMock.mockReset();
  telemetryEventMock.mockReset();
  resetAuthMethodsCache();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/dashboard');
  authHolder.current = { user: null, loading: false, refresh: vi.fn(), signOut: vi.fn() };
  apiGetMock.mockResolvedValue({ google: true });
  apiPostMock.mockResolvedValue({ ok: true });
});

describe('the Google option on the gate (AC-244)', () => {
  it('renders when the platform reports google, records the chose-google step with the trigger, starts, and navigates', async () => {
    apiPostMock.mockResolvedValue({ authorization_url: 'https://accounts.google.com/x' });
    renderScreen({ telemetryTrigger: 'redirect' });
    const btn = await screen.findByTestId('signin-google');
    expect(btn.textContent).toMatch(/Continue with Google/);
    fireEvent.click(btn);
    await waitFor(() => expect(hardNavigateMock).toHaveBeenCalledWith('https://accounts.google.com/x'));
    expect(telemetryEventMock).toHaveBeenCalledWith('signin_google', 'redirect');
    expect(apiPostMock).toHaveBeenCalledWith('/v1/auth/google/start', expect.objectContaining({ trigger: 'redirect' }));
  });

  it('is absent when the platform reports google off — the email form stands alone, whole', async () => {
    apiGetMock.mockResolvedValue({ google: false });
    renderScreen();
    expect(await screen.findByTestId('signin-send-link')).toBeTruthy();
    expect(screen.queryByTestId('signin-google')).toBeNull();
  });

  it('a send-gate Google click stores the draft FIRST via prepareCeremonyDraft and rides its handle', async () => {
    apiPostMock.mockResolvedValue({ authorization_url: 'https://accounts.google.com/x' });
    const prepareCeremonyDraft = vi.fn(async () => HANDLE);
    renderScreen({ telemetryTrigger: 'send', prepareCeremonyDraft });
    fireEvent.click(await screen.findByTestId('signin-google'));
    await waitFor(() => expect(hardNavigateMock).toHaveBeenCalled());
    expect(prepareCeremonyDraft).toHaveBeenCalledTimes(1);
    expect(apiPostMock).toHaveBeenCalledWith(
      '/v1/auth/google/start',
      expect.objectContaining({ trigger: 'send', draft_id: HANDLE }),
    );
    expect(sessionStorage.getItem(GOOGLE_DRAFT_STASH_KEY)).toBe(HANDLE);
  });

  it('a start failure shows friendly copy and leaves the email form usable (fail to email-only)', async () => {
    apiPostMock.mockRejectedValue(new Error('503'));
    renderScreen();
    fireEvent.click(await screen.findByTestId('signin-google'));
    await waitFor(() => expect(screen.getByTestId('signin-screen').textContent).toMatch(/email sign-in link/i));
    expect(screen.getByTestId('signin-send-link')).toBeTruthy();
    expect(hardNavigateMock).not.toHaveBeenCalled();
  });
});

describe('the same-tab landing (#code / #error beside ?token)', () => {
  it('#code exchanges and lands on the claimed document page (AC-251 shape)', async () => {
    window.history.replaceState({}, '', `/dashboard#code=abc&state=${CEREMONY}`);
    apiPostMock.mockResolvedValue({ ok: true, email: 'fresh@x.com', claim: { status: 200, envelope_id: 'env-9' } });
    renderScreen();
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith('/v1/auth/google/exchange', { code: 'abc', ceremony: CEREMONY }),
    );
    await waitFor(() => expect(hardNavigateMock).toHaveBeenCalledWith('/dashboard/envelope/env-9'));
  });

  it('#code with no draft lands on the dashboard', async () => {
    window.history.replaceState({}, '', `/dashboard#code=abc&state=${CEREMONY}`);
    apiPostMock.mockResolvedValue({ ok: true, email: 'fresh@x.com' });
    renderScreen();
    await waitFor(() => expect(hardNavigateMock).toHaveBeenCalledWith('/dashboard'));
  });

  it('a claim refusal keeps the sign-in and routes to the restored draft (F-39.4)', async () => {
    window.history.replaceState({}, '', `/dashboard#code=abc&state=${CEREMONY}`);
    sessionStorage.setItem(GOOGLE_DRAFT_STASH_KEY, HANDLE);
    apiPostMock.mockResolvedValue({ ok: true, email: 'fresh@x.com', claim: { status: 402, code: 'payment_insufficient_credit' } });
    renderScreen();
    await waitFor(() =>
      expect(hardNavigateMock).toHaveBeenCalledWith(`/dashboard/create?draft=${encodeURIComponent(HANDLE)}&claim=1`),
    );
  });

  it('a linked outcome lands on Sign-in methods', async () => {
    window.history.replaceState({}, '', `/dashboard#code=abc&state=${CEREMONY}`);
    apiPostMock.mockResolvedValue({ ok: true, linked: true, email: 'owner@x.com' });
    renderScreen();
    await waitFor(() => expect(hardNavigateMock).toHaveBeenCalledWith('/account/passkeys?linked=1'));
  });

  it('#error with a stashed draft returns the visitor to their filled-in document (AC-252)', async () => {
    window.history.replaceState({}, '', `/dashboard#error=token_exchange_failed&state=${CEREMONY}`);
    sessionStorage.setItem(GOOGLE_DRAFT_STASH_KEY, HANDLE);
    renderScreen();
    await waitFor(() =>
      expect(hardNavigateMock).toHaveBeenCalledWith(
        `/dashboard/create?draft=${encodeURIComponent(HANDLE)}&signin_failed=1&reason=token_exchange_failed`,
      ),
    );
  });

  it('#error account_exists_requires_link (no draft) renders the linking guidance in plain words', async () => {
    window.history.replaceState({}, '', `/dashboard#error=account_exists_requires_link&state=${CEREMONY}`);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('signin-screen').textContent).toContain(GOOGLE_ACCOUNT_EXISTS));
    expect(hardNavigateMock).not.toHaveBeenCalled();
    // The hash is consumed — a refresh does not replay the error.
    expect(window.location.hash).toBe('');
  });
});
