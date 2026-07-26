/**
 * CreateEnvelopePage.google.test.tsx — F-41.6 (AC-251/AC-252), the editor's
 * side of the Google gate crossing:
 *
 *   the gate stores the draft CEREMONY-bound (no address) before the ceremony,
 *   Back-from-Google re-enters through the standard restore (the stash),
 *   a Google failure reason renders its specific plain-words guidance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { apiPostMock, apiGetMock, apiPatchMock, navigateMock, authHolder, searchHolder } = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  apiGetMock: vi.fn(),
  apiPatchMock: vi.fn(),
  navigateMock: vi.fn(),
  authHolder: {
    current: { user: null as null | { email: string }, loading: false, refresh: vi.fn(), signOut: vi.fn() },
  },
  searchHolder: { current: '' },
}));

vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useLocation: () => ({ pathname: '/dashboard/create', search: searchHolder.current, hash: '', state: null, key: 'k' }),
  };
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
  return { ...actual, apiPost: apiPostMock, apiGet: apiGetMock, apiPatch: apiPatchMock };
});

vi.mock('../lib/hardNavigate', () => ({ hardNavigate: vi.fn() }));

import { CreateEnvelopePage } from './CreateEnvelopePage';
import { GOOGLE_DRAFT_STASH_KEY } from '../auth/google';
import { GOOGLE_ACCOUNT_EXISTS } from '../lib/friendlyError';

const HANDLE = 'ps_3f2a9c14-8b7e-4d1a-9f60-5c2e7a1b8d34.the-secret-half-abcdef';
const PDF_FILE = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'contract.pdf', { type: 'application/pdf' });

const RESTORED = {
  email: '',
  document_name: 'contract',
  byte_count: 4096,
  signers: [{ email: 'alice@example.com', name: 'Alice Doe' }],
  auto_close: true,
  claimed: false,
  expires_at: '2026-08-01T10:00:00.000Z',
};

function renderPage() {
  return render(
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

beforeEach(() => {
  apiPostMock.mockReset();
  apiGetMock.mockReset();
  apiPatchMock.mockReset();
  navigateMock.mockReset();
  searchHolder.current = '';
  sessionStorage.clear();
  authHolder.current = { user: null, loading: false, refresh: vi.fn(), signOut: vi.fn() };
  apiGetMock.mockImplementation(async (path: string) => {
    if (path === '/v1/auth/methods') return { google: true };
    return RESTORED;
  });
  apiPatchMock.mockResolvedValue({ ok: true });
  apiPostMock.mockImplementation(async (path: string) => {
    if (path === '/v1/envelope/preflight') return { ok: true };
    if (path === '/v1/pending-send') return { draft_id: HANDLE };
    if (path === '/v1/auth/google/start') return { authorization_url: 'https://accounts.google.com/x' };
    throw new Error(`unexpected apiPost ${path}`);
  });
});

describe('the gate stores the draft CEREMONY-bound for the Google path (AC-251)', () => {
  it('clicking Continue with Google at the gate stores {ceremony:true, …draft} with NO email, then rides the handle', async () => {
    const { container } = renderPage();
    fillDraft(container);
    fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));
    await screen.findByTestId('signin-screen');

    fireEvent.click(await screen.findByTestId('signin-google'));
    await waitFor(() => {
      const start = apiPostMock.mock.calls.find(([p]) => p === '/v1/auth/google/start');
      expect(start).toBeTruthy();
    });
    const stored = apiPostMock.mock.calls.find(([p]) => p === '/v1/pending-send')!;
    const body = stored[1] as Record<string, unknown>;
    expect(body.ceremony).toBe(true);
    expect('email' in body).toBe(false);
    const start = apiPostMock.mock.calls.find(([p]) => p === '/v1/auth/google/start')!;
    expect((start[1] as Record<string, unknown>).draft_id).toBe(HANDLE);
    expect(sessionStorage.getItem(GOOGLE_DRAFT_STASH_KEY)).toBe(HANDLE);
  });
});

describe('Back-from-Google returns the FILLED-IN document (AC-252)', () => {
  // Barry's walk-3 human pass, 2026-07-26: pressing browser Back at Google's
  // screen landed on an EMPTY editor. Root cause: `handover` is read ONCE at
  // mount, so re-entering via a router navigate() to `?draft=…` changed the URL
  // without remounting — the restore effect keyed on handover.draftId never
  // fired. The first version of this test asserted only that navigate() was
  // CALLED, which is why it passed while the feature was broken: it verified the
  // mechanism, never the outcome. These tests assert the OUTCOME — the visitor's
  // document is actually on screen.
  it('a mount with a stashed handle and no ?draft restores the document IN PLACE', async () => {
    sessionStorage.setItem(GOOGLE_DRAFT_STASH_KEY, HANDLE);
    renderPage();
    // The document identity and its signer are back on screen — the whole point.
    expect(await screen.findByDisplayValue('contract')).toBeTruthy();
    expect(await screen.findByDisplayValue('alice@example.com')).toBeTruthy();
    // Fetched through the standard restore door, by the stashed handle.
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith(`/v1/pending-send/${HANDLE}`));
  });

  it('explains why the document is back, in plain words naming no code or vendor', async () => {
    sessionStorage.setItem(GOOGLE_DRAFT_STASH_KEY, HANDLE);
    renderPage();
    const notice = await screen.findByTestId('restore-notice');
    expect(notice.textContent).toMatch(/document is (still )?(saved|here)/i);
    expect(notice.textContent).not.toMatch(/google|run402|http|\b[45]\d\d\b/i);
  });

  it('is single-use: the stash is cleared once consumed', async () => {
    sessionStorage.setItem(GOOGLE_DRAFT_STASH_KEY, HANDLE);
    renderPage();
    await screen.findByDisplayValue('contract');
    expect(sessionStorage.getItem(GOOGLE_DRAFT_STASH_KEY)).toBeNull();
  });

  it('a mount that already has ?draft restores from the URL and leaves no stash behind', async () => {
    sessionStorage.setItem(GOOGLE_DRAFT_STASH_KEY, HANDLE);
    searchHolder.current = `?draft=${HANDLE}`;
    renderPage();
    expect(await screen.findByDisplayValue('contract')).toBeTruthy();
    expect(navigateMock).not.toHaveBeenCalledWith(expect.stringContaining('draft='), expect.anything());
  });
});

describe('a Google failure reason renders its specific guidance (AC-247 copy)', () => {
  it('signin_failed with reason=account_exists_requires_link shows the linking copy on the restored form', async () => {
    searchHolder.current = `?draft=${HANDLE}&signin_failed=1&reason=account_exists_requires_link`;
    renderPage();
    await waitFor(() => expect(screen.getByTestId('restore-notice').textContent).toContain(GOOGLE_ACCOUNT_EXISTS));
  });
});

describe('a RESTORED draft at the gate: nothing is unsaved, so nothing may warn (Barry walk 3)', () => {
  // The exact sequence Barry reported: document restored after abandoning the
  // ceremony → "Send me a fresh link" → the gate → and then BOTH browser Back
  // AND Continue with Google raised "Leave site? Changes that you made may not
  // be saved." His draft was committed to the service and his edits were
  // written before the gate opened, so the warning was false in both cases.
  //
  // This path skips `prepareCeremonyDraft` entirely (the gate already carries a
  // draftId), which is why the earlier deliberate-navigation fix did not cover
  // it — the page was never told the departure was ours.
  let confirmSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    confirmSpy = vi.spyOn(window, 'confirm');
  });
  afterEach(() => confirmSpy.mockRestore());

  async function restoredThenGate() {
    searchHolder.current = `?draft=${HANDLE}&signin_failed=1`;
    renderPage();
    await screen.findByDisplayValue('alice@example.com');
    fireEvent.click(await screen.findByTestId('restore-resend'));
    await screen.findByTestId('signin-screen');
  }

  it('browser Back from that gate does not warn', async () => {
    await restoredThenGate();
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('Continue with Google from that gate does not warn, and still starts the ceremony', async () => {
    await restoredThenGate();
    fireEvent.click(await screen.findByTestId('signin-google'));
    await waitFor(() =>
      expect(apiPostMock.mock.calls.some(([p]) => p === '/v1/auth/google/start')).toBe(true),
    );
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
    // The restored draft's own handle rides the ceremony — no second draft written.
    const start = apiPostMock.mock.calls.find(([p]) => p === '/v1/auth/google/start')!;
    expect((start[1] as Record<string, unknown>).draft_id).toBe(HANDLE);
    expect(apiPostMock.mock.calls.filter(([p]) => p === '/v1/pending-send')).toHaveLength(0);
  });
});
