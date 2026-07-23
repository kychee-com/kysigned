/**
 * CreateEnvelopePage.gate.test.tsx — F-39.3 (AC-225): the sign-in gate at
 * Send. A guest's valid draft is preflighted (free, public) BEFORE any gate;
 * the gate renders in-flow (no navigation, draft state intact); the held
 * create POST fires EXACTLY ONCE when a session appears in this browser;
 * abandoning the gate makes zero create calls and keeps the draft; a
 * signed-in creator's Send is untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { apiPostMock, apiGetMock, navigateMock, authHolder } = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  apiGetMock: vi.fn(),
  navigateMock: vi.fn(),
  authHolder: { current: { user: null as null | { email: string; display_name?: string }, loading: false, refresh: vi.fn(), signOut: vi.fn() } },
}));

vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

// One mutable auth holder serves BOTH the page and the embedded SignInScreen.
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

/** Fill a complete valid draft: file + auto-named doc + one signer with an org. */
function fillDraft(container: HTMLElement) {
  fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [PDF_FILE()] } });
  fireEvent.change(screen.getAllByPlaceholderText('e.g., Jane Smith')[0]!, { target: { value: 'Alice Doe' } });
  fireEvent.change(screen.getAllByPlaceholderText('jane.smith@example.com')[0]!, { target: { value: 'alice@example.com' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /on behalf of an organisation/i }));
  fireEvent.change(screen.getByPlaceholderText('e.g., Acme Corp'), { target: { value: 'Acme Holdings' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /send the signing record automatically/i })); // auto_close → false
}

const send = () => fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));
const createCalls = () => apiPostMock.mock.calls.filter(([path]) => path === '/v1/envelope');
const preflightCalls = () => apiPostMock.mock.calls.filter(([path]) => path === '/v1/envelope/preflight');

describe('CreateEnvelopePage — the gate at Send (F-39.3 / AC-225)', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiGetMock.mockReset();
    navigateMock.mockReset();
    authHolder.current = { user: null, loading: false, refresh: vi.fn(), signOut: vi.fn() };
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === '/v1/envelope/preflight') return { ok: true };
      if (path === '/v1/envelope') return { envelope_id: 'env_gated_1' };
      if (path === '/v1/auth/magic-link') return { ok: true };
      throw new Error(`unexpected apiPost ${path}`);
    });
  });

  it('a guest Send preflights first, then opens the gate — and the server holds NO envelope', async () => {
    const { container } = renderPage();
    fillDraft(container);
    send();
    await waitFor(() => expect(preflightCalls()).toHaveLength(1));
    expect(await screen.findByTestId('signin-screen')).toBeTruthy();
    expect(createCalls()).toHaveLength(0);
    // The preflight body is the draft itself (same validation surface as create).
    const body = preflightCalls()[0]![1] as { document_name: string; signers: unknown[] };
    expect(body.document_name).toBe('contract');
    expect(body.signers).toHaveLength(1);
  });

  it('an invalid draft surfaces its error with NO gate and NO server call', async () => {
    renderPage();
    send(); // nothing filled
    expect(await screen.findByText(/please upload a pdf/i)).toBeTruthy();
    expect(screen.queryByTestId('signin-screen')).toBeNull();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('a preflight rejection (e.g. a plus-alias signer) shows the error and never opens the gate', async () => {
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === '/v1/envelope/preflight') {
        throw new ApiError('Signer addresses must be primary addresses (no plus-aliases)', 400);
      }
      throw new Error(`unexpected apiPost ${path}`);
    });
    const { container } = renderPage();
    fillDraft(container);
    send();
    expect(await screen.findByText(/plus-aliases/i)).toBeTruthy();
    expect(screen.queryByTestId('signin-screen')).toBeNull();
    expect(createCalls()).toHaveLength(0);
  });

  it('when a session appears in this browser the held envelope sends EXACTLY once, field-for-field', async () => {
    const { container, rerender } = renderPage();
    fillDraft(container);
    send();
    await screen.findByTestId('signin-screen');

    authHolder.current = { ...authHolder.current, user: { email: 'fresh@example.com' } };
    rerenderPage(rerender);
    await waitFor(() => expect(createCalls()).toHaveLength(1));

    const body = createCalls()[0]![1] as Record<string, unknown>;
    expect(body.document_name).toBe('contract');
    expect(body.auto_close).toBe(false);
    expect(body.signers).toEqual([{ email: 'alice@example.com', name: 'Alice Doe', on_behalf_of: 'Acme Holdings' }]);
    expect(typeof body.pdf_base64).toBe('string');
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith('/dashboard/envelope/env_gated_1', expect.objectContaining({ state: expect.objectContaining({ justSent: true }) })),
    );

    // A later render pass with a fresh user identity must NOT double-send.
    authHolder.current = { ...authHolder.current, user: { email: 'fresh@example.com' } };
    rerenderPage(rerender);
    expect(createCalls()).toHaveLength(1);
  });

  it('abandoning the gate keeps the draft in the tab and makes zero create calls', async () => {
    const { container, rerender } = renderPage();
    fillDraft(container);
    send();
    await screen.findByTestId('signin-screen');

    fireEvent.click(screen.getByTestId('gate-back'));
    rerenderPage(rerender);
    expect(screen.queryByTestId('signin-screen')).toBeNull();
    // Draft intact: the doc name derived from the file is still there.
    expect((screen.getByPlaceholderText('e.g., NDA for Acme Corp') as HTMLInputElement).value).toBe('contract');
    expect(createCalls()).toHaveLength(0);
  });

  it('a signed-in creator Sends immediately — no gate, no preflight detour', async () => {
    authHolder.current = { ...authHolder.current, user: { email: 'creator@example.com', display_name: 'Jordan' } };
    apiGetMock.mockResolvedValue({ balance_usd_micros: '1000000', envelope_cost_usd_micros: '250000', sufficient_for_envelope: true });
    const { container } = renderPage();
    fillDraft(container);
    send();
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(preflightCalls()).toHaveLength(0);
    expect(screen.queryByTestId('signin-screen')).toBeNull();
  });
});
