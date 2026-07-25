/**
 * CreateEnvelopePage.handover.test.tsx — F-40 (AC-236, AC-238..241), the tab
 * that lands finishes the job.
 *
 * The reported bug was "the magic link opens a new tab and then you have to go
 * back". The new tab is unavoidable, so the fix is that it is no longer a dead
 * end: the draft lives on the service, and whichever browser gets the session
 * claims it and sends. These tests drive the four moments that matter —
 *
 *   the gate WRITES the draft (and fails closed if it cannot),
 *   the landing tab CLAIMS and sends,
 *   a failed sign-in RESTORES the filled-in form,
 *   the composing tab STOPS waiting once someone else sent it.
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

import { ApiError } from '../lib/api';
import { CreateEnvelopePage } from './CreateEnvelopePage';

const HANDLE = 'ps_3f2a9c14-8b7e-4d1a-9f60-5c2e7a1b8d34';

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
const callsTo = (path: string) => apiPostMock.mock.calls.filter(([p]) => p === path);
const magicLinkCalls = () => callsTo('/v1/auth/magic-link');

beforeEach(() => {
  apiPostMock.mockReset();
  apiGetMock.mockReset();
  apiPatchMock.mockReset();
  navigateMock.mockReset();
  searchHolder.current = '';
  authHolder.current = { user: null, loading: false, refresh: vi.fn(), signOut: vi.fn() };
  apiGetMock.mockResolvedValue(RESTORED);
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

describe('the gate writes the draft to the service (AC-236, AC-238)', () => {
  // The draft is stored at the moment the ADDRESS is known, not when the gate
  // opens: the binding is the draft's whole security model (only a session for
  // that address may claim it), so it cannot be written before the address —
  // and it must be written before the link goes out, or the link could arrive
  // pointing at nothing.
  it('stores the validated draft with the typed address, then hands its handle to the link', async () => {
    const { container } = renderPage();
    fillDraft(container);
    send();
    await screen.findByTestId('signin-screen');
    expect(callsTo('/v1/pending-send')).toHaveLength(0);

    fireEvent.change(screen.getByTestId('signin-email'), { target: { value: 'creator@example.com' } });
    fireEvent.click(screen.getByTestId('signin-send-link'));
    await waitFor(() => expect(magicLinkCalls()).toHaveLength(1));

    const stored = callsTo('/v1/pending-send')[0]![1] as Record<string, unknown>;
    expect(stored.email).toBe('creator@example.com');
    expect(stored.document_name).toBe('contract');
    expect(stored.signers).toEqual([{ email: 'alice@example.com', name: 'Alice Doe', on_behalf_of: undefined }]);
    expect(typeof stored.pdf_base64).toBe('string');
    expect((magicLinkCalls()[0]![1] as { draft_id: string }).draft_id).toBe(HANDLE);
  });

  it('FAILS CLOSED: a store failure sends NO link and keeps the draft', async () => {
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === '/v1/envelope/preflight') return { ok: true };
      if (path === '/v1/pending-send') throw new ApiError('Service unavailable', 503);
      throw new Error(`unexpected apiPost ${path}`);
    });
    const { container } = renderPage();
    fillDraft(container);
    send();
    await screen.findByTestId('signin-screen');
    fireEvent.change(screen.getByTestId('signin-email'), { target: { value: 'creator@example.com' } });
    fireEvent.click(screen.getByTestId('signin-send-link'));
    await waitFor(() => expect(callsTo('/v1/pending-send')).toHaveLength(1));
    expect(magicLinkCalls()).toHaveLength(0);
    expect(await screen.findByTestId('signin-error')).toBeTruthy();
    // Stepping back proves the draft is still held.
    fireEvent.click(screen.getByTestId('gate-back'));
    expect((screen.getByPlaceholderText('e.g., NDA for Acme Corp') as HTMLInputElement).value).toBe('contract');
  });

  it('an INVALID draft still fails at preflight, storing nothing', async () => {
    renderPage();
    send(); // nothing filled
    expect(await screen.findByText(/please upload a pdf/i)).toBeTruthy();
    expect(callsTo('/v1/pending-send')).toHaveLength(0);
  });

  it('a signed-in creator writes NO pending send at all', async () => {
    authHolder.current = { ...authHolder.current, user: { email: 'creator@example.com' } };
    apiGetMock.mockResolvedValue({ balance_usd_micros: '1000000', envelope_cost_usd_micros: '250000', sufficient_for_envelope: true });
    const { container } = renderPage();
    fillDraft(container);
    send();
    await waitFor(() => expect(callsTo('/v1/envelope')).toHaveLength(1));
    expect(callsTo('/v1/pending-send')).toHaveLength(0);
    expect(screen.queryByTestId('signin-screen')).toBeNull();
  });
});

describe('the landing tab finishes the job (AC-239)', () => {
  it('claims the draft and lands on its envelope, with no second create', async () => {
    searchHolder.current = `?draft=${HANDLE}&claim=1`;
    authHolder.current = { ...authHolder.current, user: { email: 'creator@example.com' } };
    renderPage();
    await waitFor(() => expect(callsTo(`/v1/pending-send/${HANDLE}/claim`)).toHaveLength(1));
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        '/dashboard/envelope/env_claimed',
        expect.objectContaining({ state: expect.objectContaining({ justSent: true }) }),
      ),
    );
    expect(callsTo('/v1/envelope')).toHaveLength(0);
  });

  it('a draft the other tab already sent navigates to that envelope, not to an error', async () => {
    searchHolder.current = `?draft=${HANDLE}&claim=1`;
    authHolder.current = { ...authHolder.current, user: { email: 'creator@example.com' } };
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === `/v1/pending-send/${HANDLE}/claim`) return { envelope_id: 'env_first', already_sent: true };
      throw new Error(`unexpected apiPost ${path}`);
    });
    renderPage();
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/dashboard/envelope/env_first', expect.anything()));
  });

  it('claims EXACTLY once even across re-renders', async () => {
    searchHolder.current = `?draft=${HANDLE}&claim=1`;
    authHolder.current = { ...authHolder.current, user: { email: 'creator@example.com' } };
    const { rerender } = renderPage();
    await waitFor(() => expect(callsTo(`/v1/pending-send/${HANDLE}/claim`)).toHaveLength(1));
    rerenderPage(rerender);
    rerenderPage(rerender);
    expect(callsTo(`/v1/pending-send/${HANDLE}/claim`)).toHaveLength(1);
  });

  // Found by the LIVE handover probe, 2026-07-25: the landing signed in
  // cross-context and the claim was correctly refused for want of credit, but the
  // page then rendered the full-page "Add credits" card INSTEAD of the visitor's
  // document. The replacing card reads `!file`, and a restored draft's document
  // lives on the service rather than in `file`. F-39.4 / AC-226 is explicit that
  // a draft that already exists must never be swallowed by that card.
  it('a restored draft is NEVER swallowed by the insufficient-credit card', async () => {
    searchHolder.current = `?draft=${HANDLE}&claim=1`;
    authHolder.current = { ...authHolder.current, user: { email: 'creator@example.com' } };
    apiGetMock.mockImplementation(async (path: string) => {
      if (path === '/v1/credits/balance') {
        return { balance_usd_micros: '0', envelope_cost_usd_micros: '250000', sufficient_for_envelope: false };
      }
      return RESTORED;
    });
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === `/v1/pending-send/${HANDLE}/claim`) throw new ApiError('Insufficient credit', 402);
      throw new Error(`unexpected apiPost ${path}`);
    });
    renderPage();
    // The document is still on screen, with the inline top-up beside it.
    await waitFor(() =>
      expect((screen.getByPlaceholderText('e.g., NDA for Acme Corp') as HTMLInputElement).value).toBe('contract'),
    );
    expect(screen.getByTestId('restored-draft-file')).toBeTruthy();
    // The replacing card is the thing that swallowed it live. It must not appear.
    expect(screen.queryByText(/add credits to send your document/i)).toBeNull();
    // And the refusal is still explained, on the form, beside the document.
    expect(screen.getByText(/insufficient credit/i)).toBeTruthy();
  });

  it('a refused claim (no credit) shows the reason on the restored form, not a dead end', async () => {
    searchHolder.current = `?draft=${HANDLE}&claim=1`;
    authHolder.current = { ...authHolder.current, user: { email: 'creator@example.com' } };
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === `/v1/pending-send/${HANDLE}/claim`) throw new ApiError('Insufficient credit. Please top up to send.', 402);
      throw new Error(`unexpected apiPost ${path}`);
    });
    renderPage();
    expect(await screen.findByText(/insufficient credit/i)).toBeTruthy();
    await waitFor(() => expect((screen.getByPlaceholderText('e.g., NDA for Acme Corp') as HTMLInputElement).value).toBe('contract'));
  });
});

describe('a failed sign-in restores the FILLED form (AC-240)', () => {
  beforeEach(() => {
    searchHolder.current = `?draft=${HANDLE}&signin_failed=1`;
  });

  it('brings back the document, the signers and a plain-words explanation', async () => {
    renderPage();
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith(`/v1/pending-send/${HANDLE}`));
    expect((await screen.findByPlaceholderText('e.g., NDA for Acme Corp') as HTMLInputElement).value).toBe('contract');
    expect((screen.getAllByPlaceholderText('jane.smith@example.com')[0] as HTMLInputElement).value).toBe('alice@example.com');
    expect((screen.getAllByPlaceholderText('e.g., Jane Smith')[0] as HTMLInputElement).value).toBe('Alice Doe');
    const notice = screen.getByTestId('restore-notice').textContent ?? '';
    expect(notice).toMatch(/sign-in link/i);
    expect(notice).not.toMatch(/401|run402|token|undefined/i);
  });

  it('shows the document as still attached, and offers no way to swap it', async () => {
    renderPage();
    const chip = await screen.findByTestId('restored-draft-file');
    expect(chip.textContent).toMatch(/contract/);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('resends a fresh link against the SAME draft, address prefilled, nothing re-uploaded', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('restore-resend'));
    expect((await screen.findByTestId('signin-email') as HTMLInputElement).value).toBe('creator@example.com');
    fireEvent.click(screen.getByTestId('signin-send-link'));
    await waitFor(() => expect(magicLinkCalls()).toHaveLength(1));
    expect((magicLinkCalls()[0]![1] as { draft_id: string }).draft_id).toBe(HANDLE);
    expect(callsTo('/v1/pending-send')).toHaveLength(0);
  });

  it('a draft that is gone says so plainly instead of restoring an empty form', async () => {
    apiGetMock.mockRejectedValue(new ApiError('That document is no longer available', 404, { code: 'not_found' }));
    renderPage();
    const notice = (await screen.findByTestId('restore-notice')).textContent ?? '';
    expect(notice).toMatch(/no longer/i);
    expect(notice).not.toMatch(/404|not_found/i);
  });
});

describe('a restored draft is editable, the file is not (AC-241)', () => {
  beforeEach(() => {
    searchHolder.current = `?draft=${HANDLE}&signin_failed=1`;
  });

  it('a corrected signer address is saved back before the link is resent', async () => {
    renderPage();
    const emailField = (await screen.findAllByPlaceholderText('jane.smith@example.com'))[0] as HTMLInputElement;
    fireEvent.change(emailField, { target: { value: 'corrected@example.com' } });
    fireEvent.click(screen.getByTestId('restore-resend'));
    await waitFor(() => expect(apiPatchMock).toHaveBeenCalledWith(`/v1/pending-send/${HANDLE}`, expect.anything()));
    const patch = apiPatchMock.mock.calls[0]![1] as { signers: Array<{ email: string }> };
    expect(patch.signers[0]!.email).toBe('corrected@example.com');
  });

  it('never sends the document bytes on an edit', async () => {
    renderPage();
    fireEvent.change((await screen.findByPlaceholderText('e.g., NDA for Acme Corp')), { target: { value: 'contract v2' } });
    fireEvent.click(screen.getByTestId('restore-resend'));
    await waitFor(() => expect(apiPatchMock).toHaveBeenCalled());
    const patch = apiPatchMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.pdf_base64).toBeUndefined();
    expect(patch.document_name).toBe('contract v2');
  });
});

describe('the composing tab gets an ending (AC-239)', () => {
  it('settles on "sent" once another browser claimed the draft, instead of waiting forever', async () => {
    vi.useFakeTimers();
    try {
      const { container } = renderPage();
      fillDraft(container);
      send();
      await vi.waitFor(() => expect(screen.queryByTestId('signin-screen')).toBeTruthy());
      fireEvent.change(screen.getByTestId('signin-email'), { target: { value: 'creator@example.com' } });
      fireEvent.click(screen.getByTestId('signin-send-link'));
      await vi.waitFor(() => expect(magicLinkCalls()).toHaveLength(1));

      apiGetMock.mockResolvedValue({ ...RESTORED, claimed: true, envelope_id: 'env_elsewhere' });
      await vi.advanceTimersByTimeAsync(6000);
      await vi.waitFor(() => expect(screen.queryByTestId('gate-sent-elsewhere')).toBeTruthy());
      expect(screen.getByTestId('gate-sent-elsewhere').textContent).toMatch(/sent/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
