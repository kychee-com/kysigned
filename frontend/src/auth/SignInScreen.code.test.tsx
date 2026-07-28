/**
 * SignInScreen.code.test.tsx — F-43.2/F-43.3 (AC-258, AC-259): the six-digit
 * entry on the check-email state. The code finishes sign-in IN THIS TAB (the
 * confirm sets the session cookie; refresh() makes the session appear, which
 * is what the gate's held-send and RequireAuth machinery key on), and every
 * failure reads like a person wrote it. Feature-detected: no challenge_id in
 * the request response → the link-only screen of today, byte-for-byte.
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
import { resetAuthMethodsCache } from './google';
import { ApiError } from '../lib/api';
import { CODE_INVALID, CODE_EXHAUSTED, CODE_ALREADY_USED, CODE_TOO_MANY } from '../lib/friendlyError';

function renderScreen(props: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter>
      <SignInScreen {...props} />
    </MemoryRouter>,
  );
}

/** Route the api mock: the magic-link request answers `sendResp`; the code
 *  confirm answers via `codeImpl` (default: resolves ok). */
function routeApi(sendResp: Record<string, unknown>, codeImpl?: () => Promise<unknown>) {
  apiPostMock.mockImplementation(async (path: string) => {
    if (path === '/v1/auth/magic-link') return sendResp;
    if (path === '/v1/auth/code') return codeImpl ? codeImpl() : { ok: true, email: 'a@x.com' };
    return { ok: true };
  });
}

async function submitEmail() {
  fireEvent.change(await screen.findByTestId('signin-email'), { target: { value: 'a@x.com' } });
  fireEvent.click(screen.getByTestId('signin-send-link'));
  await screen.findByTestId('signin-check-email');
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
  apiGetMock.mockResolvedValue({ google: false, email_code: true });
});

describe('the code entry appears only when the platform minted a challenge (AC-258)', () => {
  it('renders the six-digit entry when the request response carries challenge_id', async () => {
    routeApi({ ok: true, challenge_id: 'ch_1' });
    renderScreen();
    await submitEmail();
    expect(screen.getByTestId('signin-code')).toBeTruthy();
    expect(screen.getByTestId('signin-code-confirm')).toBeTruthy();
  });

  it('renders the link-only screen of today when there is no challenge_id — no dangling code UI', async () => {
    routeApi({ ok: true });
    renderScreen();
    await submitEmail();
    expect(screen.queryByTestId('signin-code')).toBeNull();
    expect(screen.queryByTestId('signin-code-confirm')).toBeNull();
  });

  it('renders the entry at the send gate too — one component, trigger-agnostic', async () => {
    routeApi({ ok: true, challenge_id: 'ch_1' });
    renderScreen({ telemetryTrigger: 'send', prepareDraft: vi.fn(async () => undefined) });
    await submitEmail();
    expect(screen.getByTestId('signin-code')).toBeTruthy();
  });
});

