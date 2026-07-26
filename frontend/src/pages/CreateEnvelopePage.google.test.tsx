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

describe('Back-from-Google re-enters the restore (AC-252)', () => {
  it('a mount with a stashed handle and no ?draft navigates to the standard restore, single-use', async () => {
    sessionStorage.setItem(GOOGLE_DRAFT_STASH_KEY, HANDLE);
    renderPage();
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(`/dashboard/create?draft=${encodeURIComponent(HANDLE)}`, { replace: true }),
    );
    expect(sessionStorage.getItem(GOOGLE_DRAFT_STASH_KEY)).toBeNull();
  });

  it('a mount that already has ?draft leaves the stash alone (the landing owns it)', async () => {
    sessionStorage.setItem(GOOGLE_DRAFT_STASH_KEY, HANDLE);
    searchHolder.current = `?draft=${HANDLE}`;
    renderPage();
    await screen.findByText(/contract/);
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
