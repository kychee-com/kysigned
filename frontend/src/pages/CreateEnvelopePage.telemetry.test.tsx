/**
 * CreateEnvelopePage.telemetry.test.tsx — F-39.5 (AC-227): the editor's three
 * hand-fired funnel sites (DD-52). `draft_started` once-per-load via the
 * rail's eventOnce, `send_clicked` on every Send press, NO data-telemetry
 * attributes anywhere in the editor (the F-38.2 catch-all deliberately does
 * not sweep it), and no draft value ever rides an emitted payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { apiPostMock, apiGetMock, navigateMock, authHolder, telemetryEventMock, telemetryOnceMock } = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  apiGetMock: vi.fn(),
  navigateMock: vi.fn(),
  authHolder: { current: { user: null as null | { email: string }, loading: false, refresh: vi.fn(), signOut: vi.fn() } },
  telemetryEventMock: vi.fn(),
  telemetryOnceMock: vi.fn(),
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

vi.mock('../lib/telemetry', () => ({
  telemetryEvent: telemetryEventMock,
  telemetryEventOnce: telemetryOnceMock,
  telemetryPageView: vi.fn(),
}));

import { CreateEnvelopePage } from './CreateEnvelopePage';

const PDF_FILE = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'secret-contract.pdf', { type: 'application/pdf' });

function renderPage() {
  return render(
    <MemoryRouter>
      <CreateEnvelopePage />
    </MemoryRouter>,
  );
}

const draftStartedCalls = () => telemetryOnceMock.mock.calls.filter(([e]) => e === 'draft_started');
const sendClickedCalls = () => telemetryEventMock.mock.calls.filter(([e]) => e === 'send_clicked');

describe('CreateEnvelopePage — hand-fired funnel sites (F-39.5 / AC-227)', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === '/v1/envelope/preflight') return { ok: true };
      if (path === '/v1/envelope') return { envelope_id: 'env_t1' };
      return { ok: true };
    });
    apiGetMock.mockReset();
    navigateMock.mockReset();
    telemetryEventMock.mockReset();
    telemetryOnceMock.mockReset();
    authHolder.current = { user: null, loading: false, refresh: vi.fn(), signOut: vi.fn() };
  });

  it('the first draft interaction fires draft_started through the once-rail (file pick)', () => {
    const { container } = renderPage();
    expect(draftStartedCalls()).toHaveLength(0);
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [PDF_FILE()] } });
    expect(draftStartedCalls().length).toBeGreaterThan(0);
    // Once-per-page-load semantics belong to the RAIL (eventOnce): the site
    // must never route draft_started through the plain event channel.
    expect(telemetryEventMock.mock.calls.filter(([e]) => e === 'draft_started')).toHaveLength(0);
  });

  it('typing into a signer field also counts as starting the draft', () => {
    renderPage();
    fireEvent.change(screen.getAllByPlaceholderText('e.g., Jane Smith')[0]!, { target: { value: 'A' } });
    expect(draftStartedCalls().length).toBeGreaterThan(0);
  });

  it('every Send press fires send_clicked — valid or not, guest or signed in', async () => {
    const { container } = renderPage();
    // Press 1: empty form (invalid) — the press itself is the measured intent.
    fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));
    expect(sendClickedCalls()).toHaveLength(1);

    // Press 2: valid guest draft → gate opens.
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [PDF_FILE()] } });
    fireEvent.change(screen.getAllByPlaceholderText('e.g., Jane Smith')[0]!, { target: { value: 'Alice Doe' } });
    fireEvent.change(screen.getAllByPlaceholderText('jane.smith@example.com')[0]!, { target: { value: 'alice@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));
    await screen.findByTestId('signin-screen');
    expect(sendClickedCalls()).toHaveLength(2);
  });

  it('the rendered editor carries ZERO data-telemetry attributes (the catch-all must not sweep it)', () => {
    const { container } = renderPage();
    expect(container.querySelectorAll('[data-telemetry]')).toHaveLength(0);
  });

  it('no draft value ever reaches a telemetry payload', async () => {
    const { container } = renderPage();
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [PDF_FILE()] } });
    fireEvent.change(screen.getAllByPlaceholderText('e.g., Jane Smith')[0]!, { target: { value: 'Alice Doe' } });
    fireEvent.change(screen.getAllByPlaceholderText('jane.smith@example.com')[0]!, { target: { value: 'alice@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));
    await screen.findByTestId('signin-screen');

    const allArgs = JSON.stringify([...telemetryEventMock.mock.calls, ...telemetryOnceMock.mock.calls]);
    for (const leak of ['secret-contract', 'Alice Doe', 'alice@example.com']) {
      expect(allArgs).not.toContain(leak);
    }
  });
});
