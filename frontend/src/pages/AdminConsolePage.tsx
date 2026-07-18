/**
 * AdminConsolePage — the F-34 operator console (#148).
 *
 * OPERATOR-ONLY. A tabbed console over the operator-gated `/v1/admin/*` analytics
 * endpoints, with one global time-window selector (24h / 7d / 30d / 365d / all)
 * that scopes every page. Tabs: Overview (KPIs), Accounts (Human/Agent classified),
 * Envelopes (funnel + aging), Reconciliation (the archive-confirmation backlog).
 *
 * Each tab fetches its own endpoint; a 403 from the operator gate renders the
 * access-denied view instead of any data (a signed-in non-operator sees no data,
 * AC-179). App.tsx wraps `/admin` in <RequireAuth/>, so anonymous visitors get the
 * sign-in screen. NOT linked from the creator nav.
 */
import { useEffect, useState } from 'react';
import { apiGet, ApiError, formatUsd } from '../lib/api';
import { AdminReconciliationPage } from './AdminReconciliationPage';

type WindowKey = '24h' | '7d' | '30d' | '365d' | 'all';
type TabKey = 'overview' | 'accounts' | 'envelopes' | 'signals' | 'reconciliation';

const WINDOWS: Array<[WindowKey, string]> = [
  ['24h', '24h'], ['7d', '7 days'], ['30d', '30 days'], ['365d', '1 year'], ['all', 'All time'],
];
const TABS: Array<[TabKey, string]> = [
  ['overview', 'Overview'], ['accounts', 'Accounts'], ['envelopes', 'Envelopes'], ['signals', 'Signals'], ['reconciliation', 'Reconciliation'],
];

interface Fetched<T> { data: T | null; loading: boolean; denied: boolean; error: string }

function useAdminData<T>(path: string, window: WindowKey, excludeInternal: boolean, extra = ''): Fetched<T> {
  const [state, setState] = useState<Fetched<T>>({ data: null, loading: true, denied: false, error: '' });
  useEffect(() => {
    let active = true;
    setState((s) => ({ ...s, loading: true }));
    apiGet<T>(`${path}?window=${encodeURIComponent(window)}&exclude_internal=${excludeInternal ? '1' : '0'}${extra}`)
      .then((data) => { if (active) setState({ data, loading: false, denied: false, error: '' }); })
      .catch((e) => {
        if (!active) return;
        if (e instanceof ApiError && e.status === 403) setState({ data: null, loading: false, denied: true, error: '' });
        else setState({ data: null, loading: false, denied: false, error: (e as Error).message ?? 'Failed to load' });
      });
    return () => { active = false; };
  }, [path, window, excludeInternal, extra]);
  return state;
}

function Denied() {
  return (
    <div className="max-w-lg mx-auto px-4 py-16 text-center" data-testid="admin-denied">
      <h1 className="text-xl font-semibold mb-2">Operator access required</h1>
      <p className="text-sm text-gray-600">This page is restricted to kysigned operators.</p>
    </div>
  );
}

function Spinner() {
  return (
    <div className="py-20 text-center" data-testid="admin-loading">
      <div className="animate-spin h-6 w-6 border-4 border-gray-300 border-t-gray-900 rounded-full mx-auto" />
    </div>
  );
}

