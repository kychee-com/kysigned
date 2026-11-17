/**
 * CreateEnvelopePage.domainWarnings.test.tsx — F-3.9 (#113, DD-87, AC-311): the
 * editor's per-signer heads-up about an address's DOMAIN, signed in and as a
 * guest. Asked on blur (only the domain, never for a malformed or plus-alias
 * address), when the self-sign row is switched on, and for every signer of a
 * restored draft; a stale or failed answer shows nothing; Send is never held.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { apiPostMock, apiGetMock, apiPatchMock, apiGetPublicMock, navigateMock, authHolder, searchHolder } = vi.hoisted(() => ({
  apiGetPublicMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiGetMock: vi.fn(),
  apiPatchMock: vi.fn(),
  navigateMock: vi.fn(),
  authHolder: {
    current: { user: null as null | { email: string; display_name?: string }, loading: false, refresh: vi.fn(), signOut: vi.fn() },
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
  return { ...actual, apiPost: apiPostMock, apiGet: apiGetMock, apiPatch: apiPatchMock, apiGetPublic: apiGetPublicMock };
});

import { CreateEnvelopePage } from './CreateEnvelopePage';

const HANDLE = 'ps_3f2a9c14-8b7e-4d1a-9f60-5c2e7a1b8d34.the-secret-half-abcdef';
const PDF_FILE = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'contract.pdf', { type: 'application/pdf' });

const RESTORED = {
  email: 'creator@example.com',
  document_name: 'contract',
  byte_count: 4096,
  signers: [
    { email: 'alice@mailinator.com', name: 'Alice Doe' },
    { email: 'bob@small.test', name: 'Bob Roe' },
  ],
  auto_close: true,
  claimed: false,
  expires_at: '2026-08-01T10:00:00.000Z',
};

/** The fake service: per domain, the warnings it reports. */
const DOMAIN_FACTS: Record<string, string[]> = {
  'mailinator.com': ['disposable'],
  'gmial.com': ['cannot_receive'],
  'small.test': ['no_sender_protection'],
  'example.com': [],
  'gmail.com': [],
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <CreateEnvelopePage />
    </MemoryRouter>,
  );

const nameField = (i = 0) => screen.getAllByPlaceholderText('e.g., Jane Smith')[i]! as HTMLInputElement;
const emailField = (i = 0) => screen.getAllByPlaceholderText('jane.smith@example.com')[i]! as HTMLInputElement;
const sendButton = () => screen.getByRole('button', { name: /send for signing/i });
const domainsAsked = () => apiGetPublicMock.mock.calls.map(([p]) => String(p));

function typeSigner(i: number, name: string, email: string, blur = true) {
  fireEvent.change(nameField(i), { target: { value: name } });
  fireEvent.change(emailField(i), { target: { value: email } });
  if (blur) fireEvent.blur(emailField(i));
}

beforeEach(() => {
  apiPostMock.mockReset();
  apiGetMock.mockReset();
  apiPatchMock.mockReset();
  apiGetPublicMock.mockReset();
  navigateMock.mockReset();
  searchHolder.current = '';
  authHolder.current = { user: null, loading: false, refresh: vi.fn(), signOut: vi.fn() };
  apiGetMock.mockImplementation(async (path: string) => {
    if (path === '/v1/credits/balance') return { balance_usd_micros: 5_000_000 };
    return RESTORED;
  });
  apiGetPublicMock.mockImplementation(async (path: string) => {
    const domain = decodeURIComponent(String(path).split('domain=')[1] ?? '');
    return { warnings: DOMAIN_FACTS[domain] ?? [] };
  });
  apiPatchMock.mockResolvedValue({ ok: true });
  apiPostMock.mockImplementation(async (path: string) => {
    if (path === '/v1/envelope/preflight') return { ok: true };
    if (path === '/v1/pending-send') return { draft_id: HANDLE };
    if (path === '/v1/envelope') return { envelope_id: 'env_direct' };
    throw new Error(`unexpected apiPost ${path}`);
  });
});

