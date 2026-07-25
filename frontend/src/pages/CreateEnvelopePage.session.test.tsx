/**
 * CreateEnvelopePage.session.test.tsx — the two session-state dead ends found
 * reviewing the send gate (2026-07-25).
 *
 * BUG 1 — `loading` is not `guest`. AuthContext starts `loading=true` with
 * `user=null`, and `/dashboard/create` is the ONE route without a RequireAuth
 * wrap (F-39.1), so nothing else covers the hydration window. Reading `user`
 * alone made a signed-in creator render as a guest (guest trial line, no
 * self-sign row) and, on Send, take the GUEST branch: a wasted preflight and
 * the "Sign in to send your document" gate shown to someone already signed in.
 *
 * BUG 2 — a 401 at Send was a wall. The session can die between page load and
 * Send; `friendlyCreateError` only rewrites 5xx/opaque, so the raw server
 * string "Authentication required" landed as a red banner on a filled form
 * with no way to sign in from there. A 401 is not an error to read, it is a
 * sign-in to do: it must route into the SAME gate, which keeps the draft and
 * re-fires the send by itself once a session appears.
 *
 * The two fixes compose: because a wrong optimistic guess during hydration
 * lands on the 401 route, the submit path never has to block on the settle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { apiPostMock, apiGetMock, navigateMock, authHolder } = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  apiGetMock: vi.fn(),
  navigateMock: vi.fn(),
  authHolder: {
    current: {
      user: null as null | { email: string; display_name?: string },
      loading: false,
      refresh: vi.fn(),
      signOut: vi.fn(),
    },
  },
}));

vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../auth/auth-core', () => ({
  useAuth: () => authHolder.current,
  broadcastAuthEvent: vi.fn(),
}));

vi.mock('../auth/passkey', () => ({
  passkeysSupported: () => false,
  conditionalMediationAvailable: async () => false,
  startConditionalPasskeyLogin: async () => ({ ok: false }),
  signInWithPasskey: async () => ({ ok: false }),
}));

vi.mock('../lib/api', async (importActual) => {
  const actual = await importActual<typeof import('../lib/api')>();
  return { ...actual, apiPost: apiPostMock, apiGet: apiGetMock };
});

import { ApiError } from '../lib/api';
import { SESSION_EXPIRED } from '../lib/friendlyError';
import { CreateEnvelopePage } from './CreateEnvelopePage';

const PDF_FILE = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'contract.pdf', { type: 'application/pdf' });

function renderPage() {
  return render(
    <MemoryRouter>
      <CreateEnvelopePage />
    </MemoryRouter>,
  );
}

function rerenderPage(rerender: (ui: React.ReactElement) => void) {
  rerender(
    <MemoryRouter>
      <CreateEnvelopePage />
    </MemoryRouter>,
  );
}

function fillDraft(container: HTMLElement) {
  fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [PDF_FILE()] } });
  fireEvent.change(screen.getAllByPlaceholderText('e.g., Jane Smith')[0]!, { target: { value: 'Alice Doe' } });
  fireEvent.change(screen.getAllByPlaceholderText('jane.smith@example.com')[0]!, { target: { value: 'alice@example.com' } });
}

const send = () => fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));
const createCalls = () => apiPostMock.mock.calls.filter(([path]) => path === '/v1/envelope');
const preflightCalls = () => apiPostMock.mock.calls.filter(([path]) => path === '/v1/envelope/preflight');
const docNameValue = () => (screen.getByPlaceholderText('e.g., NDA for Acme Corp') as HTMLInputElement).value;

describe('CreateEnvelopePage — auth hydration is not guest (bug 1)', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiGetMock.mockReset();
    navigateMock.mockReset();
    authHolder.current = { user: null, loading: true, refresh: vi.fn(), signOut: vi.fn() };
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === '/v1/envelope/preflight') return { ok: true };
      if (path === '/v1/envelope') return { envelope_id: 'env_1' };
      if (path === '/v1/auth/magic-link') return { ok: true };
      throw new Error(`unexpected apiPost ${path}`);
    });
  });

  it('claims no identity while auth is still hydrating: no guest trial line', () => {
    renderPage();
    expect(screen.queryByTestId('guest-trial-line')).toBeNull();
  });

  it('does not read the credit balance during the hydration window', () => {
    renderPage();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it('a signed-in creator whose auth settles mid-visit never sees the guest gate', async () => {
    const { container, rerender } = renderPage();
    authHolder.current = { ...authHolder.current, user: { email: 'creator@example.com' }, loading: false };
    rerenderPage(rerender);
    fillDraft(container);
    send();
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(preflightCalls()).toHaveLength(0);
    expect(screen.queryByTestId('signin-screen')).toBeNull();
  });

  it('Send during hydration takes the signed-in path, and a wrong guess lands on the gate with the draft intact', async () => {
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === '/v1/envelope') throw new ApiError('Authentication required', 401, { code: 'auth_session_required' });
      if (path === '/v1/auth/magic-link') return { ok: true };
      throw new Error(`unexpected apiPost ${path}`);
    });
    const { container } = renderPage();
    fillDraft(container);
    send();
    // Optimistic: no preflight detour, straight at the create.
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(preflightCalls()).toHaveLength(0);
    // Wrong guess recovers into the gate, not a raw error banner.
    expect(await screen.findByTestId('signin-screen')).toBeTruthy();
    expect(screen.queryByText(/authentication required/i)).toBeNull();
    // The gate merely unmounts the form; stepping back proves the draft is held.
    fireEvent.click(screen.getByTestId('gate-back'));
    expect(docNameValue()).toBe('contract');
  });

  it('once auth settles to a real guest, the guest flow is unchanged', async () => {
    const { container, rerender } = renderPage();
    authHolder.current = { ...authHolder.current, loading: false };
    rerenderPage(rerender);
    expect(screen.getByTestId('guest-trial-line')).toBeTruthy();
    fillDraft(container);
    send();
    await waitFor(() => expect(preflightCalls()).toHaveLength(1));
    expect(await screen.findByTestId('signin-screen')).toBeTruthy();
    expect(createCalls()).toHaveLength(0);
  });
});

describe('CreateEnvelopePage — a 401 at Send is a sign-in, not a wall (bug 2)', () => {
  let refreshSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    apiPostMock.mockReset();
    apiGetMock.mockReset();
    navigateMock.mockReset();
    apiGetMock.mockResolvedValue({ balance_usd_micros: '1000000', envelope_cost_usd_micros: '250000', sufficient_for_envelope: true });
    // A signed-in creator whose server-side session has already died. refresh()
    // is what corrects the SPA's stale belief, exactly as AuthContext does.
    refreshSpy = vi.fn(async () => {
      authHolder.current = { ...authHolder.current, user: null };
    });
    authHolder.current = {
      user: { email: 'creator@example.com' },
      loading: false,
      refresh: refreshSpy,
      signOut: vi.fn(),
    };
  });

  it('routes a dead session into the gate with a plain-words notice and the draft kept', async () => {
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === '/v1/envelope') throw new ApiError('Authentication required', 401, { code: 'auth_session_required' });
      if (path === '/v1/auth/magic-link') return { ok: true };
      throw new Error(`unexpected apiPost ${path}`);
    });
    const { container } = renderPage();
    fillDraft(container);
    send();
    expect(await screen.findByTestId('signin-screen')).toBeTruthy();
    expect(screen.getByTestId('gate-notice').textContent).toBe(SESSION_EXPIRED);
    // The raw server string never reaches the creator.
    expect(screen.queryByText(/authentication required/i)).toBeNull();
    // The SPA's stale belief was corrected rather than trusted.
    expect(refreshSpy).toHaveBeenCalled();
    // The gate merely unmounts the form; stepping back proves the draft is held.
    fireEvent.click(screen.getByTestId('gate-back'));
    expect(docNameValue()).toBe('contract');
    expect(screen.queryByTestId('gate-notice')).toBeNull();
  });

  it('after signing in again the held send fires EXACTLY once with the same draft', async () => {
    let createCount = 0;
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === '/v1/envelope') {
        createCount += 1;
        if (createCount === 1) throw new ApiError('Authentication required', 401, { code: 'auth_session_required' });
        return { envelope_id: 'env_recovered' };
      }
      if (path === '/v1/auth/magic-link') return { ok: true };
      throw new Error(`unexpected apiPost ${path}`);
    });
    const { container, rerender } = renderPage();
    fillDraft(container);
    send();
    await screen.findByTestId('signin-screen');

    authHolder.current = { ...authHolder.current, user: { email: 'creator@example.com' } };
    rerenderPage(rerender);
    await waitFor(() => expect(createCalls()).toHaveLength(2));

    const body = createCalls()[1]![1] as Record<string, unknown>;
    expect(body.document_name).toBe('contract');
    expect(body.signers).toEqual([{ email: 'alice@example.com', name: 'Alice Doe', on_behalf_of: undefined }]);
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith('/dashboard/envelope/env_recovered', expect.objectContaining({ state: expect.objectContaining({ justSent: true }) })),
    );

    // A further render pass must not send a third time.
    rerenderPage(rerender);
    expect(createCalls()).toHaveLength(2);
  });

  it('never loops: a second consecutive 401 falls back to the form, not another gate', async () => {
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === '/v1/envelope') throw new ApiError('Authentication required', 401, { code: 'auth_session_required' });
      if (path === '/v1/auth/magic-link') return { ok: true };
      throw new Error(`unexpected apiPost ${path}`);
    });
    // The stale belief survives the refresh (session looks alive but isn't), so
    // SignInScreen fires onSignedIn immediately and the held send 401s again.
    refreshSpy = vi.fn(async () => {});
    authHolder.current = { ...authHolder.current, refresh: refreshSpy };
    const { container } = renderPage();
    fillDraft(container);
    send();
    await waitFor(() => expect(createCalls()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId('signin-screen')).toBeNull());
    expect(docNameValue()).toBe('contract');
    expect(createCalls()).toHaveLength(2);
  });

  it('a 402 (no credit) still returns to the FORM with its message, never the gate', async () => {
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === '/v1/envelope') throw new ApiError('Insufficient credit. Please top up to send.', 402);
      throw new Error(`unexpected apiPost ${path}`);
    });
    const { container } = renderPage();
    fillDraft(container);
    send();
    expect(await screen.findByText(/insufficient credit/i)).toBeTruthy();
    expect(screen.queryByTestId('signin-screen')).toBeNull();
    expect(docNameValue()).toBe('contract');
  });
});
