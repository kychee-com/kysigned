/**
 * CreateEnvelopePage.postgate.test.tsx — F-39.4 (AC-226): the gate changes
 * WHEN the account moment happens, not what follows it. A zero-credit account
 * completing the gate gets the standard insufficient-credit outcome with the
 * DRAFT INTACT (top-up opens in a NEW tab so this tab keeps the draft), and
 * the same draft sends after top-up. The classic empty-form credit gate
 * (Barry QA 2026-06-16) still replaces the form when nothing was drafted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { apiPostMock, apiGetMock, navigateMock, authHolder } = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  apiGetMock: vi.fn(),
  navigateMock: vi.fn(),
  authHolder: { current: { user: null as null | { email: string }, loading: false, refresh: vi.fn(), signOut: vi.fn() } },
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
import { CreateEnvelopePage } from './CreateEnvelopePage';

const PDF_FILE = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'contract.pdf', { type: 'application/pdf' });
const NO_BALANCE = { balance_usd_micros: '0', envelope_cost_usd_micros: '250000', sufficient_for_envelope: false };

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

describe('CreateEnvelopePage — post-gate outcomes (F-39.4 / AC-226)', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiGetMock.mockReset();
    navigateMock.mockReset();
    authHolder.current = { user: null, loading: false, refresh: vi.fn(), signOut: vi.fn() };
    vi.stubEnv('VITE_OPERATOR_CONFIG', JSON.stringify({ showBilling: true }));
  });

  it('a held send hitting the credit wall returns to the FORM with the draft intact + a new-tab top-up strip', async () => {
    apiGetMock.mockResolvedValue(NO_BALANCE);
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === '/v1/envelope/preflight') return { ok: true };
      if (path === '/v1/envelope') throw new ApiError('Insufficient credit', 402, { code: 'insufficient_credit' });
      if (path === '/v1/credits/checkout') return { url: 'https://checkout.example/session' };
      throw new Error(`unexpected apiPost ${path}`);
    });

    const { container, rerender } = renderPage();
    fillDraft(container);
    send();
    await screen.findByTestId('signin-screen');

    // The gate is crossed by a zero-credit EXISTING account.
    authHolder.current = { ...authHolder.current, user: { email: 'broke@example.com' } };
    rerenderPage(rerender);
    await waitFor(() => expect(createCalls()).toHaveLength(1));

    // Back on the form — draft intact, error surfaced, inline top-up present.
    expect((await screen.findByPlaceholderText('e.g., NDA for Acme Corp') as HTMLInputElement).value).toBe('contract');
    expect(screen.queryByTestId('signin-screen')).toBeNull();
    const strip = await screen.findByTestId('topup-inline');
    expect(strip.textContent).toMatch(/saved in this tab/i);

    // Top-up opens in a NEW tab — this tab (and the draft) stays alive.
    const open = vi.fn();
    vi.stubGlobal('open', open);
    fireEvent.click(screen.getByTestId('topup-inline-btn'));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://checkout.example/session', '_blank', 'noopener'));

    // After topping up, the SAME draft sends (signed-in path now).
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === '/v1/envelope') return { envelope_id: 'env_after_topup' };
      throw new Error(`unexpected apiPost ${path}`);
    });
    send();
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith('/dashboard/envelope/env_after_topup', expect.anything()),
    );
  });

  it('the classic credit gate still replaces an EMPTY form for a signed-in broke account', async () => {
    authHolder.current = { ...authHolder.current, user: { email: 'broke@example.com' } };
    apiGetMock.mockResolvedValue(NO_BALANCE);
    renderPage();
    expect(await screen.findByText(/add credits to send an envelope/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /send for signing/i })).toBeNull();
  });

  it('a filled draft is NEVER swallowed by the credit card — a late insufficient balance keeps the form + strip', async () => {
    authHolder.current = { ...authHolder.current, user: { email: 'broke@example.com' } };
    let resolveBalance!: (v: unknown) => void;
    apiGetMock.mockReturnValue(new Promise((r) => { resolveBalance = r; }));
    const { container } = renderPage();

    // The user drafts while the balance read is in flight.
    fillDraft(container);
    resolveBalance(NO_BALANCE);

    // The draft must survive: form + inline strip, never the replacing card.
    await screen.findByTestId('topup-inline');
    expect(screen.queryByText(/add credits to send an envelope/i)).toBeNull();
    expect((screen.getByPlaceholderText('e.g., NDA for Acme Corp') as HTMLInputElement).value).toBe('contract');
  });
});
