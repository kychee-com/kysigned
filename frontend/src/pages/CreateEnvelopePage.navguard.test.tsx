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
import { hasUnsentDraft, CreateEnvelopePage } from './CreateEnvelopePage';

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
