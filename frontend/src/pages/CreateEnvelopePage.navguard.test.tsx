/**
 * CreateEnvelopePage.navguard.test.tsx — F-025 (Cycle 20, AC-228 / 0.61.1
 * clause "no link on the gate may cost the visitor their envelope").
 *
 * F-024 gave the gate's OWN FAQ link `target=_blank`, but the persistent site
 * header (logo, Pricing, How it works, FAQ, Verify, Sign in) is a SEPARATE
 * component the gate cannot reach — clicking any of its links silently
 * destroyed the held draft. The right fix guards NAVIGATION, not links: while a
 * draft is held, ALL exit vectors (in-SPA links, the logo, browser Back, a hard
 * navigation, tab close) are guarded. These tests use REAL react-router-dom
 * (only auth/api/telemetry are mocked) so the router-level blocker is exercised.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { CreateEnvelopePage } from './CreateEnvelopePage';
import { hasUnsentDraft } from './createEnvelopeDraft';

const { apiPostMock, apiGetMock, authHolder } = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  apiGetMock: vi.fn(),
  authHolder: { current: { user: null as null | { email: string; display_name?: string }, loading: false, refresh: vi.fn(), signOut: vi.fn() } },
}));

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

vi.mock('../lib/telemetry', () => ({
  telemetryEvent: vi.fn(),
  telemetryEventOnce: vi.fn(),
  telemetryPageView: vi.fn(),
}));

const PDF_FILE = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'contract.pdf', { type: 'application/pdf' });

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/create']}>
      <Link to="/">GLOBAL HOME LINK</Link>
      <Routes>
        <Route path="/dashboard/create" element={<CreateEnvelopePage />} />
        <Route path="/" element={<div data-testid="home">home page</div>} />
        <Route path="/dashboard/envelope/:id" element={<div data-testid="envelope">envelope page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function pickFile(container: HTMLElement) {
  fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [PDF_FILE()] } });
}

describe('hasUnsentDraft (F-025 — the guard predicate)', () => {
  const S = (over: Partial<Parameters<typeof hasUnsentDraft>[0]> = {}) => ({
    gatePhase: 'form' as const, file: null, docName: '', signers: [{ email: '', name: '' }], ...over,
  });
  it('an empty form is NOT a draft', () => {
    expect(hasUnsentDraft(S())).toBe(false);
  });
  it('a picked file, a doc name, or any signer content IS a draft', () => {
    expect(hasUnsentDraft(S({ file: PDF_FILE() }))).toBe(true);
    expect(hasUnsentDraft(S({ docName: 'NDA' }))).toBe(true);
    expect(hasUnsentDraft(S({ signers: [{ email: 'a@b.co', name: '' }] }))).toBe(true);
    expect(hasUnsentDraft(S({ signers: [{ email: '', name: 'Alice' }] }))).toBe(true);
  });
  it('the gate and sending phases are always a held draft', () => {
    expect(hasUnsentDraft(S({ gatePhase: 'gate' }))).toBe(true);
    expect(hasUnsentDraft(S({ gatePhase: 'sending' }))).toBe(true);
  });
  it('whitespace-only fields are not a draft', () => {
    expect(hasUnsentDraft(S({ docName: '   ', signers: [{ email: ' ', name: ' ' }] }))).toBe(false);
  });
});

describe('CreateEnvelopePage — navigation guard (F-025)', () => {
  let confirmSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    apiPostMock.mockReset();
    apiGetMock.mockReset();
    authHolder.current = { user: null, loading: false, refresh: vi.fn(), signOut: vi.fn() };
    confirmSpy = vi.spyOn(window, 'confirm');
  });
  afterEach(() => {
    confirmSpy.mockRestore();
  });

  it('an EMPTY form does not arm the beforeunload guard', () => {
    renderApp();
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('a held draft arms beforeunload (hard nav: static header links, browser Back, tab close)', () => {
    const { container } = renderApp();
    pickFile(container);
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('an in-SPA navigation away from a held draft is confirmed — decline stays, accept leaves', async () => {
    const { container } = renderApp();
    pickFile(container);

    // Decline: stay on the editor, draft intact.
    confirmSpy.mockReturnValueOnce(false);
    fireEvent.click(screen.getByText('GLOBAL HOME LINK'));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('home')).toBeNull();
    expect((container.querySelector('input[type="file"]') as HTMLInputElement)).toBeTruthy();

    // Accept: navigation proceeds.
    confirmSpy.mockReturnValueOnce(true);
    fireEvent.click(screen.getByText('GLOBAL HOME LINK'));
    await waitFor(() => expect(screen.getByTestId('home')).toBeTruthy());
  });

  it('a successful send navigates to the envelope WITHOUT a leave-confirm (the guard yields to the send)', async () => {
    authHolder.current = { user: { email: 'creator@example.com', display_name: 'Jordan' }, loading: false, refresh: vi.fn(), signOut: vi.fn() };
    apiGetMock.mockResolvedValue({ balance_usd_micros: '1000000', envelope_cost_usd_micros: '250000', sufficient_for_envelope: true });
    apiPostMock.mockResolvedValue({ envelope_id: 'env_navguard_1' });
    const { container } = renderApp();
    pickFile(container);
    fireEvent.change(screen.getAllByPlaceholderText('e.g., Jane Smith')[0]!, { target: { value: 'Alice Doe' } });
    fireEvent.change(screen.getAllByPlaceholderText('jane.smith@example.com')[0]!, { target: { value: 'alice@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));

    await waitFor(() => expect(screen.getByTestId('envelope')).toBeTruthy());
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe('CreateEnvelopePage — the Google ceremony is a deliberate navigation, not an escape (F-41.6)', () => {
  let confirmSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    apiPostMock.mockReset();
    apiGetMock.mockReset();
    sessionStorage.clear();
    authHolder.current = { user: null, loading: false, refresh: vi.fn(), signOut: vi.fn() };
    confirmSpy = vi.spyOn(window, 'confirm');
    apiGetMock.mockImplementation(async (path: string) => {
      if (path === '/v1/auth/methods') return { google: true };
      throw new Error(`unexpected apiGet ${path}`);
    });
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === '/v1/envelope/preflight') return { ok: true };
      if (path === '/v1/pending-send') return { draft_id: 'ps_3f2a9c14-8b7e-4d1a-9f60-5c2e7a1b8d34.the-secret-half-abcdef' };
      if (path === '/v1/auth/google/start') return { authorization_url: 'https://accounts.google.com/x' };
      throw new Error(`unexpected apiPost ${path}`);
    });
  });
  afterEach(() => {
    confirmSpy.mockRestore();
  });

  // Barry's live report, human pass 2026-07-26: clicking "Continue with Google"
  // at the send gate raised the browser's "Leave site? Changes that you made may
  // not be saved." dialog. That warning is both alarming AND false — the draft
  // was committed to the service moments earlier, which is the entire point of
  // F-40/F-41.6. The ceremony is OUR navigation, the same class as the send's own
  // result navigation, so the guard must yield to it exactly the same way.
  it('leaving for Google does NOT arm beforeunload — the draft is already saved server-side', async () => {
    const { container } = renderApp();
    pickFile(container);
    fireEvent.change(screen.getAllByPlaceholderText('e.g., Jane Smith')[0]!, { target: { value: 'Alice Doe' } });
    fireEvent.change(screen.getAllByPlaceholderText('jane.smith@example.com')[0]!, { target: { value: 'alice@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));
    await screen.findByTestId('signin-screen');

    // Before the ceremony the draft is unsaved — the guard is correctly armed.
    const armed = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(armed);
    expect(armed.defaultPrevented).toBe(true);

    fireEvent.click(await screen.findByTestId('signin-google'));
    await waitFor(() =>
      expect(apiPostMock.mock.calls.some(([p]) => p === '/v1/auth/google/start')).toBe(true),
    );

    // Once the draft is committed and we are leaving for Google, the warning
    // would be a lie: no confirm, no beforeunload block.
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe('CreateEnvelopePage — a COMMITTED draft has nothing unsaved to warn about (F-40/F-41.6)', () => {
  // Barry, human pass 2026-07-26: after his document was restored he pressed
  // "Send me a fresh link", reached the gate, and both browser Back AND
  // Continue with Google raised "Leave site? Changes that you made may not be
  // saved." Nothing was unsaved: the draft lives on the service (that is the
  // whole point of F-40), and his edits are written before the gate opens. A
  // warning that is FALSE is worse than no warning — it teaches people to fear
  // a safe action. The guard now arms only when work would genuinely be lost.
  let confirmSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    apiPostMock.mockReset();
    apiGetMock.mockReset();
    sessionStorage.clear();
    authHolder.current = { user: null, loading: false, refresh: vi.fn(), signOut: vi.fn() };
    confirmSpy = vi.spyOn(window, 'confirm');
    apiGetMock.mockImplementation(async (path: string) => {
      if (path === '/v1/auth/methods') return { google: true };
      throw new Error(`unexpected apiGet ${path}`);
    });
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === '/v1/envelope/preflight') return { ok: true };
      if (path === '/v1/pending-send') return { draft_id: 'ps_3f2a9c14-8b7e-4d1a-9f60-5c2e7a1b8d34.the-secret-half-abcdef' };
      if (path === '/v1/auth/google/start') return { authorization_url: 'https://accounts.google.com/x' };
      throw new Error(`unexpected apiPost ${path}`);
    });
  });
  afterEach(() => confirmSpy.mockRestore());

  async function reachGateWithCommittedDraft(container: HTMLElement) {
    pickFile(container);
    fireEvent.change(screen.getAllByPlaceholderText('e.g., Jane Smith')[0]!, { target: { value: 'Alice Doe' } });
    fireEvent.change(screen.getAllByPlaceholderText('jane.smith@example.com')[0]!, { target: { value: 'alice@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));
    await screen.findByTestId('signin-screen');
    // Commit it the way the Google path does.
    fireEvent.click(await screen.findByTestId('signin-google'));
    await waitFor(() =>
      expect(apiPostMock.mock.calls.some(([p]) => p === '/v1/auth/google/start')).toBe(true),
    );
  }

  it('browser Back from a gate holding a COMMITTED draft does not warn', async () => {
    const { container } = renderApp();
    await reachGateWithCommittedDraft(container);
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('an in-SPA link away from a gate holding a COMMITTED draft does not confirm', async () => {
    const { container } = renderApp();
    await reachGateWithCommittedDraft(container);
    fireEvent.click(screen.getByText('GLOBAL HOME LINK'));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('REGRESSION: an uncommitted filled form still arms the guard', () => {
    const { container } = renderApp();
    pickFile(container);
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});
