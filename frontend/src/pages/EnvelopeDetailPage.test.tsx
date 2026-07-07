/**
 * EnvelopeDetailPage.test.tsx — recipient editing + manual seal UI (F-23 / F-24,
 * AC-72/73/74/75; resolves #23 UI).
 *
 * Covers: the "Seal & send" action on an awaiting_seal envelope; per-signer
 * edit / delete / add controls on an open envelope (and their API wiring); the
 * superseded + undeliverable badges; and that a sealed (completed) envelope
 * exposes NO editing controls (the set is frozen).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { apiGetMock, apiPostMock, apiPatchMock, apiDeleteMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiPatchMock: vi.fn(),
  apiDeleteMock: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => {
  const actual = await importActual<typeof import('../lib/api')>();
  return { ...actual, apiGet: apiGetMock, apiPost: apiPostMock, apiPatch: apiPatchMock, apiDelete: apiDeleteMock };
});
vi.mock('../lib/analytics', () => ({
  trackEventOnce: vi.fn(),
  GA_EVENTS: { SIGNATURE_COMPLETED: 'signature_completed', ENVELOPE_COMPLETED: 'envelope_completed' },
}));

import { EnvelopeDetailPage } from './EnvelopeDetailPage';

type Signer = {
  email: string; name: string; on_behalf_of: string | null; status: string;
  signing_method: string | null; signed_at: string | null; undeliverable_at: string | null;
  signing_domain?: string | null; signing_selector?: string | null; eml_sha256?: string | null;
};
function signer(over: Partial<Signer>): Signer {
  return { email: 'a@x.com', name: 'Alice', on_behalf_of: null, status: 'pending', signing_method: null, signed_at: null, undeliverable_at: null, ...over };
}
function envelope(over: Record<string, unknown> = {}) {
  return {
    id: 'env_1', document_name: 'NDA', document_hash: 'd'.repeat(64),
    status: 'active', auto_close: true, created_at: new Date('2026-01-01').toISOString(),
    completed_at: null, completion_distributed_at: null,
    signers: [signer({ email: 'a@x.com', name: 'Alice' }), signer({ email: 'b@x.com', name: 'Bob' })],
    ...over,
  };
}

/** apiGet returns the envelope for /v1/envelope/:id and [] for /v1/documents. */
function mockEnvelope(env: Record<string, unknown>) {
  apiGetMock.mockImplementation((path: string) =>
    path.startsWith('/v1/documents') ? Promise.resolve([]) : Promise.resolve(env),
  );
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/envelope/env_1']}>
      <Routes>
        <Route path="/dashboard/envelope/:id" element={<EnvelopeDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset().mockResolvedValue({});
  apiPatchMock.mockReset().mockResolvedValue({});
  apiDeleteMock.mockReset().mockResolvedValue(null);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('manual seal — Seal & send (F-24.2 / AC-75)', () => {
  it('an awaiting_seal envelope shows "Seal & send" and the action calls the seal endpoint', async () => {
    mockEnvelope(envelope({ status: 'awaiting_seal', auto_close: false, signers: [signer({ status: 'signed', signed_at: new Date().toISOString() })] }));
    renderPage();
    const sealBtn = await screen.findByRole('button', { name: /seal & send/i });
    fireEvent.click(sealBtn);
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith('/v1/envelope/env_1/seal', {}));
  });

  it('an active envelope does NOT show "Seal & send"', async () => {
    mockEnvelope(envelope());
    renderPage();
    await screen.findByText('Signers');
    expect(screen.queryByRole('button', { name: /seal & send/i })).toBeNull();
  });

  it('an ACTIVE manual-seal envelope shows "Seal & send" the moment everyone has signed (no 5-min cron wait, Barry QA)', async () => {
    mockEnvelope(envelope({ status: 'active', auto_close: false, signers: [
      signer({ email: 'a@x.com', status: 'signed', signed_at: new Date().toISOString() }),
      signer({ email: 'b@x.com', status: 'signed', signed_at: new Date().toISOString() }),
    ] }));
    renderPage();
    expect(await screen.findByRole('button', { name: /seal & send/i })).toBeInTheDocument();
  });

  it('an active manual-seal envelope with a still-pending signer does NOT show "Seal & send" yet', async () => {
    mockEnvelope(envelope({ status: 'active', auto_close: false, signers: [
      signer({ email: 'a@x.com', status: 'signed', signed_at: new Date().toISOString() }),
      signer({ email: 'b@x.com', status: 'pending' }),
    ] }));
    renderPage();
    await screen.findByText('Signers');
    expect(screen.queryByRole('button', { name: /seal & send/i })).toBeNull();
  });

  it('once a signer is superseded (edited after signing) Seal vanishes and "Send Reminders" returns (Barry QA)', async () => {
    mockEnvelope(envelope({ status: 'active', auto_close: false, signers: [
      signer({ email: 'a@x.com', status: 'signed', signed_at: new Date().toISOString() }),
      signer({ email: 'b@x.com', status: 'superseded' }),
    ] }));
    renderPage();
    expect(await screen.findByRole('button', { name: /send reminders/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /seal & send/i })).toBeNull();
  });
});

describe('Cancel grey-out once auto-complete is done (F-24.1 / Barry QA)', () => {
  it('greys out Cancel when auto-close is on and everyone has signed (the bundle is on its way)', async () => {
    mockEnvelope(envelope({ status: 'active', auto_close: true, signers: [
      signer({ email: 'a@x.com', status: 'signed', signed_at: new Date().toISOString() }),
      signer({ email: 'b@x.com', status: 'signed', signed_at: new Date().toISOString() }),
    ] }));
    renderPage();
    expect(await screen.findByRole('button', { name: /cancel envelope/i })).toBeDisabled();
  });

  it('keeps Cancel enabled while a signer is still pending', async () => {
    mockEnvelope(envelope({ status: 'active', auto_close: true, signers: [
      signer({ email: 'a@x.com', status: 'signed', signed_at: new Date().toISOString() }),
      signer({ email: 'b@x.com', status: 'pending' }),
    ] }));
    renderPage();
    expect(await screen.findByRole('button', { name: /cancel envelope/i })).toBeEnabled();
  });

  it('keeps Cancel enabled in MANUAL-seal mode even when all-signed (creator can still cancel before sealing)', async () => {
    mockEnvelope(envelope({ status: 'awaiting_seal', auto_close: false, signers: [
      signer({ email: 'a@x.com', status: 'signed', signed_at: new Date().toISOString() }),
    ] }));
    renderPage();
    expect(await screen.findByRole('button', { name: /cancel envelope/i })).toBeEnabled();
  });
});

describe('recipient editing (F-23 / AC-72, AC-73)', () => {
  it('an open envelope exposes Add / Edit / Delete; deleting calls the delete endpoint', async () => {
    mockEnvelope(envelope());
    renderPage();
    expect(await screen.findByRole('button', { name: /\+ add signer/i })).toBeInTheDocument();
    fireEvent.click(screen.getAllByText('Delete')[0]!);
    await waitFor(() =>
      expect(apiDeleteMock).toHaveBeenCalledWith('/v1/envelope/env_1/signers?email=a%40x.com'),
    );
  });

  it('editing a signer name PATCHes /signers?email= for that signer', async () => {
    mockEnvelope(envelope());
    renderPage();
    await screen.findByText('Signers');
    fireEvent.click(screen.getAllByText('Edit')[0]!);
    fireEvent.click(screen.getByRole('button', { name: /save & resend/i }));
    await waitFor(() => expect(apiPatchMock).toHaveBeenCalled());
    expect(apiPatchMock.mock.calls[0]![0]).toBe('/v1/envelope/env_1/signers?email=a%40x.com');
  });

  it('adding a signer POSTs /signers with the new name + email', async () => {
    mockEnvelope(envelope());
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /\+ add signer/i }));
    fireEvent.change(screen.getByPlaceholderText('Full name'), { target: { value: 'Carol' } });
    fireEvent.change(screen.getByPlaceholderText('email@example.com'), { target: { value: 'carol@x.com' } });
    fireEvent.click(screen.getByRole('button', { name: /add & send request/i }));
    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
    const [path, body] = apiPostMock.mock.calls[0]! as [string, { email: string; name: string }];
    expect(path).toBe('/v1/envelope/env_1/signers');
    expect(body).toMatchObject({ email: 'carol@x.com', name: 'Carol' });
  });

  it('a sealed (completed) envelope exposes NO editing controls — the set is frozen (F-23.5)', async () => {
    mockEnvelope(envelope({ status: 'completed', signers: [signer({ status: 'signed', signed_at: new Date().toISOString() })] }));
    renderPage();
    await screen.findByText('Signers');
    expect(screen.queryByRole('button', { name: /\+ add signer/i })).toBeNull();
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('Delete')).toBeNull();
  });
});

