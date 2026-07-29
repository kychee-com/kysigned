/**
 * CreateEnvelopePage.dropzone.test.tsx — F-44.3 (AC-263): the upload control
 * as a drag-and-drop zone. Written AFTER implementation (frontend-visual,
 * spec-driven): drop feeds the same pick path as the picker, non-PDF and
 * oversize drops surface the standard errors, the chosen file shows name+size
 * however it arrived (picked / dropped / sample), and the retention trust
 * line carries exactly the F-9.3-true claim.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const TRUST_LINE =
  'Your PDF is deleted from our servers shortly after everyone receives the signed record. Your inbox keeps the proof.';

const pdfFile = (name = 'dropped-contract.pdf') =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type: 'application/pdf' });

const oversizePdf = () => {
  const f = pdfFile('huge.pdf');
  Object.defineProperty(f, 'size', { value: 3_100_000 });
  return f;
};

function renderPage() {
  return render(
    <MemoryRouter>
      <CreateEnvelopePage />
    </MemoryRouter>,
  );
}

const zone = () => screen.getByTestId('pdf-drop-zone');
const docNameInput = () => screen.getByPlaceholderText('e.g., NDA for Acme Corp') as HTMLInputElement;
const fileInput = () => document.getElementById('pdf-file-input') as HTMLInputElement;

describe('CreateEnvelopePage — the drop zone + trust line (F-44.3 / AC-263)', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiPostMock.mockResolvedValue({ ok: true });
    apiGetMock.mockReset();
    apiGetMock.mockRejectedValue(new Error('not stubbed'));
    navigateMock.mockReset();
    telemetryEventMock.mockReset();
    telemetryOnceMock.mockReset();
    authHolder.current = { user: null, loading: false, refresh: vi.fn(), signOut: vi.fn() };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the drag affordance and the browse affordance in the empty state', () => {
    renderPage();
    expect(screen.getByText('Drag and drop your PDF here')).toBeInTheDocument();
    expect(screen.getByText('or click to browse')).toBeInTheDocument();
  });

  it('a dropped PDF lands in the same pick path: display name prefills, draft_started fires', () => {
    renderPage();
    fireEvent.drop(zone(), { dataTransfer: { files: [pdfFile()] } });
    expect(docNameInput().value).toBe('dropped-contract');
    expect(telemetryOnceMock.mock.calls.filter(([e]) => e === 'draft_started').length).toBeGreaterThan(0);
    const display = screen.getByTestId('chosen-file-display');
    expect(display.textContent).toContain('dropped-contract.pdf');
    expect(display.textContent).toMatch(/\d+ KB/);
  });

  it('a non-PDF drop is rejected with the standard copy and picks nothing', () => {
    renderPage();
    const notPdf = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
    fireEvent.drop(zone(), { dataTransfer: { files: [notPdf] } });
    expect(screen.getByText('Please upload a PDF')).toBeInTheDocument();
    expect(docNameInput().value).toBe('');
    expect(screen.queryByTestId('chosen-file-display')).toBeNull();
  });

  it('an oversize dropped PDF trips the existing size guard at pick time', () => {
    renderPage();
    fireEvent.drop(zone(), { dataTransfer: { files: [oversizePdf()] } });
    expect(screen.getByText(/That PDF is too large/)).toBeInTheDocument();
  });

  it('a file picked through the input shows the same name+size display', () => {
    renderPage();
    fireEvent.change(fileInput(), { target: { files: [pdfFile('picked-agreement.pdf')] } });
    const display = screen.getByTestId('chosen-file-display');
    expect(display.textContent).toContain('picked-agreement.pdf');
    expect(docNameInput().value).toBe('picked-agreement');
  });

  it('the sample lands in the same display too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' }),
      }) as Response),
    );
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Try it with a sample document' }));
    await waitFor(() => {
      expect(screen.getByTestId('chosen-file-display').textContent).toContain('acme-anvil-waiver.pdf');
    });
    expect(docNameInput().value).toBe('ACME Anvil Liability Waiver');
  });

  it('re-picking refreshes the display name (the clear-before-pick semantics hold)', () => {
    renderPage();
    fireEvent.change(fileInput(), { target: { files: [pdfFile('first.pdf')] } });
    expect(docNameInput().value).toBe('first');
    fireEvent.change(docNameInput(), { target: { value: 'my edited name' } });
    fireEvent.change(fileInput(), { target: { files: [pdfFile('first.pdf')] } });
    expect(docNameInput().value).toBe('first');
  });

  it('the trust line renders the exact F-9.3-true retention claim under the zone', () => {
    renderPage();
    expect(screen.getByTestId('retention-trust-line').textContent).toBe(TRUST_LINE);
  });

  it('the input keeps its id, bound label, and 44px class inside the zone (AC-231/F-026)', () => {
    renderPage();
    const input = fileInput();
    expect(input).toBeTruthy();
    expect(document.querySelector('label[for="pdf-file-input"]')).toBeTruthy();
    expect(input.className).toMatch(/min-h-\[44px\]/);
    expect(zone().contains(input)).toBe(true);
  });
});
