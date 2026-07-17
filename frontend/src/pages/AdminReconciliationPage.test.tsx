/**
 * AdminReconciliationPage.test.tsx — the `/admin` operator dashboard (F-33.2/F-33.3, #148).
 *
 * The page reads the operator-gated GET /v1/admin/archive-confirmations. A 200
 * renders the outstanding backlog; a 403 (the server-side operator gate refusing a
 * non-operator session, F-33.1) renders an access-denied notice INSTEAD of the data,
 * so a signed-in non-operator cannot view the operator view (AC-179).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminReconciliationPage } from './AdminReconciliationPage';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sample = {
  outstanding: [
    {
      envelope_id: 'env-9',
      signer_email: 'signer@x.com',
      dkim_domain: 'x.com',
      dkim_selector: 'sel',
      state: 'outage',
      checked_at: '2026-07-16T08:00:00Z',
      healed_at: null,
      created_at: '2026-07-15T08:00:00Z',
    },
  ],
};

describe('AdminReconciliationPage (F-33.2/F-33.3, #148)', () => {
  it('renders the outstanding reconciliation rows for an operator (200)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(sample), { status: 200 }))));
    render(<MemoryRouter><AdminReconciliationPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-row-env-9')).toBeInTheDocument());
    expect(screen.getByText('signer@x.com')).toBeInTheDocument();
    expect(screen.getByText('outage')).toBeInTheDocument();
  });

  it('shows an access-denied notice — NOT the data — when the operator gate refuses (403) (AC-179)', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'Operator access required', code: 'auth_operator_scope' }), { status: 403 }),
      ),
    ));
    render(<MemoryRouter><AdminReconciliationPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-denied')).toBeInTheDocument());
    expect(screen.queryByTestId('admin-reconciliation-page')).not.toBeInTheDocument();
  });

  it('shows an empty state when nothing is outstanding', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ outstanding: [] }), { status: 200 }))));
    render(<MemoryRouter><AdminReconciliationPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-empty')).toBeInTheDocument());
  });
});
