/**
 * CreateEnvelopePage.sample.test.tsx — F-44.2 (AC-262): "Try it with a sample
 * document". The button loads the demo waiver from the operator's OWN origin
 * into the exact state a hand-picked file produces (file + display name +
 * draft-started), leaves every signer field untouched, records
 * `sample_doc_clicked` through the once-rail, and a failed fetch surfaces the
 * standard inline error without killing the button.
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

const SAMPLE_URL = '/samples/acme-anvil-waiver.pdf';
const SAMPLE_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
/** Canonical copy pinned by value (spec F-44.2 / the friendlyError bar). */
const BUTTON_LABEL = 'Try it with a sample document';
const MICROCOPY = /No PDF handy\? Use our demo waiver and send it to yourself to see exactly what your signers get\./;
const FAILURE_COPY = /couldn.t load the sample document/i;

function stubSampleFetch(ok = true) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === SAMPLE_URL) {
      if (!ok) throw new Error('network down');
      return {
        ok: true,
        blob: async () => new Blob([SAMPLE_BYTES], { type: 'application/pdf' }),
      } as Response;
    }
    throw new Error(`unexpected fetch: ${String(input)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage(entry = '/dashboard/create') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <CreateEnvelopePage />
    </MemoryRouter>,
  );
}

const sampleClickedOnce = () => telemetryOnceMock.mock.calls.filter(([e]) => e === 'sample_doc_clicked');
const draftStartedOnce = () => telemetryOnceMock.mock.calls.filter(([e]) => e === 'draft_started');

describe('CreateEnvelopePage — the sample-document path (F-44.2 / AC-262)', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === '/v1/envelope/preflight') return { ok: true };
      return { ok: true };
    });
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

  it('renders the button + microcopy for a guest with no file chosen', () => {
    stubSampleFetch();
    renderPage();
    expect(screen.getByRole('button', { name: BUTTON_LABEL })).toBeInTheDocument();
    expect(screen.getByText(MICROCOPY)).toBeInTheDocument();
  });

  it('renders for a signed-in creator too', () => {
    stubSampleFetch();
    authHolder.current = { user: { email: 'creator@example.com' }, loading: false, refresh: vi.fn(), signOut: vi.fn() };
    renderPage();
    expect(screen.getByRole('button', { name: BUTTON_LABEL })).toBeInTheDocument();
  });

  it('does NOT render on a restored draft — its document is immutable, there is no picker (F-40.4)', async () => {
    stubSampleFetch();
    apiGetMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/pending-send/')) {
        return {
          email: 'a@example.com',
          document_name: 'Restored Doc',
          byte_count: 4096,
          signers: [{ email: 's@example.com', name: 'Sig Ner' }],
          auto_close: true,
          claimed: false,
          expires_at: '2026-08-04T00:00:00Z',
        };
      }
      throw new Error('not stubbed');
    });
    renderPage('/dashboard/create?draft=ps_12345678-1234-1234-1234-123456789abc.abcdefghijklmnopqrst');
    await screen.findByTestId('restored-draft-file');
    expect(screen.queryByRole('button', { name: BUTTON_LABEL })).toBeNull();
  });

  it('loads the sample from the OWN origin into the picker state path: file + display name + draft_started', async () => {
    const fetchMock = stubSampleFetch();
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: BUTTON_LABEL }));
    await waitFor(() => {
      expect((screen.getByPlaceholderText('e.g., NDA for Acme Corp') as HTMLInputElement).value).toBe('ACME Anvil Liability Waiver');
    });
    expect(fetchMock).toHaveBeenCalledWith(SAMPLE_URL);
    expect(draftStartedOnce().length).toBeGreaterThan(0);

    // The file is REALLY in state: a guest Send with signers filled passes the
    // "Please upload a PDF" validation and reaches the public preflight.
    fireEvent.change(screen.getAllByPlaceholderText('e.g., Jane Smith')[0]!, { target: { value: 'Me Myself' } });
    fireEvent.change(screen.getAllByPlaceholderText('jane.smith@example.com')[0]!, { target: { value: 'me@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));
    await screen.findByTestId('signin-screen');
    expect(apiPostMock).toHaveBeenCalledWith('/v1/envelope/preflight', expect.anything());
  });

  it('leaves every signer field untouched — sending it to yourself is the point', async () => {
    stubSampleFetch();
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: BUTTON_LABEL }));
    await waitFor(() => {
      expect((screen.getByPlaceholderText('e.g., NDA for Acme Corp') as HTMLInputElement).value).toBe('ACME Anvil Liability Waiver');
    });
    expect((screen.getAllByPlaceholderText('e.g., Jane Smith')[0] as HTMLInputElement).value).toBe('');
    expect((screen.getAllByPlaceholderText('jane.smith@example.com')[0] as HTMLInputElement).value).toBe('');
  });

  it('records sample_doc_clicked through the once-rail only, element-less', async () => {
    stubSampleFetch();
    renderPage();
    expect(sampleClickedOnce()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: BUTTON_LABEL }));
    await waitFor(() => expect(sampleClickedOnce().length).toBeGreaterThan(0));
    expect(telemetryEventMock.mock.calls.filter(([e]) => e === 'sample_doc_clicked')).toHaveLength(0);
    for (const call of sampleClickedOnce()) {
      expect(call[1]).toBeUndefined();
    }
  });

  it('a failed fetch shows the standard inline error and never a dead button', async () => {
    stubSampleFetch(false);
    renderPage();
    const button = screen.getByRole('button', { name: BUTTON_LABEL });
    fireEvent.click(button);
    await screen.findByText(FAILURE_COPY);
    // The button survives the failure: still rendered, still enabled.
    const after = screen.getByRole('button', { name: BUTTON_LABEL });
    expect(after).toBeEnabled();
    // And no file landed in state: Send still trips the upload validation.
    fireEvent.change(screen.getAllByPlaceholderText('e.g., Jane Smith')[0]!, { target: { value: 'Me Myself' } });
    fireEvent.change(screen.getAllByPlaceholderText('jane.smith@example.com')[0]!, { target: { value: 'me@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));
    expect(await screen.findByText('Please upload a PDF')).toBeInTheDocument();
  });

  it('no sample value rides any telemetry payload', async () => {
    stubSampleFetch();
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: BUTTON_LABEL }));
    await waitFor(() => {
      expect((screen.getByPlaceholderText('e.g., NDA for Acme Corp') as HTMLInputElement).value).toBe('ACME Anvil Liability Waiver');
    });
    const allArgs = JSON.stringify([...telemetryEventMock.mock.calls, ...telemetryOnceMock.mock.calls]);
    for (const leak of ['ACME', 'acme-anvil-waiver', 'Waiver']) {
      expect(allArgs).not.toContain(leak);
    }
  });
});
