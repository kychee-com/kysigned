/**
 * SignInScreen.copy.test.tsx — F-39.6 (AC-228): the gate explains itself.
 * One screen serves sign-up AND sign-in; a friendly "Why do I need to sign
 * in?" explainer sits below the email input (account = where sent envelopes
 * live; trial terms); it ends with the visually PROMINENT distinction that
 * signers never sign in; and it links to the FAQ long answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { authHolder } = vi.hoisted(() => ({
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

vi.mock('../lib/telemetry', () => ({
  telemetryEvent: vi.fn(),
  telemetryEventOnce: vi.fn(),
  telemetryPageView: vi.fn(),
}));

import { SignInScreen } from './SignInScreen';

function renderScreen(props: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter>
      <SignInScreen {...props} />
    </MemoryRouter>,
  );
}

describe('SignInScreen — the gate explains itself (F-39.6 / AC-228)', () => {
  beforeEach(() => {
    authHolder.current = { user: null, loading: false, refresh: vi.fn(), signOut: vi.fn() };
  });

  it('reads as sign-up AND sign-in in one — no separate registration exists', () => {
    renderScreen();
    // The screen must tell a NEW creator their account is created right here.
    expect(screen.getByTestId('signin-screen').textContent).toMatch(/new here\?.*account is created/is);
  });

  it('renders the why-explainer below the email input: envelopes live in the account + the trial terms', () => {
    renderScreen();
    const why = screen.getByTestId('signin-why');
    expect(why.textContent).toMatch(/why do i need to sign in\?/i);
    expect(why.textContent).toMatch(/where your sent envelopes live/i);
    expect(why.textContent).toMatch(/first 4 .*free/i);
    expect(why.textContent).toMatch(/no credit card/i);
  });

  it('ends with the PROMINENT signers-never note, emphasized by its own element', () => {
    renderScreen();
    const note = screen.getByTestId('signin-signers-note');
    expect(note.textContent).toMatch(/only people sending documents need an account/i);
    expect(note.textContent).toMatch(/signers never sign in/i);
    expect(note.textContent).toMatch(/forward/i);
  });

  it('links to the FAQ long answer at its stable anchor', () => {
    renderScreen();
    const link = screen.getByTestId('signin-why-faq-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/faq#why-sign-in');
  });

  it('the explainer renders on every arrival of the same screen — send gate included', () => {
    renderScreen({ telemetryTrigger: 'send' });
    expect(screen.getByTestId('signin-why')).toBeTruthy();
    expect(screen.getByTestId('signin-signers-note')).toBeTruthy();
  });
});