describe('signer state badges (F-11.2)', () => {
  it('renders the re-sign badge (was "superseded") and an undeliverable badge', async () => {
    mockEnvelope(envelope({
      signers: [
        signer({ email: 'c@x.com', name: 'Carol', status: 'superseded' }),
        signer({ email: 'd@x.com', name: 'Dan', status: 'pending', undeliverable_at: new Date().toISOString() }),
      ],
    }));
    renderPage();
    // "superseded" was confusing — the badge now reads "awaiting re-sign" (Barry QA).
    expect(await screen.findByText('awaiting re-sign')).toBeInTheDocument();
    expect(screen.queryByText('superseded')).toBeNull();
    expect(screen.getByText('undeliverable')).toBeInTheDocument();
  });
});

describe('single-envelope scope — no cross-envelope aggregate (#111 / F-11.2)', () => {
  // The detail page must describe ONLY this envelope. The removed "Document
  // Overview" block fetched /v1/documents and rendered a cross-envelope
  // aggregate that contradicted this envelope's own progress and leaked the
  // signer counts of every other envelope sharing the same document hash.
  function mockWithSharedDocument() {
    apiGetMock.mockImplementation((path: string) =>
      path.startsWith('/v1/documents')
        ? Promise.resolve([
            {
              documentHash: 'd'.repeat(64),
              documentName: 'NDA',
              totalSigners: 5,
              signedCount: 3,
              envelopes: [
                { id: 'env_1', status: 'active', created_at: '', completed_at: null },
                { id: 'env_2', status: 'completed', created_at: '', completed_at: null },
              ],
            },
          ])
        : Promise.resolve(envelope()),
    );
  }

  it('renders NO cross-envelope "Document Overview" aggregate even when the document is shared', async () => {
    mockWithSharedDocument();
    renderPage();
    await screen.findByText('Signers');
    expect(screen.queryByText(/Document Overview/i)).toBeNull();
    expect(screen.queryByText(/total signers across/i)).toBeNull();
  });

  it('does not link out to sibling envelopes from the detail page', async () => {
    mockWithSharedDocument();
    renderPage();
    await screen.findByText('Signers');
    expect(screen.queryByRole('link', { name: /env_2/i })).toBeNull();
  });
});

