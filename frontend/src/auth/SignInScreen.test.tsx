/**
 * SignInScreen.test.tsx — passkey-first behavior (2F.AUTH8).
 *
 * Verifies: (a) passkey button rendered when supported, (b) magic-link is
 * the only path when PublicKeyCredential is undefined.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './AuthContext';
import { SignInScreen } from './SignInScreen';

describe('SignInScreen — passkey-first behavior', () => {
  const orig = (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 })),
    ));
  });

  afterEach(() => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = orig;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('offers the manual passkey link when passkeys are supported but autofill is not', async () => {
    // jsdom's stubbed PublicKeyCredential has no isConditionalMediationAvailable,
    // so autofill resolves unavailable → the manual passkey link is shown.
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = function () {};

    render(
      <MemoryRouter>
        <AuthProvider>
          <SignInScreen />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('signin-email')).toBeInTheDocument();
    });
    // The big "Sign in with passkey" button is gone; a subtle link is the manual fallback.
    expect(await screen.findByTestId('signin-passkey')).toHaveTextContent(/passkey/i);
    expect(screen.getByTestId('signin-send-link')).toHaveTextContent(/send sign-in link/i);
  });

  // Task 40.6 / UX-004: the "Sign in with a passkey instead" link-button rendered at
  // ~343×24 on webkit (the text line-box), under the 44px tap-target minimum. It now
  // reserves min-h-[44px] while keeping the subtle text-link styling.
  it('the manual passkey button reserves a >=44px tap target (UX-004)', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = function () {};
    render(
      <MemoryRouter>
        <AuthProvider>
          <SignInScreen />
        </AuthProvider>
      </MemoryRouter>,
    );
    const passkeyBtn = await screen.findByTestId('signin-passkey');
    // jsdom can't compute Tailwind px; assert the reserved min-height utility (→ 44px).
    // The design-validation sweep verifies the rendered px on webkit.
    expect(passkeyBtn.className).toContain('min-h-[44px]');
    expect(passkeyBtn.className).toMatch(/items-center/); // vertically centred, not top-aligned
  });

  it('opts the email field into passkey autofill (autocomplete=username webauthn)', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = function () {};
    render(
      <MemoryRouter>
        <AuthProvider>
          <SignInScreen />
        </AuthProvider>
      </MemoryRouter>,
    );
    const email = await screen.findByTestId('signin-email');
    expect(email).toHaveAttribute('autocomplete', 'username webauthn');
  });

  it('the sign-in email input reserves a >=44px tap target (UX-008 / F-visual)', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = undefined;
    render(
      <MemoryRouter>
        <AuthProvider>
          <SignInScreen />
        </AuthProvider>
      </MemoryRouter>,
    );
    const email = await screen.findByTestId('signin-email');
    // jsdom does not compute Tailwind px, so assert the reserved min-height utility
    // (maps to min-height:44px). The design-validation sweep verifies the rendered px.
    expect(email.className).toContain('min-h-[44px]');
  });

  it('disables "Send sign-in link" until a valid email is entered', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = undefined;
    render(
      <MemoryRouter>
        <AuthProvider>
          <SignInScreen />
        </AuthProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('signin-email')).toBeInTheDocument());

    const send = screen.getByTestId('signin-send-link');
    // empty → disabled
    expect(send).toBeDisabled();
    // malformed → still disabled
    fireEvent.change(screen.getByTestId('signin-email'), { target: { value: 'not-an-email' } });
    expect(send).toBeDisabled();
    // valid → enabled
    fireEvent.change(screen.getByTestId('signin-email'), { target: { value: 'alice@example.com' } });
    expect(send).toBeEnabled();
  });

  it('does NOT render the passkey button when PublicKeyCredential is undefined', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = undefined;

    render(
      <MemoryRouter>
        <AuthProvider>
          <SignInScreen />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('signin-email')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('signin-passkey')).not.toBeInTheDocument();
    // Email-link is the only path in the no-passkey browser.
    expect(screen.getByTestId('signin-send-link')).toHaveTextContent(/send sign-in link/i);
  });

  it('shows the redesigned success card (countdown + close + dashboard) after a magic-link exchange', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = function () {};
    window.history.replaceState({}, '', '/?token=magic-abc');
    const fetchSpy = vi.fn((url: string) => {
      if (String(url).endsWith('/v1/auth/token')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, email: 'alice@example.com' }), { status: 200 }));
      }
      if (String(url).endsWith('/v1/auth/user')) {
        return Promise.resolve(new Response(JSON.stringify({ email: 'alice@example.com' }), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <MemoryRouter>
        <AuthProvider>
          <SignInScreen />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/sign in successful/i)).toBeInTheDocument();
    expect(screen.getByTestId('confirm-close')).toBeInTheDocument();
    // The passkey nudge moved to the dashboard — it's NOT on this closing page.
    expect(screen.queryByTestId('confirm-create-passkey')).not.toBeInTheDocument();
    expect(screen.getByTestId('confirm-dashboard')).toBeInTheDocument(); // robust dashboard fallback
    expect(screen.getByTestId('confirm-countdown')).toHaveTextContent(/close in 5s/i);

    window.history.replaceState({}, '', '/');
  });

  it('clicking "Close this page" calls window.close and shows the close hint', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = undefined; // hide the passkey nudge
    window.history.replaceState({}, '', '/?token=magic-abc');
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      String(url).endsWith('/v1/auth/token')
        ? Promise.resolve(new Response(JSON.stringify({ ok: true, email: 'a@b.co' }), { status: 200 }))
        : Promise.resolve(new Response(JSON.stringify({ email: 'a@b.co' }), { status: 200 })),
    ));
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});

    render(
      <MemoryRouter>
        <AuthProvider>
          <SignInScreen />
        </AuthProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId('confirm-close'));
    expect(closeSpy).toHaveBeenCalled();
    expect(screen.getByTestId('confirm-close-hint')).toBeInTheDocument();

    window.history.replaceState({}, '', '/');
  });

  it('clicking Email-me submits a magic-link request', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = function () {};
    const fetchSpy = vi.fn((url: string) => {
      if (url.endsWith('/v1/auth/user')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'no' }), { status: 401 }));
      }
      if (url.endsWith('/v1/auth/magic-link')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <MemoryRouter>
        <AuthProvider>
          <SignInScreen />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('signin-email')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('signin-email'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.click(screen.getByTestId('signin-send-link'));

    await waitFor(() => {
      const magicLinkCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/v1/auth/magic-link'));
      expect(magicLinkCall).toBeDefined();
    });

    await waitFor(() => {
      expect(screen.getByTestId('signin-check-email')).toBeInTheDocument();
    });
  });
});
