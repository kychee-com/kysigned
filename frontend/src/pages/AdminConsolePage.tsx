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
import { useSearchParams } from 'react-router-dom';
import { apiGet, ApiError, formatUsd } from '../lib/api';
import { AdminReconciliationPage } from './AdminReconciliationPage';

type WindowKey = '24h' | '7d' | '30d' | '365d' | 'all';
type TabKey = 'overview' | 'accounts' | 'envelopes' | 'signals' | 'funnel' | 'reconciliation';

const WINDOWS: Array<[WindowKey, string]> = [
  ['24h', '24h'], ['7d', '7 days'], ['30d', '30 days'], ['365d', '1 year'], ['all', 'All time'],
];
const TABS: Array<[TabKey, string]> = [
  ['overview', 'Overview'], ['accounts', 'Accounts'], ['envelopes', 'Envelopes'], ['signals', 'Signals'], ['funnel', 'Funnel'], ['reconciliation', 'Reconciliation'],
];

// ── F-34.7 view-state persistence ──────────────────────────────────────────────
// The console's view (tab / window / exclude-internal) survives a reload: the URL
// query string is the source of truth, mirrored into localStorage so a BARE /admin
// (nav click, new tab, tomorrow) restores the last view too. Precedence:
// URL param > stored view > default. Every value is validated against its known
// set on read, so a stale or hand-edited param falls back to the default instead
// of rendering a broken page.
//
// These helpers live at MODULE scope deliberately: inside the component `window`
// is shadowed by the time-window state, so `window.localStorage` would not resolve.
const VIEW_KEY = 'kysigned.admin.view';
const TAB_KEYS = new Set<string>(TABS.map(([k]) => k));
const WINDOW_KEYS = new Set<string>(WINDOWS.map(([k]) => k));

interface StoredView { tab?: string; window?: string; exclude_internal?: string }

function readStoredView(): StoredView {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    return raw ? (JSON.parse(raw) as StoredView) : {};
  } catch {
    return {}; // storage disabled / private mode / corrupt JSON → just use defaults
  }
}

function writeStoredView(view: StoredView): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    /* storage unavailable — the URL still carries the view */
  }
}

/** URL param > stored view > default, each checked against its known values. */
function initialView(params: URLSearchParams): { tab: TabKey; window: WindowKey; excludeInternal: boolean } {
  const stored = readStoredView();
  const tabRaw = params.get('tab') ?? stored.tab;
  const winRaw = params.get('window') ?? stored.window;
  const exRaw = params.get('exclude_internal') ?? stored.exclude_internal;
  return {
    tab: (tabRaw && TAB_KEYS.has(tabRaw) ? tabRaw : 'overview') as TabKey,
    window: (winRaw && WINDOW_KEYS.has(winRaw) ? winRaw : '30d') as WindowKey,
    // mirrors the server's parseExcludeInternal: default ON, only an explicit off turns it off
    excludeInternal: !(exRaw === '0' || exRaw === 'false'),
  };
}

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

/** F-34.8 — a multi-value tile's independently-clickable parts (the aging buckets). */
interface TileSegment { id: string; label: string; value: number; onClick: () => void }