describe('per-signer evidence on the dashboard (F-11)', () => {
  it('renders provider + selector + .eml hash for a signed signer', async () => {
    mockEnvelope(envelope({ signers: [
      signer({
        email: 'a@x.com', name: 'Alice', status: 'signed', signed_at: new Date().toISOString(),
        signing_domain: 'gmail.com', signing_selector: '20251104', eml_sha256: 'abc123def456',
      }),
    ] }));
    renderPage();
    expect(await screen.findByText(/selector 20251104/)).toBeInTheDocument();
    expect(screen.getByText(/abc123def456/)).toBeInTheDocument();
  });

  it('shows no evidence lines for a pending signer', async () => {
    mockEnvelope(envelope({ signers: [signer({ email: 'a@x.com', status: 'pending' })] }));
    renderPage();
    await screen.findByText('Signers');
    expect(screen.queryByText(/selector/)).toBeNull();
  });
});

describe('post-send success banner (Barry QA 2026-06-19)', () => {
  it('arriving with justSent state shows a green "sent successfully" banner + jumps to the top', async () => {
    const scrollSpy = vi.fn();
    window.scrollTo = scrollSpy as unknown as typeof window.scrollTo;
    mockEnvelope(envelope({ status: 'active' }));
    render(
      <MemoryRouter initialEntries={[{ pathname: '/dashboard/envelope/env_1', state: { justSent: true } }]}>
        <Routes>
          <Route path="/dashboard/envelope/:id" element={<EnvelopeDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/sent successfully/i)).toBeInTheDocument();
    expect(scrollSpy).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  });

  it('does NOT show the sent banner on a normal visit (no justSent state)', async () => {
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    mockEnvelope(envelope({ status: 'active' }));
    renderPage();
    await screen.findByText('Signers');
    expect(screen.queryByText(/sent successfully/i)).toBeNull();
  });
});

