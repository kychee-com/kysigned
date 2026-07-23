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
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AdminConsolePage } from './AdminConsolePage';

/** Renders the live location query string so a test can assert the URL was updated. */
function LocationSpy() {
  return <span data-testid="loc-search">{useLocation().search}</span>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // F-34.7: the console now PERSISTS its view (tab/window/toggle) to localStorage,
  // so each test must start from a clean slate — otherwise one test's last view
  // seeds the next one and it no longer opens on the defaults.
  try { localStorage.clear(); } catch { /* jsdom always provides it; be defensive */ }
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
  activeUsers: 4, // F-34.2: one window-scoped figure, not DAU/WAU/MAU bands
};
const accounts = {
  window: '30d',
  accounts: [
    { email: 'w@x.com', kind: 'agent', walletFunded: true, programmatic: false, envelopes: { created: 1, completed: 0, inProcess: 1 }, balanceUsdMicros: '250000', lastSeen: null, joined: '2026-07-14T00:00:00Z' },
    { email: 'p@x.com', kind: 'human', walletFunded: false, programmatic: true, envelopes: { created: 2, completed: 1, inProcess: 1 }, balanceUsdMicros: '900000', lastSeen: '2026-07-16T00:00:00Z', joined: '2026-07-10T00:00:00Z' },
  ],
};

