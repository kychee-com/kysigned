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

  // F-024 (Barry, live QA 2026-07-23): the FAQ link navigated IN-TAB, which
  // destroys a held draft — the exact failure class F-39.3 forbids. The gate
  // holds irreplaceable in-tab state, so EVERY anchor the gate renders must
  // open elsewhere. Class-level lock, not a single-link patch.
  it('every anchor on the gate opens in a NEW tab — no link may cost the held draft (F-024)', () => {
    const { container } = renderScreen({ telemetryTrigger: 'send' });
    const anchors = Array.from(container.querySelectorAll('a[href]'));
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(a.getAttribute('target'), `anchor ${a.getAttribute('href')} must not navigate the draft tab`).toBe('_blank');
      expect(a.getAttribute('rel') ?? '').toMatch(/noopener/);
    }
  });

  it('the explainer renders on every arrival of the same screen — send gate included', () => {
    renderScreen({ telemetryTrigger: 'send' });
    expect(screen.getByTestId('signin-why')).toBeTruthy();
    expect(screen.getByTestId('signin-signers-note')).toBeTruthy();
  });

  // F-023 (Cycle 19, AC-231): the sweep flagged .text-gray-400 as failing AA
  // contrast on the gate. gray-500 is the floor on white.
  it('no low-contrast .text-gray-400 remains on the sign-in screen', () => {
    const { container } = renderScreen();
    expect(container.querySelectorAll('.text-gray-400')).toHaveLength(0);
  });
});