describe('finalizing ("manufacturing") state + spam notice (Barry QA 2026-06-21)', () => {
  const bothSignedAuto = () => envelope({ status: 'active', auto_close: true, signers: [
    signer({ email: 'a@x.com', status: 'signed', signed_at: new Date().toISOString() }),
    signer({ email: 'b@x.com', status: 'signed', signed_at: new Date().toISOString() }),
  ] });

  it('shows the spam-folder notice while a signer is still pending', async () => {
    mockEnvelope(envelope({ status: 'active', auto_close: true, signers: [
      signer({ email: 'a@x.com', status: 'signed', signed_at: new Date().toISOString() }),
      signer({ email: 'b@x.com', status: 'pending' }),
    ] }));
    renderPage();
    expect(await screen.findByText(/check their spam folder/i)).toBeInTheDocument();
  });

  it('the spam notice VANISHES the moment everyone has signed (AUTO)', async () => {
    mockEnvelope(bothSignedAuto());
    renderPage();
    await screen.findByText('Signers');
    expect(screen.queryByText(/check their spam folder/i)).toBeNull();
  });

  it('the spam notice VANISHES when all-signed in MANUAL mode too', async () => {
    mockEnvelope(envelope({ status: 'active', auto_close: false, signers: [
      signer({ email: 'a@x.com', status: 'signed', signed_at: new Date().toISOString() }),
    ] }));
    renderPage();
    await screen.findByText('Signers');
    expect(screen.queryByText(/check their spam folder/i)).toBeNull();
  });

  it('an AUTO all-signed envelope shows the "assembling your signing record" finalizing notice + a "finalizing" badge', async () => {
    mockEnvelope(bothSignedAuto());
    renderPage();
    expect(await screen.findByText(/assembling your signing record/i)).toBeInTheDocument();
    expect(screen.getByText('finalizing')).toBeInTheDocument();
  });

  it('an AUTO all-signed (finalizing) envelope HIDES Edit / Delete / + Add signer', async () => {
    mockEnvelope(bothSignedAuto());
    renderPage();
    await screen.findByText('Signers');
    expect(screen.queryByRole('button', { name: /\+ add signer/i })).toBeNull();
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('Delete')).toBeNull();
  });

  it('a MANUAL all-signed envelope shows the "review & seal" notice + a "ready to seal" badge, and KEEPS edit controls (edit-until-seal)', async () => {
    mockEnvelope(envelope({ status: 'active', auto_close: false, signers: [
      signer({ email: 'a@x.com', status: 'signed', signed_at: new Date().toISOString() }),
    ] }));
    renderPage();
    expect(await screen.findByText(/review the signatures/i)).toBeInTheDocument();
    expect(screen.getByText('ready to seal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /seal & send/i })).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('once the record is delivered: no finalizing notice, no spam notice, the delivered banner shows', async () => {
    mockEnvelope(envelope({ status: 'completed', auto_close: true,
      completion_distributed_at: new Date().toISOString(),
      signers: [signer({ email: 'a@x.com', status: 'signed', signed_at: new Date().toISOString() })] }));
    renderPage();
    expect(await screen.findByText(/signing record delivered/i)).toBeInTheDocument();
    expect(screen.queryByText(/assembling your signing record/i)).toBeNull();
    expect(screen.queryByText(/check their spam folder/i)).toBeNull();
  });
});

// UX-019..023 (Cycle-7 authenticated visual QA) — mobile tap target + WCAG-AA contrast
// + a legible eml-hash font. Same min-h-[44px] / text-gray-600 conventions as the rest of the app.
describe('EnvelopeDetailPage — visual QA: tap target + contrast + font size (UX-019..023)', () => {
  it('the back link gets a >=44px mobile tap target and a darkened resting contrast (UX-019 / UX-020)', async () => {
    mockEnvelope(envelope());
    renderPage();
    const back = await screen.findByRole('link', { name: /dashboard/i });
    expect(back.className).toMatch(/min-h-\[44px\]/);
    expect(back.className).not.toMatch(/text-gray-400/); // resting colour darkened from the flagged gray-400
  });

  it('uses no low-contrast text-gray-400 / text-red-400 anywhere in the rendered page (UX-020 / UX-021 / UX-022)', async () => {
    mockEnvelope(envelope()); // open envelope → signer emails + Delete controls render
    const { container } = renderPage();
    await screen.findByText('Signers');
    expect(container.innerHTML).not.toContain('text-gray-400');
    expect(container.innerHTML).not.toContain('text-red-400');
  });

  it('renders the .eml SHA-256 at >=12px, not the old 11px (UX-023)', async () => {
    mockEnvelope(envelope({ signers: [signer({
      email: 'a@x.com', name: 'Alice', status: 'signed', signed_at: new Date().toISOString(),
      signing_domain: 'gmail.com', signing_selector: '20251104', eml_sha256: 'abc123def456',
    })] }));
    const { container } = renderPage();
    const hashEl = await screen.findByText(/abc123def456/);
    expect(hashEl.className).toContain('text-xs'); // 12px
    expect(hashEl.className).not.toContain('text-[11px]');
    expect(container.innerHTML).not.toContain('text-[11px]');
  });
});