describe('AdminConsolePage (F-34, #148)', () => {
  it('F-34.6/AC-201: clicking the Paid in tile opens the ledger drill-down (group on the fetch), close returns to tiles', async () => {
    const ledger = {
      window: '30d', excludeInternal: true, group: 'paid_in',
      rows: [
        { id: 'l1', email: 'buyer@x.com', delta_usd_micros: '250000', source: 'x402', external_ref: 'txp_1', created_at: '2026-07-18T20:27:25.000Z' },
      ],
    };
    const fetchMock = mockFetchByPath({ '/v1/admin/overview': overview, '/v1/admin/ledger': ledger });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><AdminConsolePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-kpi-paidIn')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('admin-kpi-paidIn'));
    await waitFor(() => expect(screen.getByTestId('admin-ledger')).toBeInTheDocument());
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/admin/ledger') && String(c[0]).includes('group=paid_in')),
    ).toBe(true);
    const panel = screen.getByTestId('admin-ledger');
    expect(panel).toHaveTextContent('buyer@x.com');
    expect(panel).toHaveTextContent('x402');
    expect(panel).toHaveTextContent('txp_1');
    fireEvent.click(screen.getByTestId('admin-ledger-close'));
    await waitFor(() => expect(screen.queryByTestId('admin-ledger')).not.toBeInTheDocument());
  });

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

describe('AdminConsolePage — F-34.8 every tile drills down (AC-203/204)', () => {
  const hAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const funnel = {
    window: '30d', created: 4, completed: 1, completionRate: 0.25, avgTimeToCompleteMs: 86_400_000,
    aging: { lt1d: 1, d1to3: 1, d3to7: 0, gt7d: 0 }, voided: 1, expired: 0,
    list: [
      { id: 'e1', sender_email: 'a@x.com', document_name: 'Doc A', status: 'completed', created_at: hAgo(48), completed_at: hAgo(24) },
      { id: 'e2', sender_email: 'b@x.com', document_name: 'Doc B', status: 'active', created_at: hAgo(2), completed_at: null }, // lt1d
      { id: 'e3', sender_email: 'c@x.com', document_name: 'Doc C', status: 'active', created_at: hAgo(48), completed_at: null }, // 1-3d
      { id: 'e4', sender_email: 'd@x.com', document_name: 'Doc D', status: 'voided', created_at: hAgo(10), completed_at: null },
    ],
  };
  const signals = {
    window: '30d',
    deliverability: { invited: 2, signed: 1, undeliverable: 1 },
    agentAdoption: { walletCreates: 1, humanCreates: 1, apiKeyHolders: 1 },
  };
  const drillRowCount = () => screen.getByTestId('admin-drill-rows').querySelectorAll('tr').length;

  const openEnvelopesTab = async () => {
    const fetchMock = mockFetchByPath({ '/v1/admin/overview': overview, '/v1/admin/envelopes': funnel, '/v1/admin/signals': signals, '/v1/admin/signal-rows': { rows: [] } });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><AdminConsolePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-kpi-accountsOpened')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('admin-tab-envelopes'));
    await waitFor(() => expect(screen.getByTestId('admin-kpi-funnelCreated')).toBeInTheDocument());
    return fetchMock;
  };

  it('every Overview tile is a clickable entry point, not a dead end (AC-203)', async () => {
    vi.stubGlobal('fetch', mockFetchByPath({ '/v1/admin/overview': overview }));
    render(<MemoryRouter><AdminConsolePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-kpi-accountsOpened')).toBeInTheDocument());
    for (const id of ['accountsOpened', 'envelopesCreated', 'envelopesCompleted', 'envelopesInProcess', 'paidIn', 'granted', 'consumed', 'active']) {
      expect(screen.getByTestId(`admin-kpi-${id}`).tagName, `${id} must be clickable`).toBe('BUTTON');
    }
  });

  it('an Envelopes count tile opens exactly the records behind its figure (AC-203)', async () => {
    await openEnvelopesTab();
    fireEvent.click(screen.getByTestId('admin-kpi-funnelCreated'));
    await waitFor(() => expect(screen.getByTestId('admin-drill')).toBeInTheDocument());
    expect(drillRowCount()).toBe(funnel.created); // drill reconciles with the tile
    fireEvent.click(screen.getByTestId('admin-drill-close'));
    await waitFor(() => expect(screen.queryByTestId('admin-drill')).not.toBeInTheDocument());
    expect(screen.getByTestId('admin-kpi-funnelCreated')).toBeInTheDocument(); // grid intact (AC-204)

    fireEvent.click(screen.getByTestId('admin-kpi-funnelCompleted'));
    await waitFor(() => expect(drillRowCount()).toBe(funnel.completed));
  });

  it('the ratio and average tiles open the cohort they are computed over (AC-204)', async () => {
    await openEnvelopesTab();
    fireEvent.click(screen.getByTestId('admin-kpi-funnelRate'));
    await waitFor(() => expect(drillRowCount()).toBe(funnel.created)); // rate → the whole created cohort
    fireEvent.click(screen.getByTestId('admin-drill-close'));
    fireEvent.click(screen.getByTestId('admin-kpi-funnelAvg'));
    await waitFor(() => expect(drillRowCount()).toBe(funnel.completed)); // avg → the completed set
    expect(screen.getByTestId('admin-drill')).toHaveTextContent('Took'); // each row carries its duration
  });

  it('the multi-value aging tile reaches each bucket independently (AC-204)', async () => {
    await openEnvelopesTab();
    for (const b of ['lt1d', 'd1to3', 'd3to7', 'gt7d']) {
      expect(screen.getByTestId(`admin-kpi-funnelAging-${b}`).tagName).toBe('BUTTON');
    }
    fireEvent.click(screen.getByTestId('admin-kpi-funnelAging-lt1d'));
    await waitFor(() => expect(drillRowCount()).toBe(funnel.aging.lt1d));
    expect(screen.getByTestId('admin-drill')).toHaveTextContent('Doc B'); // the <1d in-process one
    fireEvent.click(screen.getByTestId('admin-drill-close'));
    fireEvent.click(screen.getByTestId('admin-kpi-funnelAging-d1to3'));
    await waitFor(() => expect(screen.getByTestId('admin-drill')).toHaveTextContent('Doc C'));
  });

  it('a Signals tile drills through its own gated read with the right group (AC-203)', async () => {
    const fetchMock = mockFetchByPath({ '/v1/admin/overview': overview, '/v1/admin/signals': signals, '/v1/admin/signal-rows': { rows: [] } });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><AdminConsolePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-kpi-accountsOpened')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('admin-tab-signals'));
    await waitFor(() => expect(screen.getByTestId('admin-kpi-delivUndeliverable')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('admin-kpi-delivUndeliverable'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/admin/signal-rows') && String(c[0]).includes('group=undeliverable'))).toBe(true),
    );
  });
});

describe('AdminConsolePage — F-34.7 view-state persistence (AC-202)', () => {
  const VIEW_KEY = 'kysigned.admin.view'; // storage is cleared by the file-level afterEach

  const renderAt = (entry: string) => {
    const fetchMock = mockFetchByPath({ '/v1/admin/overview': overview, '/v1/admin/accounts': accounts });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={[entry]}>
        <AdminConsolePage />
        <LocationSpy />
      </MemoryRouter>,
    );
    return fetchMock;
  };
  const calledWith = (m: ReturnType<typeof mockFetchByPath>, ...parts: string[]) =>
    m.mock.calls.some((c) => parts.every((p) => String(c[0]).includes(p)));

  it('restores tab + window + toggle from the URL, and the tab fetch carries them', async () => {
    const fetchMock = renderAt('/admin?tab=accounts&window=7d&exclude_internal=0');
    await waitFor(() => expect(screen.getByText('w@x.com')).toBeInTheDocument()); // Accounts tab, not Overview
    expect(screen.getByTestId('admin-exclude-internal-input')).not.toBeChecked();
    expect(calledWith(fetchMock, '/v1/admin/accounts', 'window=7d', 'exclude_internal=0')).toBe(true);
  });

  it('a bare /admin restores the last view from localStorage', async () => {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ tab: 'accounts', window: '7d', exclude_internal: '0' }));
    const fetchMock = renderAt('/admin');
    await waitFor(() => expect(screen.getByText('w@x.com')).toBeInTheDocument());
    expect(screen.getByTestId('admin-exclude-internal-input')).not.toBeChecked();
    expect(calledWith(fetchMock, '/v1/admin/accounts', 'window=7d', 'exclude_internal=0')).toBe(true);
  });

  it('a first visit (no params, empty storage) opens on the defaults', async () => {
    const fetchMock = renderAt('/admin');
    await waitFor(() => expect(screen.getByTestId('admin-kpi-accountsOpened')).toBeInTheDocument()); // Overview
    expect(screen.getByTestId('admin-exclude-internal-input')).toBeChecked();
    expect(calledWith(fetchMock, '/v1/admin/overview', 'window=30d', 'exclude_internal=1')).toBe(true);
  });

  it('a garbage tab/window falls back to the defaults instead of breaking the page', async () => {
    const fetchMock = renderAt('/admin?tab=not-a-tab&window=99y');
    await waitFor(() => expect(screen.getByTestId('admin-kpi-accountsOpened')).toBeInTheDocument());
    expect(calledWith(fetchMock, '/v1/admin/overview', 'window=30d')).toBe(true);
  });

  it('changing a control writes both the URL and localStorage', async () => {
    renderAt('/admin');
    await waitFor(() => expect(screen.getByTestId('admin-kpi-accountsOpened')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('admin-window-7d'));
    await waitFor(() => expect(screen.getByTestId('loc-search').textContent).toContain('window=7d'));
    expect(JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}')).toMatchObject({ window: '7d' });
  });
});

// ── F-38.6 / AC-219 — the Funnel tab ─────────────────────────────────────────
describe('AdminConsolePage — Funnel tab (F-38.6)', () => {
  const summary = {
    enabled: true,
    window_days: 30,
    steps: [
      { step: 'landed', event: 'page_view', count: 100 },
      { step: 'clicked_create', event: 'click', count: 40 },
      { step: 'prompt_shown', event: 'signin_prompt', count: 30 },
      { step: 'email_touched', event: 'signin_email_focus', count: 20 },
      { step: 'link_requested', event: 'signin_submit', count: 12 },
      { step: 'link_sent', event: 'send_ok', count: 12 },
      { step: 'link_opened', event: 'link_opened', count: 8 },
      { step: 'session_created', event: 'session_created', count: 7 },
    ],
    by_source: { paid: [60, 20, 15, 10, 6, 6, 4, 3], direct: [40, 20, 15, 10, 6, 6, 4, 4] },
    by_country: { IL: [80, 30, 25, 15, 10, 10, 6, 5], US: [20, 10, 5, 5, 2, 2, 2, 2] },
    home_clicks: { 'cta_create:hero': 33, 'other:faq': 9 },
  };

  it('renders the eight steps in order with counts and the drop between adjacent steps', async () => {
    const fetchMock = mockFetchByPath({ '/v1/admin/overview': overview, '/v1/telemetry/summary': summary });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><AdminConsolePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-tab-funnel')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('admin-tab-funnel'));
    await waitFor(() => expect(screen.getByTestId('admin-funnel')).toBeInTheDocument());
    const rows = screen.getAllByTestId(/admin-funnel-step-/);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toHaveTextContent('landed');
    expect(rows[0]).toHaveTextContent('100');
    // The largest drop (clicked_create: 100 → 40) is visible as a percentage.
    expect(screen.getByTestId('admin-funnel-step-clicked_create')).toHaveTextContent('-60%');
    // Splits + home clicks render.
    expect(screen.getByTestId('admin-funnel-sources')).toHaveTextContent('paid');
    expect(screen.getByTestId('admin-funnel-countries')).toHaveTextContent('IL');
    expect(screen.getByTestId('admin-funnel-home-clicks')).toHaveTextContent('cta_create:hero');
    // The window selector drives the days param.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/telemetry/summary') && String(c[0]).includes('days=30'))).toBe(true);
  });

  it('window selection re-fetches with the mapped days', async () => {
    const fetchMock = mockFetchByPath({ '/v1/admin/overview': overview, '/v1/telemetry/summary': summary });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><AdminConsolePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-tab-funnel')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('admin-tab-funnel'));
    await waitFor(() => expect(screen.getByTestId('admin-funnel')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('admin-window-24h'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/telemetry/summary') && String(c[0]).includes('days=1'))).toBe(true),
    );
  });

  it('a disabled rail renders the telemetry-off notice instead of an empty funnel', async () => {
    const fetchMock = mockFetchByPath({
      '/v1/admin/overview': overview,
      '/v1/telemetry/summary': { enabled: false, window_days: 0, steps: [], by_source: {}, by_country: {}, home_clicks: {} },
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><AdminConsolePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('admin-tab-funnel')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('admin-tab-funnel'));
    await waitFor(() => expect(screen.getByTestId('admin-funnel-disabled')).toBeInTheDocument());
  });
});
