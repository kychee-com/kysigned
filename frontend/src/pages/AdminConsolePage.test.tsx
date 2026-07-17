/**
 * AdminConsolePage.test — the F-34 operator console shell (#148).
 *
 * A tabbed console (Overview / Accounts / Envelopes / Reconciliation) with one
 * global time-window selector. Verifies: the window param rides every fetch and
 * switching it re-fetches (AC-182); Overview KPIs render (AC-183); the Accounts
 * tab renders the Human/Agent + Programmatic badges (AC-184/185); and a 403 from
 * the operator gate shows the access-denied view instead of data (AC-179).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminConsolePage } from './AdminConsolePage';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockFetchByPath(handlers: Record<string, unknown>) {
  return vi.fn((url: string) => {
    const path = new URL(url, 'https://x').pathname;
    const body = handlers[path];
    if (body === 403) {
      return Promise.resolve(new Response(JSON.stringify({ code: 'auth_operator_scope' }), { status: 403 }));
    }
    return Promise.resolve(new Response(JSON.stringify(body ?? {}), { status: 200 }));
  });
}

const overview = {
  window: '30d', accountsOpened: 3,
  envelopes: { created: 5, completed: 2, inProcess: 3 },
  credits: { paidInUsdMicros: '250000', grantedUsdMicros: '1000000', consumedUsdMicros: '250000' },
  activeUsers: { dau: 1, wau: 2, mau: 4 },
};
const accounts = {
  window: '30d',
  accounts: [
    { email: 'w@x.com', kind: 'agent', walletFunded: true, programmatic: false, envelopes: { created: 1, completed: 0, inProcess: 1 }, balanceUsdMicros: '250000', lastSeen: null, joined: '2026-07-14T00:00:00Z' },
    { email: 'p@x.com', kind: 'human', walletFunded: false, programmatic: true, envelopes: { created: 2, completed: 1, inProcess: 1 }, balanceUsdMicros: '900000', lastSeen: '2026-07-16T00:00:00Z', joined: '2026-07-10T00:00:00Z' },
  ],
};

describe('AdminConsolePage (F-34, #148)', () => {
  it('renders the Overview KPIs by default with the window param on the fetch (AC-182/183)', async () => {
    const fetchMock = mockFetchByPath({ '/v1/admin/overview': overview });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><AdminConsolePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-kpi-accountsOpened')).toHaveTextContent('3'));
    // the Overview tab fetches with the default window (a preceding call is the shell access probe)
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('window=30d'))).toBe(true);
  });

  it('switching the window re-fetches with the new window (AC-182)', async () => {
    const fetchMock = mockFetchByPath({ '/v1/admin/overview': overview });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><AdminConsolePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-kpi-accountsOpened')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('admin-window-7d'));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('window=7d'))).toBe(true));
  });

  it('the Accounts tab renders the Human/Agent + Programmatic badges (AC-184/185)', async () => {
    vi.stubGlobal('fetch', mockFetchByPath({ '/v1/admin/overview': overview, '/v1/admin/accounts': accounts }));
    render(<MemoryRouter><AdminConsolePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-kpi-accountsOpened')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('admin-tab-accounts'));
    await waitFor(() => expect(screen.getByText('w@x.com')).toBeInTheDocument());
    expect(screen.getByTestId('admin-account-badge-w@x.com')).toHaveTextContent(/Agent/);
    expect(screen.getByTestId('admin-account-badge-p@x.com')).toHaveTextContent(/Human/);
    expect(screen.getByTestId('admin-account-programmatic-p@x.com')).toBeInTheDocument();
  });

  it('the Signals tab surfaces deliverability + agent-adoption (AC-187)', async () => {
    const signals = { window: '30d', deliverability: { invited: 4, signed: 3, undeliverable: 1 }, agentAdoption: { walletCreates: 2, humanCreates: 5, apiKeyHolders: 1 } };
    vi.stubGlobal('fetch', mockFetchByPath({ '/v1/admin/overview': overview, '/v1/admin/signals': signals }));
    render(<MemoryRouter><AdminConsolePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-kpi-accountsOpened')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('admin-tab-signals'));
    await waitFor(() => expect(screen.getByTestId('admin-signals')).toBeInTheDocument());
    expect(screen.getByTestId('admin-kpi-delivUndeliverable')).toHaveTextContent('1');
    expect(screen.getByTestId('admin-kpi-walletCreates')).toHaveTextContent('2');
  });

  it('a 403 shows ONLY the access-denied message — no console chrome (AC-179)', async () => {
    vi.stubGlobal('fetch', mockFetchByPath({ '/v1/admin/overview': 403 }));
    render(<MemoryRouter><AdminConsolePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-denied')).toBeInTheDocument());
    // A non-operator sees the message alone — no title/tabs/window selector/data.
    expect(screen.queryByTestId('admin-console')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-tab-accounts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-window-7d')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-kpi-accountsOpened')).not.toBeInTheDocument();
  });
});

describe('AdminConsolePage — F-35 exclude-internal toggle (#148)', () => {
  it('renders the toggle checked by default; every fetch carries exclude_internal=1 (AC-188)', async () => {
    const fetchMock = mockFetchByPath({ '/v1/admin/overview': overview });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><AdminConsolePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-kpi-accountsOpened')).toBeInTheDocument());
    expect(screen.getByTestId('admin-exclude-internal-input')).toBeChecked();
    // the Overview tab fetch (not the shell access-probe) carries the default-on param
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('exclude_internal=1'))).toBe(true);
  });

  it('unchecking the toggle re-fetches with exclude_internal=0 (AC-189)', async () => {
    const fetchMock = mockFetchByPath({ '/v1/admin/overview': overview });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><AdminConsolePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-kpi-accountsOpened')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('admin-exclude-internal-input'));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('exclude_internal=0'))).toBe(true));
  });

  it('the reconciliation tab fetch also carries the toggle (AC-190)', async () => {
    const fetchMock = mockFetchByPath({ '/v1/admin/overview': overview, '/v1/admin/archive-confirmations': { outstanding: [] } });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><AdminConsolePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-kpi-accountsOpened')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('admin-tab-reconciliation'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (c) => String(c[0]).includes('/v1/admin/archive-confirmations') && String(c[0]).includes('exclude_internal='),
        ),
      ).toBe(true),
    );
  });
});
