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
  last_rejection?: { class: string; at: string } | null;
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
    expect(await screen.findByRole('button', { name: /cancel document/i })).toBeDisabled();
  });

  it('keeps Cancel enabled while a signer is still pending', async () => {
    mockEnvelope(envelope({ status: 'active', auto_close: true, signers: [
      signer({ email: 'a@x.com', status: 'signed', signed_at: new Date().toISOString() }),
      signer({ email: 'b@x.com', status: 'pending' }),
    ] }));
    renderPage();
    expect(await screen.findByRole('button', { name: /cancel document/i })).toBeEnabled();
  });

  it('keeps Cancel enabled in MANUAL-seal mode even when all-signed (creator can still cancel before sealing)', async () => {
    mockEnvelope(envelope({ status: 'awaiting_seal', auto_close: false, signers: [
      signer({ email: 'a@x.com', status: 'signed', signed_at: new Date().toISOString() }),
    ] }));
    renderPage();
    expect(await screen.findByRole('button', { name: /cancel document/i })).toBeEnabled();
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

// F-45.5 / AC-275 — a signer whose last forward was rejected is visibly blocked,
// with the plain reason, what to tell them, and the change-address option.
describe('needs-attention state (F-45.5 / AC-275)', () => {
  const AT = new Date('2026-09-23T10:00:00Z').toISOString();
  const EM_DASH = String.fromCodePoint(0x2014);
  const EN_DASH = String.fromCodePoint(0x2013);

  it('Google Workspace no-DKIM: badge, admin/DKIM guidance, the Google FAQ link (44px), and the change-address hint', async () => {
    mockEnvelope(envelope({
      signers: [signer({ email: 'a@x.com', name: 'Alice', last_rejection: { class: 'google_workspace_no_dkim', at: AT } })],
    }));
    renderPage();
    expect(await screen.findByText('needs attention')).toBeInTheDocument();
    expect(screen.queryByText('pending')).toBeNull();
    const block = screen.getByTestId('signer-attention');
    expect(block.textContent).toMatch(/Google Workspace/);
    expect(block.textContent).toMatch(/DKIM/);
    expect(block.textContent).toMatch(/different address/i);
    expect(block.textContent).toMatch(/Edit/);
    const link = screen.getByRole('link', { name: /how to switch it on/i });
    expect(link.getAttribute('href')).toBe('/faq#email-setup-google');
    expect(link.className).toMatch(/min-h-\[44px\]/);
    expect(block.textContent!.includes(EM_DASH) || block.textContent!.includes(EN_DASH)).toBe(false);
  });

  it('a self-fixable class shows what went wrong and that the signer was already told', async () => {
    mockEnvelope(envelope({
      signers: [signer({ email: 'a@x.com', name: 'Alice', last_rejection: { class: 'wrong_phrase', at: AT } })],
    }));
    renderPage();
    const block = await screen.findByTestId('signer-attention');
    expect(block.textContent).toMatch(/didn.t start with .I sign this document./);
    expect(block.textContent).toMatch(/already emailed them/);
    expect(screen.queryByRole('link', { name: /how to switch it on/i })).toBeNull();
  });

  it('a re-requested (superseded) signer with a rejection needs attention too', async () => {
    mockEnvelope(envelope({
      signers: [signer({ email: 'a@x.com', name: 'Alice', status: 'superseded', last_rejection: { class: 'microsoft_365_no_dkim', at: AT } })],
    }));
    renderPage();
    expect(await screen.findByText('needs attention')).toBeInTheDocument();
    expect(screen.queryByText('awaiting re-sign')).toBeNull();
    expect(screen.getByRole('link', { name: /how to switch it on/i }).getAttribute('href')).toBe('/faq#email-setup-microsoft');
  });

  it('no rejection → no needs-attention state', async () => {
    mockEnvelope(envelope());
    renderPage();
    await screen.findByText('Signers');
    expect(screen.queryByText('needs attention')).toBeNull();
    expect(screen.queryByTestId('signer-attention')).toBeNull();
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

// FC32.1 (UX-039/UX-040/UX-041 + BT-32.1, system-test cycle 32): every control on this page
// reaches 44x44 on a phone in EVERY state, not only the three the sweep named. The scanner
// reports one offender per tag + first class (so "Cancel document" and "Delete" hid behind
// UX-039/UX-041) and only sees the state it loads (the add, edit and seal states were never
// on screen), so this lock walks all five states and checks every control, with no dedup.
// The minimums are md-gated because F-11.3 / AC-84 keep the desktop layout unchanged.
// This is the class-level tripwire only; the binding proof is real geometry in a real
// browser (toolbelt/envelope-detail-design-probe.mjs, FC32.2).
describe('EnvelopeDetailPage — every control reaches 44x44 on a phone, in every state (UX-039..041, FC32.1)', () => {
  const AT = new Date('2026-09-23T10:00:00Z').toISOString();
  const SIGNED_AT = new Date('2026-09-23T11:00:00Z').toISOString();
  const openWithAttention = () =>
    envelope({
      status: 'active',
      auto_close: true,
      signers: [
        signer({ email: 'blocked@x.com', name: 'Blocked Signer', last_rejection: { class: 'google_workspace_no_dkim', at: AT } }),
        signer({ email: 'plain@x.com', name: 'Plain Signer' }),
      ],
    });
  const allSigned = (over: Record<string, unknown>) =>
    envelope({
      signers: [
        signer({ email: 'a@x.com', name: 'Alice', status: 'signed', signed_at: SIGNED_AT }),
        signer({ email: 'b@x.com', name: 'Bob', status: 'signed', signed_at: SIGNED_AT }),
      ],
      ...over,
    });

  /** Every control that lacks the md-gated minimums, named so a failure says which one. */
  function controlsWithoutTapToken(root: HTMLElement): string[] {
    const has = (el: Element, ...classes: string[]) => classes.every((c) => el.classList.contains(c));
    const describeEl = (el: Element) => {
      const input = el as HTMLInputElement;
      const label = (el.textContent || input.placeholder || input.value || input.type || '').trim().slice(0, 40);
      return `<${el.tagName.toLowerCase()}> "${label}"`;
    };
    const missing: string[] = [];
    root.querySelectorAll('button').forEach((el) => {
      if (!has(el, 'min-h-[44px]', 'md:min-h-0', 'min-w-[44px]', 'md:min-w-0')) missing.push(describeEl(el));
    });
    root.querySelectorAll('input').forEach((el) => {
      if (['checkbox', 'radio', 'hidden'].includes(el.type)) return; // the wrapping label is the tap target
      if (!has(el, 'min-h-[44px]', 'md:min-h-0')) missing.push(describeEl(el));
    });
    root.querySelectorAll('label').forEach((el) => {
      if (!el.querySelector('input[type="checkbox"]')) return;
      if (!has(el, 'min-h-[44px]', 'md:min-h-0')) missing.push(describeEl(el));
    });
    root.querySelectorAll('a').forEach((el) => {
      if (!has(el, 'min-h-[44px]', 'md:min-h-0')) missing.push(describeEl(el));
    });
    return missing;
  }

  it('S1 open with a needs-attention signer: Add, Edit and Delete per signer, Send Reminders, Cancel, the FAQ and back links', async () => {
    mockEnvelope(openWithAttention());
    const { container } = renderPage();
    await screen.findByText('needs attention');
    // Non-vacuous: every control this state must show is on screen before the lock runs.
    expect(screen.getByRole('button', { name: /\+ add signer/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^edit$/i })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^delete$/i })).toHaveLength(2);
    expect(screen.getByRole('button', { name: /send reminders/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel document/i })).toBeEnabled();
    expect(screen.getByRole('link', { name: /how to switch it on/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
    expect(controlsWithoutTapToken(container)).toEqual([]);
  });

  it('S2 the add-signer form, on-behalf ticked: its inputs, the checkbox label, Add & send request, Cancel', async () => {
    mockEnvelope(openWithAttention());
    const { container } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /\+ add signer/i }));
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByPlaceholderText('Full name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('email@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Organisation name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add & send request/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
    expect(controlsWithoutTapToken(container)).toEqual([]);
  });

  it('S3 the edit form on the needs-attention signer, on-behalf ticked: its inputs, the checkbox label, Save & resend, Cancel', async () => {
    mockEnvelope(openWithAttention());
    const { container } = renderPage();
    await screen.findByText('needs attention');
    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0]!);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByPlaceholderText('Organisation name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save & resend/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
    // The other signer keeps its own Edit and Delete while this one is being edited.
    expect(screen.getAllByRole('button', { name: /^edit$/i })).toHaveLength(1);
    expect(controlsWithoutTapToken(container)).toEqual([]);
  });

  it('S4 manual seal, all signed: Seal & send, the kept edit controls, Cancel document', async () => {
    mockEnvelope(allSigned({ status: 'awaiting_seal', auto_close: false }));
    const { container } = renderPage();
    expect(await screen.findByRole('button', { name: /seal & send/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^edit$/i })).toHaveLength(2);
    expect(screen.getByRole('button', { name: /cancel document/i })).toBeEnabled();
    expect(controlsWithoutTapToken(container)).toEqual([]);
  });

  it('S5 auto-close, all signed, finalizing: the disabled Cancel document', async () => {
    mockEnvelope(allSigned({ status: 'active', auto_close: true }));
    const { container } = renderPage();
    expect(await screen.findByRole('button', { name: /cancel document/i })).toBeDisabled();
    expect(controlsWithoutTapToken(container)).toEqual([]);
  });

  it('BT-32.3: the loading spinner is replaced by a NEW page container, never reused as it (desktop layout shift)', async () => {
    // React reused the full-width spinner <div> as the centred max-w-3xl column, so on a
    // desktop the SAME node jumped from x=0 to the centre: a layout shift of about 0.21 on
    // every load (measured by the FC32.2 probe). A fresh node is not a layout shift.
    let resolveEnvelope: (value: unknown) => void = () => {};
    apiGetMock.mockImplementation(() => new Promise((resolve) => { resolveEnvelope = resolve; }));
    const { container } = renderPage();
    const loadingRoot = container.firstElementChild as HTMLElement;
    expect(loadingRoot.querySelector('.animate-spin')).not.toBeNull();
    resolveEnvelope(openWithAttention());
    await screen.findByText('Signers');
    expect(loadingRoot.isConnected).toBe(false);
    expect(container.firstElementChild).not.toBe(loadingRoot);
  });

  it('BT-32.1: the edit form names its two text inputs through their labels, with ids unique per signer row', async () => {
    mockEnvelope(openWithAttention());
    renderPage();
    await screen.findByText('needs attention');
    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0]!);
    const firstName = screen.getByLabelText('Full name') as HTMLInputElement;
    const firstEmail = screen.getByLabelText(/^Email/) as HTMLInputElement;
    expect(firstName.value).toBe('Blocked Signer');
    expect(firstEmail.value).toBe('blocked@x.com');
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[1]!);
    const secondName = screen.getByLabelText('Full name') as HTMLInputElement;
    const secondEmail = screen.getByLabelText(/^Email/) as HTMLInputElement;
    expect(secondName.value).toBe('Plain Signer');
    expect(secondEmail.value).toBe('plain@x.com');
    expect(new Set([firstName.id, firstEmail.id, secondName.id, secondEmail.id]).size).toBe(4);
  });
});
