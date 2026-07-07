/**
 * DashboardPage.test.tsx — F-11.1 / AC-30 list display.
 *
 * The envelope list shows an Open/Completed/Voided status-summary header, a human
 * "sent" date (NOT a bare hash/UUID — GH#26), affirmative-green signed counts
 * (GH#2), and colour-coded status badges in the expanded per-envelope rows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({ apiGetMock: vi.fn(), apiPostMock: vi.fn() }));
vi.mock('../lib/api', () => ({
  apiGet: apiGetMock,
  apiPost: apiPostMock,
  formatUsd: (n: number) => `$${(n / 1e6).toFixed(2)}`,
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { email: 'creator@acme.com', display_name: 'Creator' }, loading: false }),
}));

import { DashboardPage } from './DashboardPage';

const DOCS = [
  { documentHash: 'a'.repeat(64), documentName: 'NDA', totalSigners: 2, signedCount: 2, envelopes: [
    { id: 'env-uuid-1111', status: 'completed', created_at: '2026-06-10T00:00:00Z', completed_at: '2026-06-12T00:00:00Z' },
  ] },
  { documentHash: 'b'.repeat(64), documentName: 'MSA', totalSigners: 3, signedCount: 1, envelopes: [
    { id: 'env-uuid-2222', status: 'active', created_at: '2026-06-11T00:00:00Z', completed_at: null },
  ] },
  { documentHash: 'c'.repeat(64), documentName: 'Old', totalSigners: 1, signedCount: 0, envelopes: [
    { id: 'env-uuid-3333', status: 'voided', created_at: '2026-06-09T00:00:00Z', completed_at: null },
  ] },
];

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  // GH#108 — billing/balance is [service]/private (config-gated `showBilling`).
  // Default the suite to billing-ON (kysigned.com) so the balance/checkout
  // assertions run; the fork-default (billing off) is its own describe below.
  vi.stubEnv('VITE_OPERATOR_CONFIG', JSON.stringify({ showBilling: true }));
  apiGetMock.mockImplementation((url: string) =>
    url.startsWith('/v1/documents')
      ? Promise.resolve(DOCS)
      : Promise.resolve({ balance_usd_micros: 5_000_000, envelope_cost_usd_micros: 250_000, sufficient_for_envelope: true }),
  );
});

afterEach(() => vi.unstubAllEnvs());

const renderPage = () => render(<MemoryRouter><DashboardPage /></MemoryRouter>);

describe('DashboardPage — list display (AC-30)', () => {
  it('shows the Open/Completed/Voided status-summary header', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('NDA')).toBeInTheDocument());
    expect(screen.getByText('Open: 1')).toBeInTheDocument();
    expect(screen.getByText('Completed: 1')).toBeInTheDocument();
    expect(screen.getByText('Voided: 1')).toBeInTheDocument();
  });

  it('shows a human sent-date and NO bare hash/UUID in the rows', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('NDA')).toBeInTheDocument());
    expect(container.textContent).toMatch(/Sent /);
    expect(container.textContent).not.toContain('aaaaaaaaaaaa'); // no 64-hex doc hash
    expect(container.textContent).not.toContain('env-uuid'); // no bare envelope UUID
  });

  it('renders the signed count affirmative-green when there is progress', async () => {
    renderPage();
    const el = await screen.findByText(/2\/2 signed/);
    expect(el.className).toMatch(/text-green-700/);
  });

  it('colour-codes the status badge in the expanded rows', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('NDA')).toBeInTheDocument());
    fireEvent.click(screen.getByText('NDA'));
    const badge = await screen.findByText('Completed'); // the badge (header reads "Completed: 1")
    expect(badge.className).toMatch(/bg-green-50/);
  });
});

describe('DashboardPage — prominent balance (Barry QA 2026-06-17)', () => {
  it('shows the balance up top in dollars, with how many envelopes it covers', async () => {
    renderPage();
    expect(await screen.findByText('Your balance')).toBeInTheDocument();
    expect(screen.getByText('$5.00')).toBeInTheDocument(); // dollar balance, not raw micros
    // $5.00 / $0.25 = 20 envelopes
    expect(screen.getByText(/≈ 20 envelopes left/)).toBeInTheDocument();
  });

  it('a balance too small for one envelope reads as "Not enough to send"', async () => {
    apiGetMock.mockImplementation((url: string) =>
      url.startsWith('/v1/documents')
        ? Promise.resolve([])
        : Promise.resolve({ balance_usd_micros: 0, envelope_cost_usd_micros: 250_000, sufficient_for_envelope: false }),
    );
    renderPage();
    expect(await screen.findByText('Your balance')).toBeInTheDocument();
    expect(screen.getByText('$0.00')).toBeInTheDocument();
    expect(screen.getByText(/Not enough to send/)).toBeInTheDocument();
  });

  it('Add credits starts Stripe checkout for the signed-in email', async () => {
    apiPostMock.mockResolvedValue({ url: 'https://checkout.stripe.test/s/1' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /add credits/i }));
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith('/v1/credits/checkout', { email: 'creator@acme.com' }),
    );
  });
});

describe('DashboardPage — new-account trial offer (F-14.8 / AC-98)', () => {
  it('surfaces the no-credit-card offer in the empty state when a brand-new account holds grant credit', async () => {
    apiGetMock.mockImplementation((url: string) =>
      url.startsWith('/v1/documents')
        ? Promise.resolve([]) // brand-new account → no documents
        : Promise.resolve({ balance_usd_micros: 1_000_000, envelope_cost_usd_micros: 250_000, sufficient_for_envelope: true }),
    );
    renderPage();
    // $1.00 / $0.25 = 4 envelopes — surfaced in both the empty-state offer and the balance pill.
    expect(await screen.findByText(/No credit card needed/)).toBeInTheDocument();
    expect(screen.getByText(/≈ 4 envelopes left/)).toBeInTheDocument();
    // The New Envelope CTA is a live link (not the disabled top-up button).
    expect(screen.getByRole('link', { name: /new envelope/i })).toBeInTheDocument();
  });

  it('falls back to the plain empty state when the account has no credit', async () => {
    apiGetMock.mockImplementation((url: string) =>
      url.startsWith('/v1/documents')
        ? Promise.resolve([])
        : Promise.resolve({ balance_usd_micros: 0, envelope_cost_usd_micros: 250_000, sufficient_for_envelope: false }),
    );
    const { container } = renderPage();
    expect(await screen.findByText('No documents yet.')).toBeInTheDocument();
    // UX-017 — the empty-state hint copy must not use the low-contrast gray-400.
    expect(container.innerHTML).not.toContain('text-gray-400');
  });
});

// UX-015..018 (Cycle-7 authenticated visual QA) — mobile tap targets + WCAG-AA contrast.
// Matches the established min-h-[44px] / text-gray-600 conventions (AppHeader / SigningPage).
describe('DashboardPage — visual QA: tap targets + contrast (UX-015..018)', () => {
  it('gives the primary actions a >=44px mobile tap target (UX-015 / UX-016)', async () => {
    renderPage();
    const addCredits = await screen.findByRole('button', { name: /add credits/i });
    expect(addCredits.className).toMatch(/min-h-\[44px\]/); // UX-016
    const newEnvelope = screen.getByRole('link', { name: /new envelope/i });
    expect(newEnvelope.className).toMatch(/min-h-\[44px\]/); // UX-015 (live link)
  });

  it('reserves the >=44px target even on the disabled New-Envelope button (UX-015)', async () => {
    apiGetMock.mockImplementation((url: string) =>
      url.startsWith('/v1/documents')
        ? Promise.resolve(DOCS)
        : Promise.resolve({ balance_usd_micros: 0, envelope_cost_usd_micros: 250_000, sufficient_for_envelope: false }),
    );
    renderPage();
    const disabled = await screen.findByRole('button', { name: /new envelope/i });
    expect(disabled.className).toMatch(/min-h-\[44px\]/);
  });

  it('uses no low-contrast text-gray-400 anywhere in the rendered dashboard (UX-017 / UX-018)', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('NDA')).toBeInTheDocument());
    fireEvent.click(screen.getByText('NDA')); // expand a group so the per-envelope metadata rows render
    await screen.findByText('Completed');
    expect(container.innerHTML).not.toContain('text-gray-400');
  });
});

// UX-024 (Cycle-8) — the insufficient-balance "New Envelope" control was styled to look
// disabled (grey `bg-gray-200 text-gray-500`) but was NOT a real disabled control
// (`disabled:false`, `aria-disabled:null`, `tabIndex:0`), so it did not qualify for the
// WCAG 1.4.3 disabled-control contrast exemption and axe flagged `color-contrast`
// (Firefox + WebKit). Fix option A: make it a genuinely disabled control so semantics
// match appearance and the exemption applies (axe skips disabled controls for contrast).
describe('DashboardPage — insufficient balance New-Envelope is genuinely disabled (UX-024)', () => {
  beforeEach(() => {
    apiGetMock.mockImplementation((url: string) =>
      url.startsWith('/v1/documents')
        ? Promise.resolve(DOCS)
        : Promise.resolve({ balance_usd_micros: 0, envelope_cost_usd_micros: 250_000, sufficient_for_envelope: false }),
    );
  });

  it('exposes the control as truly disabled (real disabled attr + aria-disabled, out of tab order)', async () => {
    renderPage();
    const btn = await screen.findByRole('button', { name: /new envelope/i });
    // Real disabled control ⇒ WCAG-exempt ⇒ axe color-contrast no longer applies.
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('tabindex', '-1'); // removed from the tab order (not focusable)
    // In this state it must be the disabled button, never a live navigable link.
    expect(screen.queryByRole('link', { name: /new envelope/i })).not.toBeInTheDocument();
  });

  it('does not navigate or act when activated (click is blocked)', async () => {
    renderPage();
    const btn = await screen.findByRole('button', { name: /new envelope/i });
    fireEvent.click(btn); // a genuinely disabled button fires no handler
    // No create-route link appears and no error banner is raised by the click.
    expect(screen.queryByRole('link', { name: /new envelope/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/You need credits/i)).not.toBeInTheDocument();
  });

  it('carries no em-dash in its tooltip copy (outbound-writing rule)', async () => {
    renderPage();
    const btn = await screen.findByRole('button', { name: /new envelope/i });
    const title = btn.getAttribute('title') ?? '';
    expect(title).not.toMatch(/[—–]/);
  });
});

// GH#108 — billing/balance is private. A fork (no `showBilling` config) must show
// NO balance/top-up surfaces and must never hit the proprietary /v1/credits endpoint.
describe('DashboardPage — fork default: billing/balance hidden (GH#108)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_OPERATOR_CONFIG', JSON.stringify({ showBilling: false }));
  });

  it('shows no balance or Add-credits and never reads /v1/credits on a fork', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('NDA')).toBeInTheDocument());
    expect(screen.queryByText('Your balance')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add credits/i })).not.toBeInTheDocument();
    // The credit endpoint is never touched.
    expect(apiGetMock.mock.calls.every(([u]) => !String(u).startsWith('/v1/credits'))).toBe(true);
    // New Envelope stays a live link (no credit gate on a fork).
    expect(screen.getByRole('link', { name: /new envelope/i })).toBeInTheDocument();
  });
});