describe('a correct code finishes sign-in in this tab (AC-258)', () => {
  it('posts {challenge_id, code} and makes the session appear (refresh) — the gate and RequireAuth take over', async () => {
    routeApi({ ok: true, challenge_id: 'ch_1' });
    renderScreen();
    await submitEmail();
    fireEvent.change(screen.getByTestId('signin-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('signin-code-confirm'));
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith('/v1/auth/code', { challenge_id: 'ch_1', code: '123456' }),
    );
    await waitFor(() => expect(authHolder.current.refresh).toHaveBeenCalled());
  });

  it('does not post until the input is exactly six digits', async () => {
    routeApi({ ok: true, challenge_id: 'ch_1' });
    renderScreen();
    await submitEmail();
    fireEvent.change(screen.getByTestId('signin-code'), { target: { value: '123' } });
    fireEvent.click(screen.getByTestId('signin-code-confirm'));
    expect(apiPostMock).not.toHaveBeenCalledWith('/v1/auth/code', expect.anything());
  });
});

describe('failures read like a person wrote them (AC-259 / F-43.3)', () => {
  it('a wrong code shows retry copy and leaves the entry usable for another try', async () => {
    routeApi({ ok: true, challenge_id: 'ch_1' }, async () => {
      throw new ApiError('nope', 401, { code: 'auth_code_invalid' });
    });
    renderScreen();
    await submitEmail();
    fireEvent.change(screen.getByTestId('signin-code'), { target: { value: '111111' } });
    fireEvent.click(screen.getByTestId('signin-code-confirm'));
    const alert = await screen.findByText(CODE_INVALID);
    expect(alert.textContent).not.toMatch(/R402|status \d|_/);
    // retry is possible: the entry is still there and editable
    fireEvent.change(screen.getByTestId('signin-code'), { target: { value: '222222' } });
    expect((screen.getByTestId('signin-code') as HTMLInputElement).value).toBe('222222');
  });

  it('an exhausted challenge says the code no longer works and points at a fresh email', async () => {
    routeApi({ ok: true, challenge_id: 'ch_1' }, async () => {
      throw new ApiError('burned', 401, { code: 'auth_code_exhausted' });
    });
    renderScreen();
    await submitEmail();
    fireEvent.change(screen.getByTestId('signin-code'), { target: { value: '111111' } });
    fireEvent.click(screen.getByTestId('signin-code-confirm'));
    const alert = await screen.findByText(CODE_EXHAUSTED);
    expect(alert.textContent).not.toMatch(/R402|status \d|_/);
  });
});

// ── FC28.5 / F-033 (AC-259) — the screen REMEMBERS that the challenge is dead ─
//
// The screen held one flat `error` string that every submit overwrote, so the
// terminal state was forgotten the instant the visitor tried again: they saw
// "that code no longer works", pressed Sign in once more, and got "that code
// didn't match" — the product talking itself out of the truth it had just told.
// A dead challenge must also stop consuming the platform's verification budget.
describe('a terminal outcome latches, and offers the one way out (AC-259)', () => {
  const terminalCases = [
    ['auth_code_exhausted', CODE_EXHAUSTED],
    ['auth_code_used', CODE_ALREADY_USED],
    ['auth_code_too_many', CODE_TOO_MANY],
  ] as const;

  /**
   * `code` is the terminal outcome the first submit gets. `thenCode` is what a
   * SECOND submit would get — defaulting to the retry copy, which is exactly
   * the degradation the cycle reproduced (the screen talking itself out of the
   * truth it just told). With the latch, that second request is never sent.
   */
  async function reachTerminal(code: string, thenCode = 'auth_code_invalid') {
    let confirms = 0;
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === '/v1/auth/magic-link') return { ok: true, challenge_id: 'ch_1' };
      if (path === '/v1/auth/code') {
        confirms += 1;
        throw new ApiError('x', 401, { code: confirms === 1 ? code : thenCode });
      }
      return { ok: true };
    });
    renderScreen();
    await submitEmail();
    fireEvent.change(screen.getByTestId('signin-code'), { target: { value: '111111' } });
    fireEvent.click(screen.getByTestId('signin-code-confirm'));
    return { confirmCount: () => confirms };
  }

  it.each(terminalCases)('%s latches: the copy survives a further submit attempt', async (code, copy) => {
    const { confirmCount } = await reachTerminal(code);
    await screen.findByText(copy);
    expect(confirmCount()).toBe(1);

    // The visitor presses Sign in again. The copy must NOT flip to "didn't
    // match" — and the request that would have produced it is never issued.
    fireEvent.click(screen.getByTestId('signin-code-confirm'));
    await waitFor(() => expect(screen.getByTestId('signin-error').textContent).toBe(copy));
    expect(screen.queryByText(CODE_INVALID)).toBeNull();
    expect(confirmCount()).toBe(1);
  });

  it('while latched, the entry and its submit are disabled and no further confirm is issued', async () => {
    const { confirmCount } = await reachTerminal('auth_code_used');
    await screen.findByText(CODE_ALREADY_USED);
    expect((screen.getByTestId('signin-code') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('signin-code-confirm') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('signin-code-confirm'));
    fireEvent.keyDown(screen.getByTestId('signin-code'), { key: 'Enter' });
    await waitFor(() => expect(confirmCount()).toBe(1));
  });

  it('the resend control appears ONLY on a terminal state', async () => {
    routeApi({ ok: true, challenge_id: 'ch_1' }, async () => {
      throw new ApiError('nope', 401, { code: 'auth_code_invalid' });
    });
    renderScreen();
    await submitEmail();
    expect(screen.queryByTestId('signin-code-resend')).toBeNull();
    fireEvent.change(screen.getByTestId('signin-code'), { target: { value: '111111' } });
    fireEvent.click(screen.getByTestId('signin-code-confirm'));
    await screen.findByText(CODE_INVALID);
    expect(screen.queryByTestId('signin-code-resend')).toBeNull();
    expect((screen.getByTestId('signin-code') as HTMLInputElement).disabled).toBe(false);
  });

  it('resend re-sends to the address already on screen and a NEW challenge clears the latch', async () => {
    const sends: Array<Record<string, unknown>> = [];
    let challengeSeq = 0;
    apiPostMock.mockImplementation(async (path: string, body?: Record<string, unknown>) => {
      if (path === '/v1/auth/magic-link') {
        sends.push(body ?? {});
        challengeSeq += 1;
        return { ok: true, challenge_id: `ch_${challengeSeq}` };
      }
      if (path === '/v1/auth/code') {
        if (challengeSeq === 1) throw new ApiError('x', 401, { code: 'auth_code_used' });
        return { ok: true, email: 'a@x.com' };
      }
      return { ok: true };
    });
    renderScreen();
    await submitEmail();
    fireEvent.change(screen.getByTestId('signin-code'), { target: { value: '111111' } });
    fireEvent.click(screen.getByTestId('signin-code-confirm'));
    await screen.findByText(CODE_ALREADY_USED);

    fireEvent.click(await screen.findByTestId('signin-code-resend'));

    // No address re-entry: the resend reuses the address already on screen.
    await waitFor(() => expect(sends.length).toBe(2));
    expect(sends[1].email).toBe('a@x.com');
    // The fresh challenge re-opens entry and clears the terminal copy.
    await waitFor(() => expect((screen.getByTestId('signin-code') as HTMLInputElement).disabled).toBe(false));
    expect(screen.queryByText(CODE_ALREADY_USED)).toBeNull();
  });
});