describe('F-3.9 — the warning under the signer, on blur (AC-311)', () => {
  for (const who of ['signed in', 'a guest'] as const) {
    it(`${who}: each warning names the domain or the signer, under that signer only`, async () => {
      if (who === 'signed in') authHolder.current = { ...authHolder.current, user: { email: 'creator@example.com' } };
      renderPage();
      typeSigner(0, 'Jane Smith', 'jane@gmial.com');
      expect(await screen.findByText('gmial.com can’t receive email. Check the spelling of this address.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /add signer/i }));
      typeSigner(1, 'Tom Lee', 'tom@mailinator.com');
      expect(
        await screen.findByText('This looks like a temporary email address. It may stop working before Tom Lee signs.'),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /add signer/i }));
      typeSigner(2, 'Ann Ray', 'ann@small.test');
      expect(
        await screen.findByText(
          'small.test doesn’t publish email security settings. If Ann Ray’s signature is refused, they may need their email administrator’s help.',
        ),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /add signer/i }));
      typeSigner(3, 'Gus Fine', 'gus@gmail.com');
      await waitFor(() => expect(domainsAsked()).toContain('/v1/signer-domain-check?domain=gmail.com'));
      expect(screen.getAllByTestId('signer-domain-warning')).toHaveLength(3); // gmail.com shows none
      // Only domains were ever sent, never a local part.
      for (const p of domainsAsked()) expect(p).not.toMatch(/jane|tom|ann|gus|@/);
      // Send is never held back by a warning.
      expect(sendButton()).not.toBeDisabled();
    });
  }

  it('Send proceeds with a disposable or no-sender-protection signer', async () => {
    authHolder.current = { ...authHolder.current, user: { email: 'creator@example.com' } };
    const { container } = renderPage();
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [PDF_FILE()] } });
    typeSigner(0, 'Tom Lee', 'tom@mailinator.com');
    await screen.findByTestId('signer-domain-warning');
    fireEvent.click(sendButton());
    await waitFor(() => expect(apiPostMock.mock.calls.some(([p]) => p === '/v1/envelope')).toBe(true));
  });

  it('a malformed or plus-alias address is never checked', async () => {
    renderPage();
    typeSigner(0, 'Jane', 'jane@');
    typeSigner(0, 'Jane', 'jane+tag@mailinator.com');
    await act(async () => {});
    expect(apiGetPublicMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('signer-domain-warning')).toBeNull();
  });

  it('an answer for a value the field no longer holds is discarded', async () => {
    let release: (v: unknown) => void = () => {};
    apiGetPublicMock.mockReturnValueOnce(new Promise((res) => { release = res; }));
    renderPage();
    typeSigner(0, 'Jane', 'jane@gmial.com');
    fireEvent.change(emailField(0), { target: { value: 'jane@gmail.com' } });
    await act(async () => release({ warnings: ['cannot_receive'] }));
    expect(screen.queryByTestId('signer-domain-warning')).toBeNull();
  });

  it('a failed call shows nothing', async () => {
    apiGetPublicMock.mockRejectedValue(new Error('offline'));
    renderPage();
    typeSigner(0, 'Jane', 'jane@gmial.com');
    await waitFor(() => expect(apiGetPublicMock).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('signer-domain-warning')).toBeNull();
    expect(sendButton()).not.toBeDisabled();
  });
});

describe('F-3.9 — the self-sign row and a restored draft are checked too (AC-311)', () => {
  it('switching the self-sign row on checks the creator’s own address', async () => {
    authHolder.current = { ...authHolder.current, user: { email: 'me@small.test', display_name: 'Me Myself' } };
    renderPage();
    fireEvent.click(screen.getByLabelText(/will you also sign/i));
    expect(
      await screen.findByText(
        'small.test doesn’t publish email security settings. If Me Myself’s signature is refused, they may need their email administrator’s help.',
      ),
    ).toBeInTheDocument();
    expect(domainsAsked()).toEqual(['/v1/signer-domain-check?domain=small.test']);
  });

  it('every signer of a restored draft is checked on load', async () => {
    searchHolder.current = `?draft=${HANDLE}&signin_failed=1`;
    renderPage();
    await screen.findByTestId('restored-draft-file');
    expect(
      await screen.findByText('This looks like a temporary email address. It may stop working before Alice Doe signs.'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        'small.test doesn’t publish email security settings. If Bob Roe’s signature is refused, they may need their email administrator’s help.',
      ),
    ).toBeInTheDocument();
  });
});