function Tile({ id, label, value, onClick }: { id: string; label: string; value: string | number; onClick?: () => void }) {
  const inner = (
    <>
      <div className="text-xs text-gray-600">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </>
  );
  if (onClick) {
    // F-34.6 — a money tile is an entry point: click opens the ledger behind it.
    return (
      <button
        type="button"
        onClick={onClick}
        className="border border-gray-200 rounded-lg bg-white px-4 py-3 text-left hover:border-gray-400 cursor-pointer"
        data-testid={`admin-kpi-${id}`}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className="border border-gray-200 rounded-lg bg-white px-4 py-3" data-testid={`admin-kpi-${id}`}>
      {inner}
    </div>
  );
}

type LedgerGroup = 'paid_in' | 'granted' | 'consumed';
const LEDGER_TITLES: Record<LedgerGroup, string> = {
  paid_in: 'Paid in — ledger',
  granted: 'Free credit granted — ledger',
  consumed: 'Credit consumed — ledger',
};

interface LedgerRow {
  id: string; email: string; delta_usd_micros: string; source: string;
  external_ref: string | null; created_at: string;
}

function LedgerPanel({ group, window, excludeInternal, onClose }: {
  group: LedgerGroup; window: WindowKey; excludeInternal: boolean; onClose: () => void;
}) {
  const { data, loading, denied, error } = useAdminData<{ rows: LedgerRow[] }>(
    '/v1/admin/ledger', window, excludeInternal, `&group=${group}`,
  );
  return (
    <div className="mt-4 border border-gray-200 rounded-lg bg-white" data-testid="admin-ledger">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
        <div className="text-sm font-semibold">{LEDGER_TITLES[group]}</div>
        <button type="button" onClick={onClose} className="text-sm text-gray-600 hover:text-gray-900" data-testid="admin-ledger-close">
          Close
        </button>
      </div>
      {denied && <Denied />}
      {!denied && loading && <Spinner />}
      {!denied && !loading && (error || !data) && (
        <p className="text-sm text-red-700 py-6 text-center" data-testid="admin-error">{error || 'Failed to load'}</p>
      )}
      {!denied && !loading && data && data.rows.length === 0 && (
        <p className="text-sm text-gray-600 py-6 text-center" data-testid="admin-empty">No ledger entries in this window.</p>
      )}
      {!denied && !loading && data && data.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr className="text-left text-xs text-gray-600">
                <th className="px-4 py-2">Who</th>
                <th className="px-4 py-2">Amount</th>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2">Reference</th>
                <th className="px-4 py-2">When</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="px-4 py-2 whitespace-nowrap">{r.email}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{formatUsd(r.delta_usd_micros)}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{r.source}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-gray-600">{r.external_ref ?? '—'}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-gray-600">{new Date(r.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface Overview {
  accountsOpened: number;
  envelopes: { created: number; completed: number; inProcess: number };
  credits: { paidInUsdMicros: string; grantedUsdMicros: string; consumedUsdMicros: string };
  activeUsers: { dau: number; wau: number; mau: number };
}

function OverviewTab({ window, excludeInternal }: { window: WindowKey; excludeInternal: boolean }) {
  const { data, loading, denied, error } = useAdminData<Overview>('/v1/admin/overview', window, excludeInternal);
  const [drill, setDrill] = useState<LedgerGroup | null>(null);
  if (denied) return <Denied />;
  if (loading) return <Spinner />;
  if (error || !data) return <p className="text-sm text-red-700 py-8 text-center" data-testid="admin-error">{error || 'Failed to load'}</p>;
  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="admin-overview">
        <Tile id="accountsOpened" label="Accounts opened" value={data.accountsOpened} />
        <Tile id="envelopesCreated" label="Envelopes created" value={data.envelopes.created} />
        <Tile id="envelopesCompleted" label="Completed" value={data.envelopes.completed} />
        <Tile id="envelopesInProcess" label="In process" value={data.envelopes.inProcess} />
        <Tile id="paidIn" label="Paid in" value={formatUsd(data.credits.paidInUsdMicros)} onClick={() => setDrill('paid_in')} />
        <Tile id="granted" label="Free credit granted" value={formatUsd(data.credits.grantedUsdMicros)} onClick={() => setDrill('granted')} />
        <Tile id="consumed" label="Credit consumed" value={formatUsd(data.credits.consumedUsdMicros)} onClick={() => setDrill('consumed')} />
        <Tile id="active" label="Active (D/W/M)" value={`${data.activeUsers.dau} / ${data.activeUsers.wau} / ${data.activeUsers.mau}`} />
      </div>
      {drill && (
        <LedgerPanel group={drill} window={window} excludeInternal={excludeInternal} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}

interface AccountRow {
  email: string; kind: 'human' | 'agent'; walletFunded: boolean; programmatic: boolean;
  envelopes: { created: number; completed: number; inProcess: number };
  balanceUsdMicros: string; lastSeen: string | null; joined: string | null;
}

function badgeText(r: AccountRow): string {
  if (r.kind === 'agent') return 'Agent (wallet)';
  return r.walletFunded ? 'Human · wallet-funded' : 'Human';
}

function AccountsTab({ window, excludeInternal }: { window: WindowKey; excludeInternal: boolean }) {
  const { data, loading, denied, error } = useAdminData<{ accounts: AccountRow[] }>('/v1/admin/accounts', window, excludeInternal);
  if (denied) return <Denied />;
  if (loading) return <Spinner />;
  if (error || !data) return <p className="text-sm text-red-700 py-8 text-center" data-testid="admin-error">{error || 'Failed to load'}</p>;
  if (data.accounts.length === 0) return <p className="text-sm text-gray-600 py-8 text-center" data-testid="admin-empty">No accounts active in this window.</p>;
  return (
    <div className="border border-gray-200 rounded-lg overflow-x-auto bg-white" data-testid="admin-accounts">
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="text-left px-4 py-2 font-medium text-gray-700">Identity</th>
            <th className="text-left px-4 py-2 font-medium text-gray-700">Type</th>
            <th className="text-left px-4 py-2 font-medium text-gray-700">Env (c/done/wip)</th>
            <th className="text-left px-4 py-2 font-medium text-gray-700">Budget</th>
            <th className="text-left px-4 py-2 font-medium text-gray-700">Last seen</th>
            <th className="text-left px-4 py-2 font-medium text-gray-700">Joined</th>
          </tr>
        </thead>
        <tbody>
          {data.accounts.map((r) => (
            <tr key={r.email} className="border-t border-gray-100" data-testid={`admin-account-row-${r.email}`}>
              <td className="px-4 py-2">{r.email}</td>
              <td className="px-4 py-2">
                <span
                  className={`text-xs border rounded px-2 py-0.5 ${r.kind === 'agent' ? 'border-violet-200 bg-violet-50 text-violet-800' : 'border-sky-200 bg-sky-50 text-sky-800'}`}
                  data-testid={`admin-account-badge-${r.email}`}
                >
                  {badgeText(r)}
                </span>
                {r.programmatic && (
                  <span className="ml-1 text-xs border rounded px-2 py-0.5 border-gray-200 bg-gray-50 text-gray-700" data-testid={`admin-account-programmatic-${r.email}`}>
                    Programmatic
                  </span>
                )}
              </td>
              <td className="px-4 py-2 text-xs text-gray-600">{r.envelopes.created} / {r.envelopes.completed} / {r.envelopes.inProcess}</td>
              <td className="px-4 py-2 text-xs text-gray-600">{formatUsd(r.balanceUsdMicros)}</td>
              <td className="px-4 py-2 text-xs text-gray-600">{r.lastSeen ? new Date(r.lastSeen).toLocaleDateString() : '—'}</td>
              <td className="px-4 py-2 text-xs text-gray-600">{r.joined ? new Date(r.joined).toLocaleDateString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface Funnel {
  created: number; completed: number; completionRate: number; avgTimeToCompleteMs: number | null;
  aging: { lt1d: number; d1to3: number; d3to7: number; gt7d: number };
  voided: number; expired: number;
  list: Array<{ id: string; sender_email: string; document_name: string; status: string; created_at: string; completed_at: string | null }>;
}

function EnvelopesTab({ window, excludeInternal }: { window: WindowKey; excludeInternal: boolean }) {
  const { data, loading, denied, error } = useAdminData<Funnel>('/v1/admin/envelopes', window, excludeInternal);
  if (denied) return <Denied />;
  if (loading) return <Spinner />;
  if (error || !data) return <p className="text-sm text-red-700 py-8 text-center" data-testid="admin-error">{error || 'Failed to load'}</p>;
  const days = data.avgTimeToCompleteMs == null ? '—' : `${(data.avgTimeToCompleteMs / 86_400_000).toFixed(1)}d`;
  return (
    <div data-testid="admin-envelopes">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Tile id="funnelCreated" label="Created" value={data.created} />
        <Tile id="funnelCompleted" label="Completed" value={data.completed} />
        <Tile id="funnelRate" label="Completion rate" value={`${Math.round(data.completionRate * 100)}%`} />
        <Tile id="funnelAvg" label="Avg time-to-complete" value={days} />
        <Tile id="funnelAging" label="Aging (1/3/7/7+ d)" value={`${data.aging.lt1d}/${data.aging.d1to3}/${data.aging.d3to7}/${data.aging.gt7d}`} />
        <Tile id="funnelVoided" label="Voided" value={data.voided} />
        <Tile id="funnelExpired" label="Expired" value={data.expired} />
      </div>
      <div className="border border-gray-200 rounded-lg overflow-x-auto bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-2 font-medium text-gray-700">Envelope</th>
              <th className="text-left px-4 py-2 font-medium text-gray-700">Creator</th>
              <th className="text-left px-4 py-2 font-medium text-gray-700">Status</th>
              <th className="text-left px-4 py-2 font-medium text-gray-700">Created</th>
            </tr>
          </thead>
          <tbody>
            {data.list.map((e) => (
              <tr key={e.id} className="border-t border-gray-100">
                <td className="px-4 py-2 text-xs">{e.document_name}</td>
                <td className="px-4 py-2 text-xs text-gray-600">{e.sender_email}</td>
                <td className="px-4 py-2 text-xs text-gray-600">{e.status}</td>
                <td className="px-4 py-2 text-xs text-gray-600">{new Date(e.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface Signals {
  deliverability: { invited: number; signed: number; undeliverable: number };
  agentAdoption: { walletCreates: number; humanCreates: number; apiKeyHolders: number };
}

function SignalsTab({ window, excludeInternal }: { window: WindowKey; excludeInternal: boolean }) {
  const { data, loading, denied, error } = useAdminData<Signals>('/v1/admin/signals', window, excludeInternal);
  if (denied) return <Denied />;
  if (loading) return <Spinner />;
  if (error || !data) return <p className="text-sm text-red-700 py-8 text-center" data-testid="admin-error">{error || 'Failed to load'}</p>;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3" data-testid="admin-signals">
      <Tile id="delivInvited" label="Signers invited" value={data.deliverability.invited} />
      <Tile id="delivSigned" label="Signed" value={data.deliverability.signed} />
      <Tile id="delivUndeliverable" label="Undeliverable" value={data.deliverability.undeliverable} />
      <Tile id="walletCreates" label="Wallet-agent creates" value={data.agentAdoption.walletCreates} />
      <Tile id="humanCreates" label="Human creates" value={data.agentAdoption.humanCreates} />
      <Tile id="apiKeyHolders" label="API-key holders" value={data.agentAdoption.apiKeyHolders} />
    </div>
  );
}

export function AdminConsolePage() {
  const [tab, setTab] = useState<TabKey>('overview');
  const [window, setWindow] = useState<WindowKey>('30d');
  // F-35 — exclude the operator's own data by default (internal_test + configured identities).
  const [excludeInternal, setExcludeInternal] = useState(true);
  const [access, setAccess] = useState<'checking' | 'operator' | 'denied'>('checking');

  // Gate the WHOLE console at the shell, not per-tab: a non-operator must see the
  // access-denied message ALONE — no title, window selector, or tabs (AC-179). One
  // probe against an operator route decides access (it doesn't vary by window/tab);
  // a non-403 error still renders the console so the tab can surface its own error.
  useEffect(() => {
    let active = true;
    apiGet('/v1/admin/overview')
      .then(() => { if (active) setAccess('operator'); })
      .catch((e) => { if (active) setAccess(e instanceof ApiError && e.status === 403 ? 'denied' : 'operator'); });
    return () => { active = false; };
  }, []);

  if (access === 'checking') return <Spinner />;
  if (access === 'denied') return <Denied />;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8" data-testid="admin-console">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-2xl font-semibold">Operator console</h1>
        <div className="flex flex-wrap items-center gap-3">
          {tab !== 'reconciliation' && (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Time window">
              {WINDOWS.map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setWindow(key)}
                  className={`text-xs px-2 py-1 rounded border ${window === key ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 text-gray-700 hover:bg-gray-100'}`}
                  data-testid={`admin-window-${key}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <label className="flex items-center gap-1.5 text-xs text-gray-700 whitespace-nowrap cursor-pointer" data-testid="admin-exclude-internal">
            <input
              type="checkbox"
              checked={excludeInternal}
              onChange={(e) => setExcludeInternal(e.target.checked)}
              className="rounded border-gray-300"
              data-testid="admin-exclude-internal-input"
            />
            Exclude internal
          </label>
        </div>
      </div>

      <div className="flex gap-1 border-b border-gray-200 mb-6 overflow-x-auto">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`text-sm px-3 py-2 -mb-px border-b-2 whitespace-nowrap shrink-0 ${tab === key ? 'border-gray-900 font-medium' : 'border-transparent text-gray-600 hover:text-gray-900'}`}
            data-testid={`admin-tab-${key}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab window={window} excludeInternal={excludeInternal} />}
      {tab === 'accounts' && <AccountsTab window={window} excludeInternal={excludeInternal} />}
      {tab === 'envelopes' && <EnvelopesTab window={window} excludeInternal={excludeInternal} />}
      {tab === 'signals' && <SignalsTab window={window} excludeInternal={excludeInternal} />}
      {tab === 'reconciliation' && <AdminReconciliationPage excludeInternal={excludeInternal} />}
    </div>
  );
}
