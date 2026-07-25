/**
 * SignInScreen.gate.test.tsx — F-39.3/.6 (AC-225/AC-228/AC-230): the SEND-gate
 * mode of the one sign-in screen. `telemetryTrigger="send"` names the third
 * gate arrival; `onSignedIn` lets an embedding page (the envelope editor) own
 * what happens when a session appears — no navigation, exactly one callback;
 * and the post-submit waiting state carries the emphasized ON THIS DEVICE
 * instruction (sessions are per-browser; a phone click must not strand the
 * draft).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { apiPostMock, navigateMock, telemetryOnceMock, telemetryEventMock, authHolder } = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  navigateMock: vi.fn(),
  telemetryOnceMock: vi.fn(),
  telemetryEventMock: vi.fn(),
  authHolder: { current: { user: null as null | { email: string }, loading: false, refresh: vi.fn(), signOut: vi.fn() } },
}));

vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

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
  return { ...actual, apiPost: apiPostMock };
});

vi.mock('../lib/telemetry', () => ({
  telemetryEvent: telemetryEventMock,
  telemetryEventOnce: telemetryOnceMock,
  telemetryPageView: vi.fn(),
}));

import { SignInScreen } from './SignInScreen';

function renderGate(props: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter>
      <SignInScreen telemetryTrigger="send" {...props} />
    </MemoryRouter>,
  );
}

describe('SignInScreen — send-gate mode (F-39.3/.6)', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiPostMock.mockResolvedValue({ ok: true });
    navigateMock.mockReset();
    telemetryOnceMock.mockReset();
    telemetryEventMock.mockReset();
    authHolder.current = { user: null, loading: false, refresh: vi.fn(), signOut: vi.fn() };
  });

  it('the send trigger reaches the prompt-shown telemetry (AC-230)', () => {
    renderGate();
    expect(telemetryOnceMock).toHaveBeenCalledWith('signin_prompt', 'send');
  });

  it('onSignedIn fires exactly once when a session appears — and navigation is suppressed', async () => {
    const onSignedIn = vi.fn();
    const { rerender } = renderGate({ onSignedIn });
    expect(onSignedIn).not.toHaveBeenCalled();

    authHolder.current = { ...authHolder.current, user: { email: 'new@example.com' } };
    rerender(
      <MemoryRouter>
        <SignInScreen telemetryTrigger="send" onSignedIn={onSignedIn} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));

    // A second render pass (fresh user object identity) must NOT re-fire.
    authHolder.current = { ...authHolder.current, user: { email: 'new@example.com' } };
    rerender(
      <MemoryRouter>
        <SignInScreen telemetryTrigger="send" onSignedIn={onSignedIn} />
      </MemoryRouter>,
    );
    expect(onSignedIn).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('without onSignedIn the classic navigate-away behavior is unchanged', async () => {
    const { rerender } = render(
      <MemoryRouter>
        <SignInScreen />
      </MemoryRouter>,
    );
    authHolder.current = { ...authHolder.current, user: { email: 'back@example.com' } };
    rerender(
      <MemoryRouter>
        <SignInScreen />
      </MemoryRouter>,
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/dashboard', { replace: true }));
  });

  // F-40 / AC-237 — this used to shout ON THIS DEVICE, which was TRUE of the old
  // tab-only draft and is false now: the draft lives on the service, so a
  // phone-side click FINISHES the send rather than stranding a desktop draft.
  // The instruction was the single most user-hostile line in the flow.
  it('the send-gate waiting state says the link works from ANY device (AC-237)', async () => {
    renderGate();
    fireEvent.change(screen.getByTestId('signin-email'), { target: { value: 'guest@example.com' } });
    fireEvent.click(screen.getByTestId('signin-send-link'));
    const note = await screen.findByTestId('gate-any-device-note');
    expect(note.textContent).toMatch(/any device/i);
    expect(note.textContent).toMatch(/saved/i);
    expect(note.textContent).not.toMatch(/on this device/i);
    // The retired instruction is gone from the DOM entirely, not merely reworded.
    expect(screen.queryByTestId('gate-device-note')).toBeNull();
    expect(screen.queryByTestId('gate-device-phrase')).toBeNull();
  });

  it('the ordinary (non-gate) waiting state carries NO device note at all', async () => {
    render(
      <MemoryRouter>
        <SignInScreen />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByTestId('signin-email'), { target: { value: 'x@example.com' } });
    fireEvent.click(screen.getByTestId('signin-send-link'));
    await screen.findByTestId('signin-check-email');
    expect(screen.queryByTestId('gate-any-device-note')).toBeNull();
    expect(screen.queryByTestId('gate-device-note')).toBeNull();
  });
});