function Tile({ id, label, value, onClick, segments }: {
  id: string; label: string; value?: string | number; onClick?: () => void; segments?: TileSegment[];
}) {
  const inner = (
    <>
      <div className="text-xs text-gray-600">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </>
  );
  // F-34.8 / AC-204 — a tile carrying several values exposes EACH as its own target,
  // rather than collapsing into one undifferentiated list.
  if (segments) {
    return (
      <div className="border border-gray-200 rounded-lg bg-white px-4 py-3" data-testid={`admin-kpi-${id}`}>
        <div className="text-xs text-gray-600">{label}</div>
        <div className="flex flex-wrap items-baseline gap-1 mt-0.5">
          {segments.map((s, i) => (
            <span key={s.id} className="flex items-baseline">
              {i > 0 && <span className="text-gray-300 mx-1">/</span>}
              <button
                type="button"
                onClick={s.onClick}
                title={s.label}
                className="text-2xl font-semibold hover:text-sky-700 hover:underline cursor-pointer"
                data-testid={`admin-kpi-${id}-${s.id}`}
              >
                {s.value}
              </button>
            </span>
          ))}
        </div>
      </div>
    );
  }
  if (onClick) {
    // F-34.6/F-34.8 — a tile is an entry point: click opens the records behind it.
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

// ── F-34.8 / AC-203 — one generic drill panel behind every tile ────────────────

interface DrillCol { key: string; label: string }
type DrillRowData = Record<string, string | number | null>;
/** Rows a tab derived from a payload it ALREADY fetched (so they cannot disagree with the tile). */
function DrillPanel({ title, columns, rows, cap, onClose }: {
  title: string; columns: DrillCol[]; rows: DrillRowData[]; cap?: number; onClose: () => void;
}) {
  const shown = cap ? rows.slice(0, cap) : rows;
  return (
    <div className="mt-4 border border-gray-200 rounded-lg bg-white" data-testid="admin-drill">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
        <div className="text-sm font-semibold" data-testid="admin-drill-title">{title}</div>
        <button type="button" onClick={onClose} className="text-sm text-gray-600 hover:text-gray-900" data-testid="admin-drill-close">
          Close
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-gray-600 py-6 text-center" data-testid="admin-empty">Nothing in this window.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr className="text-left text-xs text-gray-600">
                {columns.map((c) => <th key={c.key} className="px-4 py-2">{c.label}</th>)}
              </tr>
            </thead>
            <tbody data-testid="admin-drill-rows">
              {shown.map((r, i) => (
                <tr key={String(r[columns[0]!.key] ?? i) + i} className="border-t border-gray-100">
                  {columns.map((c) => (
                    <td key={c.key} className="px-4 py-2 whitespace-nowrap text-gray-700">{r[c.key] ?? '—'}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {cap && rows.length > cap && (
            <p className="text-xs text-gray-500 px-4 py-2 border-t border-gray-100">
              Showing the first {cap} of {rows.length}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** A drill whose rows come from its own operator-gated read (active / signals / accounts). */
function FetchedDrillPanel<T>({ title, columns, path, extra, window, excludeInternal, map, onClose }: {
  title: string; columns: DrillCol[]; path: string; extra?: string;
  window: WindowKey; excludeInternal: boolean;
  map: (data: T) => DrillRowData[]; onClose: () => void;
}) {
  const { data, loading, denied, error } = useAdminData<T>(path, window, excludeInternal, extra);
  if (denied) return <Denied />;
  if (loading) return <Spinner />;
  if (error || !data) {
    return <p className="text-sm text-red-700 py-6 text-center" data-testid="admin-error">{error || 'Failed to load'}</p>;
  }
  return <DrillPanel title={title} columns={columns} rows={map(data)} onClose={onClose} />;
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
  /** F-34.2 — ONE figure, scoped by the selected window (not fixed DAU/WAU/MAU bands). */
  activeUsers: number;
}

/** F-34.8 — what the Overview's non-money tiles open. */
type OverviewDrill =
  | { kind: 'ledger'; group: LedgerGroup }
  | { kind: 'active' }
  | { kind: 'accountsOpened' }
  | { kind: 'envelopes'; status: 'all' | 'completed' | 'inProcess'; title: string };

const IN_PROCESS_STATUSES = new Set(['active', 'awaiting_seal']);
const ENV_COLS: DrillCol[] = [
  { key: 'document_name', label: 'Envelope' }, { key: 'sender_email', label: 'Creator' },
  { key: 'status', label: 'Status' }, { key: 'created', label: 'Created' },
];
const envRows = (list: Funnel['list'], keep: (s: string) => boolean): DrillRowData[] =>
  list.filter((e) => keep(e.status)).map((e) => ({
    document_name: e.document_name, sender_email: e.sender_email, status: e.status,
    created: new Date(e.created_at).toLocaleDateString(),
  }));

function OverviewTab({ window, excludeInternal }: { window: WindowKey; excludeInternal: boolean }) {
  const { data, loading, denied, error } = useAdminData<Overview>('/v1/admin/overview', window, excludeInternal);
  const [drill, setDrill] = useState<OverviewDrill | null>(null);
  if (denied) return <Denied />;
  if (loading) return <Spinner />;
  if (error || !data) return <p className="text-sm text-red-700 py-8 text-center" data-testid="admin-error">{error || 'Failed to load'}</p>;
  const close = () => setDrill(null);
  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="admin-overview">
        <Tile id="accountsOpened" label="Accounts opened" value={data.accountsOpened} onClick={() => setDrill({ kind: 'accountsOpened' })} />
        <Tile id="envelopesCreated" label="Envelopes created" value={data.envelopes.created} onClick={() => setDrill({ kind: 'envelopes', status: 'all', title: 'Envelopes created' })} />
        <Tile id="envelopesCompleted" label="Completed" value={data.envelopes.completed} onClick={() => setDrill({ kind: 'envelopes', status: 'completed', title: 'Completed envelopes' })} />
        <Tile id="envelopesInProcess" label="In process" value={data.envelopes.inProcess} onClick={() => setDrill({ kind: 'envelopes', status: 'inProcess', title: 'In-process envelopes' })} />
        <Tile id="paidIn" label="Paid in" value={formatUsd(data.credits.paidInUsdMicros)} onClick={() => setDrill({ kind: 'ledger', group: 'paid_in' })} />
        <Tile id="granted" label="Free credit granted" value={formatUsd(data.credits.grantedUsdMicros)} onClick={() => setDrill({ kind: 'ledger', group: 'granted' })} />
        <Tile id="consumed" label="Credit consumed" value={formatUsd(data.credits.consumedUsdMicros)} onClick={() => setDrill({ kind: 'ledger', group: 'consumed' })} />
        <Tile id="active" label="Active identities" value={data.activeUsers} onClick={() => setDrill({ kind: 'active' })} />
      </div>

      {drill?.kind === 'ledger' && (
        <LedgerPanel group={drill.group} window={window} excludeInternal={excludeInternal} onClose={close} />
      )}
      {drill?.kind === 'active' && (
        <FetchedDrillPanel<{ rows: Array<{ email: string; lastSeen: string | null; envelopesCreated: number }> }>
          title="Active identities" path="/v1/admin/active" window={window} excludeInternal={excludeInternal} onClose={close}
          columns={[{ key: 'email', label: 'Identity' }, { key: 'lastSeen', label: 'Last seen' }, { key: 'created', label: 'Envelopes created' }]}
          map={(d) => d.rows.map((r) => ({
            email: r.email,
            lastSeen: r.lastSeen ? new Date(r.lastSeen).toLocaleString() : null,
            created: r.envelopesCreated,
          }))}
        />
      )}
      {drill?.kind === 'accountsOpened' && (
        <FetchedDrillPanel<{ accounts: AccountRow[] }>
          title="Accounts opened" path="/v1/admin/accounts" window={window} excludeInternal={excludeInternal} onClose={close}
          columns={[{ key: 'email', label: 'Identity' }, { key: 'type', label: 'Type' }, { key: 'joined', label: 'Joined' }]}
          map={(d) => d.accounts.filter((a) => a.openedInWindow).map((a) => ({
            email: a.email, type: badgeText(a), joined: a.joined ? new Date(a.joined).toLocaleDateString() : null,
          }))}
        />
      )}
      {drill?.kind === 'envelopes' && (
        <FetchedDrillPanel<Funnel>
          title={drill.title} path="/v1/admin/envelopes" window={window} excludeInternal={excludeInternal} onClose={close}
          columns={ENV_COLS}
          map={(d) => envRows(d.list, (s) =>
            drill.status === 'all' ? true : drill.status === 'completed' ? s === 'completed' : IN_PROCESS_STATUSES.has(s),
          )}
        />
      )}
    </div>
  );
}

interface AccountRow {
  email: string; kind: 'human' | 'agent'; walletFunded: boolean; programmatic: boolean;
  envelopes: { created: number; completed: number; inProcess: number };
  balanceUsdMicros: string; lastSeen: string | null; joined: string | null;
  /** F-34.8 — joined inside the window, i.e. counted by the "Accounts opened" tile. */
  openedInWindow?: boolean;
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

/** F-34.8 — the Envelopes tab derives every drill from the list it ALREADY fetched. */
type EnvDrill = { title: string; keep: (e: Funnel['list'][number]) => boolean; withDuration?: boolean };
const AGE_BUCKETS: Array<{ id: 'lt1d' | 'd1to3' | 'd3to7' | 'gt7d'; label: string; min: number; max: number }> = [
  { id: 'lt1d', label: 'under 1 day', min: 0, max: 1 },
  { id: 'd1to3', label: '1-3 days', min: 1, max: 3 },
  { id: 'd3to7', label: '3-7 days', min: 3, max: 7 },
  { id: 'gt7d', label: 'over 7 days', min: 7, max: Infinity },
];
const ageDays = (iso: string) => (Date.now() - new Date(iso).getTime()) / 86_400_000;

function EnvelopesTab({ window, excludeInternal }: { window: WindowKey; excludeInternal: boolean }) {
  const { data, loading, denied, error } = useAdminData<Funnel>('/v1/admin/envelopes', window, excludeInternal);
  const [drill, setDrill] = useState<EnvDrill | null>(null);
  if (denied) return <Denied />;
  if (loading) return <Spinner />;
  if (error || !data) return <p className="text-sm text-red-700 py-8 text-center" data-testid="admin-error">{error || 'Failed to load'}</p>;
  const days = data.avgTimeToCompleteMs == null ? '—' : `${(data.avgTimeToCompleteMs / 86_400_000).toFixed(1)}d`;
  const list = data.list;
  const open = (d: EnvDrill) => () => setDrill(d);
  return (
    <div data-testid="admin-envelopes">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Tile id="funnelCreated" label="Created" value={data.created} onClick={open({ title: 'Created envelopes', keep: () => true })} />
        <Tile id="funnelCompleted" label="Completed" value={data.completed} onClick={open({ title: 'Completed envelopes', keep: (e) => e.status === 'completed' })} />
        {/* AC-204 — a ratio opens the cohort it is computed OVER, so the number is auditable. */}
        <Tile id="funnelRate" label="Completion rate" value={`${Math.round(data.completionRate * 100)}%`} onClick={open({ title: 'Completion-rate cohort (all created)', keep: () => true })} />
        {/* AC-204 — an average opens the set it averages, each row carrying its own duration. */}
        <Tile id="funnelAvg" label="Avg time-to-complete" value={days} onClick={open({ title: 'Completed envelopes — time to complete', keep: (e) => e.status === 'completed' && !!e.completed_at, withDuration: true })} />
        <Tile
          id="funnelAging"
          label="Aging (1/3/7/7+ d)"
          segments={AGE_BUCKETS.map((b) => ({
            id: b.id,
            label: `In process, ${b.label}`,
            value: data.aging[b.id],
            onClick: open({
              title: `In process — ${b.label}`,
              keep: (e) => IN_PROCESS_STATUSES.has(e.status) && ageDays(e.created_at) >= b.min && ageDays(e.created_at) < b.max,
            }),
          }))}
        />
        <Tile id="funnelVoided" label="Voided" value={data.voided} onClick={open({ title: 'Voided envelopes', keep: (e) => e.status === 'voided' })} />
        <Tile id="funnelExpired" label="Expired" value={data.expired} onClick={open({ title: 'Expired envelopes', keep: (e) => e.status === 'expired' })} />
      </div>
      {drill && (
        <div className="mb-4">
          <DrillPanel
            title={drill.title}
            columns={drill.withDuration ? [...ENV_COLS, { key: 'took', label: 'Took' }] : ENV_COLS}
            rows={list.filter(drill.keep).map((e) => ({
              document_name: e.document_name, sender_email: e.sender_email, status: e.status,
              created: new Date(e.created_at).toLocaleDateString(),
              ...(drill.withDuration && e.completed_at
                ? { took: `${((new Date(e.completed_at).getTime() - new Date(e.created_at).getTime()) / 86_400_000).toFixed(1)}d` }
                : {}),
            }))}
            onClose={() => setDrill(null)}
          />
        </div>
      )}
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

/** F-34.8 — the six Signals tiles map 1:1 onto `/v1/admin/signal-rows?group=`. */
type SignalGroup = 'invited' | 'signed' | 'undeliverable' | 'wallet_creates' | 'human_creates' | 'api_key_holders';
const SIGNAL_TITLES: Record<SignalGroup, string> = {
  invited: 'Signers invited', signed: 'Signers who signed', undeliverable: 'Undeliverable signers',
  wallet_creates: 'Wallet-agent creates', human_creates: 'Human creates', api_key_holders: 'API-key holders',
};
const SIGNAL_COLS: DrillCol[] = [
  { key: 'primary', label: 'Who' }, { key: 'secondary', label: 'Context' },
  { key: 'detail', label: 'Detail' }, { key: 'at', label: 'When' },
];


// ── F-38.6 / AC-219 — the Funnel tab ────────────────────────────────────────
// The pre-signin funnel: eight steps in order with the drop between adjacent
// steps (the read that answers "WHERE do visitors stop"), split by traffic
// source and country, plus the home page's per-element clicks. The rail is
// identifier-free, so there is nothing for exclude-internal to classify — the
// toggle deliberately does not apply here. Window → days (records prune at 90).
const FUNNEL_WINDOW_DAYS: Record<WindowKey, number> = { '24h': 1, '7d': 7, '30d': 30, '365d': 90, 'all': 90 };

interface FunnelSummary {
  enabled: boolean;
  window_days: number;
  steps: Array<{ step: string; event: string; count: number }>;
  by_source: Record<string, number[]>;
  by_country: Record<string, number[]>;
  home_clicks: Record<string, number>;
}

function FunnelSplitTable({ title, testId, split, steps }: {
  title: string; testId: string; split: Record<string, number[]>; steps: FunnelSummary['steps'];
}) {
  const keys = Object.keys(split).sort();
  if (keys.length === 0) return null;
  return (
    <div className="mb-6" data-testid={testId}>
      <h3 className="text-sm font-medium mb-2">{title}</h3>
      <div className="overflow-x-auto">
        <table className="text-xs w-full border-collapse">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1 pr-3 font-normal" />
              {steps.map((st) => (
                <th key={st.step} className="py-1 pr-3 font-normal whitespace-nowrap">{st.step.replace(/_/g, ' ')}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k} className="border-t border-gray-100">
                <td className="py-1 pr-3 font-medium whitespace-nowrap">{k}</td>
                {(split[k] ?? []).map((n, i) => (
                  <td key={i} className="py-1 pr-3 tabular-nums">{n}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FunnelTab({ window }: { window: WindowKey }) {
  const days = FUNNEL_WINDOW_DAYS[window];
  const [data, setData] = useState<FunnelSummary | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setData(null);
    setError('');
    apiGet<FunnelSummary>(`/v1/telemetry/summary?days=${days}`)
      .then((d) => { if (active) setData(d); })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : 'failed'); });
    return () => { active = false; };
  }, [days]);

  if (error) return <p className="text-sm text-red-600 py-6" data-testid="admin-funnel-error">{error}</p>;
  if (!data) return <Spinner />;
  if (!data.enabled) {
    return (
      <p className="text-sm text-gray-600 py-6" data-testid="admin-funnel-disabled">
        Funnel telemetry is off (KYSIGNED_TELEMETRY). Enable the rail to collect the pre-signin funnel.
      </p>
    );
  }

  return (
    <div data-testid="admin-funnel">
      <div className="mb-6">
        {data.steps.map((st, i) => {
          const prev = i === 0 ? null : data.steps[i - 1].count;
          const drop = prev && prev > 0 ? Math.round(((st.count - prev) / prev) * 100) : null;
          const width = data.steps[0].count > 0 ? Math.max(2, Math.round((st.count / data.steps[0].count) * 100)) : 2;
          return (
            <div key={st.step} className="flex items-center gap-3 py-1" data-testid={`admin-funnel-step-${st.step}`}>
              <span className="w-32 shrink-0 text-xs text-gray-700 whitespace-nowrap">{st.step.replace(/_/g, ' ')}</span>
              <div className="flex-1 min-w-0">
                <div className="h-5 rounded bg-gray-900" style={{ width: `${width}%` }} />
              </div>
              <span className="w-16 shrink-0 text-right text-sm tabular-nums font-medium">{st.count}</span>
              <span className="w-14 shrink-0 text-right text-xs tabular-nums text-gray-500">
                {drop === null ? '' : `${drop}%`}
              </span>
            </div>
          );
        })}
      </div>
      <FunnelSplitTable title="By traffic source" testId="admin-funnel-sources" split={data.by_source} steps={data.steps} />
      <FunnelSplitTable title="By country" testId="admin-funnel-countries" split={data.by_country} steps={data.steps} />
      {Object.keys(data.home_clicks).length > 0 && (
        <div className="mb-6" data-testid="admin-funnel-home-clicks">
          <h3 className="text-sm font-medium mb-2">Home page clicks</h3>
          <table className="text-xs border-collapse">
            <tbody>
              {Object.entries(data.home_clicks).sort((a, b) => b[1] - a[1]).map(([el, n]) => (
                <tr key={el} className="border-t border-gray-100">
                  <td className="py-1 pr-6 font-mono">{el}</td>
                  <td className="py-1 tabular-nums text-right">{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SignalsTab({ window, excludeInternal }: { window: WindowKey; excludeInternal: boolean }) {
  const { data, loading, denied, error } = useAdminData<Signals>('/v1/admin/signals', window, excludeInternal);
  const [drill, setDrill] = useState<SignalGroup | null>(null);
  if (denied) return <Denied />;
  if (loading) return <Spinner />;
  if (error || !data) return <p className="text-sm text-red-700 py-8 text-center" data-testid="admin-error">{error || 'Failed to load'}</p>;
  const tile = (id: string, label: string, value: number, group: SignalGroup) => (
    <Tile id={id} label={label} value={value} onClick={() => setDrill(group)} />
  );
  return (
    <div data-testid="admin-signals">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {tile('delivInvited', 'Signers invited', data.deliverability.invited, 'invited')}
        {tile('delivSigned', 'Signed', data.deliverability.signed, 'signed')}
        {tile('delivUndeliverable', 'Undeliverable', data.deliverability.undeliverable, 'undeliverable')}
        {tile('walletCreates', 'Wallet-agent creates', data.agentAdoption.walletCreates, 'wallet_creates')}
        {tile('humanCreates', 'Human creates', data.agentAdoption.humanCreates, 'human_creates')}
        {tile('apiKeyHolders', 'API-key holders', data.agentAdoption.apiKeyHolders, 'api_key_holders')}
      </div>
      {drill && (
        <FetchedDrillPanel<{ rows: Array<Record<string, string | null>> }>
          title={SIGNAL_TITLES[drill]} path="/v1/admin/signal-rows" extra={`&group=${drill}`}
          window={window} excludeInternal={excludeInternal} onClose={() => setDrill(null)}
          columns={SIGNAL_COLS}
          map={(d) => d.rows.map((r) => ({
            primary: r.primary ?? null, secondary: r.secondary ?? null, detail: r.detail ?? null,
            at: r.at ? new Date(r.at).toLocaleString() : null,
          }))}
        />
      )}
    </div>
  );
}

export function AdminConsolePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // F-34.7 — seed the view ONCE from the URL, then the last stored view, then the
  // defaults; from here on the state drives the URL (below), not the other way.
  const [seed] = useState(() => initialView(searchParams));
  const [tab, setTab] = useState<TabKey>(seed.tab);
  const [window, setWindow] = useState<WindowKey>(seed.window);
  // F-35 — exclude the operator's own data by default (internal_test + configured identities).
  const [excludeInternal, setExcludeInternal] = useState(seed.excludeInternal);
  const [access, setAccess] = useState<'checking' | 'operator' | 'denied'>('checking');

  // F-34.7 — mirror the current view into the URL (replace, so the back button does
  // not fill with console states) and into localStorage, so a refresh, a bookmark,
  // and a later bare /admin all land back on this exact view (AC-202).
  useEffect(() => {
    const view = { tab, window, exclude_internal: excludeInternal ? '1' : '0' };
    setSearchParams(view, { replace: true });
    writeStoredView(view);
    // Keyed on the view values only — `setSearchParams` has no stable identity, and
    // the values are what actually need to drive the sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, window, excludeInternal]);

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
      {tab === 'funnel' && <FunnelTab window={window} />}
      {tab === 'reconciliation' && <AdminReconciliationPage excludeInternal={excludeInternal} />}
    </div>
  );
}
