/**
 * CreateEnvelopePage.messageExpiry.test.tsx — F-3.8 (#163, AC-305, AC-306): the
 * editor offers the envelope-wide message to signers and the expiry presets, and
 * both travel wherever the draft goes — the signed-in create, the guest pending
 * send, the restored draft and its edit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

import { CreateEnvelopePage } from './CreateEnvelopePage';

const HANDLE = 'ps_3f2a9c14-8b7e-4d1a-9f60-5c2e7a1b8d34.the-secret-half-abcdef';
const PDF_FILE = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'contract.pdf', { type: 'application/pdf' });

const RESTORED = {
  email: 'creator@example.com',
  document_name: 'contract',
  byte_count: 4096,
  signers: [{ email: 'alice@example.com', name: 'Alice Doe' }],
  auto_close: true,
  claimed: false,
  expires_at: '2026-08-01T10:00:00.000Z',
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <CreateEnvelopePage />
    </MemoryRouter>,
  );

function fillDraft(container: HTMLElement) {
  fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [PDF_FILE()] } });
  fireEvent.change(screen.getAllByPlaceholderText('e.g., Jane Smith')[0]!, { target: { value: 'Alice Doe' } });
  fireEvent.change(screen.getAllByPlaceholderText('jane.smith@example.com')[0]!, { target: { value: 'alice@example.com' } });
}

const messageBox = () => screen.getByLabelText(/message to signers/i) as HTMLTextAreaElement;
const expiryChoice = () => screen.getByLabelText(/signers have/i) as HTMLSelectElement;
const send = () => fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));
const callsTo = (path: string) => apiPostMock.mock.calls.filter(([p]) => p === path);

beforeEach(() => {
  apiPostMock.mockReset();
  apiGetMock.mockReset();
  apiPatchMock.mockReset();
  navigateMock.mockReset();
  searchHolder.current = '';
  authHolder.current = { user: null, loading: false, refresh: vi.fn(), signOut: vi.fn() };
  apiGetMock.mockImplementation(async (path: string) => {
    if (path === '/v1/credits/balance') return { balance_usd_micros: 5_000_000 };
    return RESTORED;
  });
  apiPatchMock.mockResolvedValue({ ok: true });
  apiPostMock.mockImplementation(async (path: string) => {
    if (path === '/v1/envelope/preflight') return { ok: true };
    if (path === '/v1/pending-send') return { draft_id: HANDLE };
    if (path === '/v1/auth/magic-link') return { ok: true };
    if (path === `/v1/pending-send/${HANDLE}/claim`) return { envelope_id: 'env_claimed' };
    if (path === '/v1/envelope') return { envelope_id: 'env_direct' };
    throw new Error(`unexpected apiPost ${path}`);
  });
});

describe('the two controls (AC-305)', () => {
  for (const who of ['signed in', 'a guest'] as const) {
    it(`${who}: an optional message box, and exactly 7/14/30/60/90 days with 30 selected`, async () => {
      if (who === 'signed in') authHolder.current = { ...authHolder.current, user: { email: 'creator@example.com' } };
      renderPage();
      expect(messageBox().tagName).toBe('TEXTAREA');
      expect(messageBox().value).toBe('');
      expect(messageBox().required).toBe(false);
      const options = within(expiryChoice()).getAllByRole('option') as HTMLOptionElement[];
      expect(options.map((o) => o.value)).toEqual(['7', '14', '30', '60', '90']);
      expect(options.map((o) => o.textContent)).toEqual(['7 days', '14 days', '30 days', '60 days', '90 days']);
      expect(expiryChoice().value).toBe('30');
    });
  }
});

describe('the signed-in create carries them (AC-305)', () => {
  beforeEach(() => {
    authHolder.current = { ...authHolder.current, user: { email: 'creator@example.com' } };
  });

  it('posts the typed message and the chosen expiry_days to POST /v1/envelope', async () => {
    const { container } = renderPage();
    fillDraft(container);
    fireEvent.change(messageBox(), { target: { value: '  Please sign by Friday.  ' } });
    fireEvent.change(expiryChoice(), { target: { value: '14' } });
    send();
    await waitFor(() => expect(callsTo('/v1/envelope')).toHaveLength(1));
    const body = callsTo('/v1/envelope')[0]![1] as Record<string, unknown>;
    expect(body.message).toBe('Please sign by Friday.');
    expect(body.expiry_days).toBe(14);
  });

  it('an empty or whitespace message is OMITTED; the default expiry still goes as 30', async () => {
    const { container } = renderPage();
    fillDraft(container);
    fireEvent.change(messageBox(), { target: { value: '   ' } });
    send();
    await waitFor(() => expect(callsTo('/v1/envelope')).toHaveLength(1));
    const body = callsTo('/v1/envelope')[0]![1] as Record<string, unknown>;
    expect('message' in body).toBe(false);
    expect(body.expiry_days).toBe(30);
  });
});

describe('the guest pending send carries them (AC-306)', () => {
  it('the stored draft has the message and the expiry', async () => {
    const { container } = renderPage();
    fillDraft(container);
    fireEvent.change(messageBox(), { target: { value: 'Hi Alice' } });
    fireEvent.change(expiryChoice(), { target: { value: '60' } });
    send();
    await screen.findByTestId('signin-screen');
    fireEvent.change(screen.getByTestId('signin-email'), { target: { value: 'creator@example.com' } });
    fireEvent.click(screen.getByTestId('signin-send-link'));
    await waitFor(() => expect(callsTo('/v1/pending-send')).toHaveLength(1));
    const stored = callsTo('/v1/pending-send')[0]![1] as Record<string, unknown>;
    expect(stored.message).toBe('Hi Alice');
    expect(stored.expiry_days).toBe(60);
    const preflight = callsTo('/v1/envelope/preflight')[0]![1] as Record<string, unknown>;
    expect(preflight.message).toBe('Hi Alice');
    expect(preflight.expiry_days).toBe(60);
  });
});

describe('a restored draft shows them, and its edit sends them (AC-306)', () => {
  beforeEach(() => {
    searchHolder.current = `?draft=${HANDLE}&signin_failed=1`;
  });

  it('shows the stored message and expiry filled in', async () => {
    apiGetMock.mockImplementation(async () => ({ ...RESTORED, message: 'Stored note', expiry_days: 14 }));
    renderPage();
    await screen.findByTestId('restored-draft-file');
    expect(messageBox().value).toBe('Stored note');
    expect(expiryChoice().value).toBe('14');
  });

  it('a draft without them shows an empty box and 30', async () => {
    renderPage();
    await screen.findByTestId('restored-draft-file');
    expect(messageBox().value).toBe('');
    expect(expiryChoice().value).toBe('30');
  });

  it('the edited values are what the PATCH saves; clearing the box sends an empty message', async () => {
    apiGetMock.mockImplementation(async () => ({ ...RESTORED, message: 'Stored note', expiry_days: 14 }));
    renderPage();
    await screen.findByTestId('restored-draft-file');
    fireEvent.change(messageBox(), { target: { value: '' } });
    fireEvent.change(expiryChoice(), { target: { value: '90' } });
    fireEvent.click(screen.getByTestId('restore-resend'));
    await waitFor(() => expect(apiPatchMock).toHaveBeenCalledWith(`/v1/pending-send/${HANDLE}`, expect.anything()));
    const patch = apiPatchMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.message).toBe('');
    expect(patch.expiry_days).toBe(90);
  });

  it('an unchanged restored draft is committed-and-clean; a changed message makes it unsaved', async () => {
    apiGetMock.mockImplementation(async () => ({ ...RESTORED, message: 'Stored note', expiry_days: 14 }));
    renderPage();
    await screen.findByTestId('restored-draft-file');
    const beforeUnload = () => {
      const ev = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(beforeUnload()).toBe(false);
    fireEvent.change(messageBox(), { target: { value: 'Different note' } });
    await waitFor(() => expect(beforeUnload()).toBe(true));
  });
});
