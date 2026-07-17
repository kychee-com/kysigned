/**
 * adminAnalytics — F-34 operator-console analytics DAOs.
 *
 * These power the operator console's aggregate pages (overview, accounts,
 * envelopes, signals). Per DD-40/DD-41 they fetch the (small) tables and do all
 * window / band / classification arithmetic in JS — read-time at kysigned's scale
 * (a cached rollup is the deferred optimization), which keeps the aggregation
 * directly unit-testable. Internal-test envelopes (F-3.7) are excluded in SQL.
 *
 * `now`/`since` are injected by the caller (from `parseWindow`) so the arithmetic
 * is deterministic. Credit sums are micros returned as decimal strings (bigint).
 */
import type { DbPool } from './pool.js';
import { isInternalIdentity } from '../api/auth/internalIdentity.js';

const H = 3_600_000;
const D = 24 * H;

/**
 * F-35 — operator-view internal exclusion. The console's exclude-internal toggle
 * (default on) drops the operator's own data from every page: an ENVELOPE is
 * internal when its `internal_test` flag is set OR its creator matches a configured
 * identity rule; an ACCOUNT-level row (credits / sessions / api-keys) is internal
 * when its own email matches a rule. `excludeInternal:false` keeps everything.
 */
interface ExcludeOpts {
  excludeInternal: boolean;
  internalIdentities: readonly string[];
}
/** Resolve the toggle (default ON) + rules (default none) from a DAO's opts. */
function resolveExclude(opts: { excludeInternal?: boolean; internalIdentities?: readonly string[] }): ExcludeOpts {
  return { excludeInternal: opts.excludeInternal ?? true, internalIdentities: opts.internalIdentities ?? [] };
}
/** Drop this identity's account-level rows (credits / sessions / keys) from the view. */
function identityDropped(email: string | null | undefined, ex: ExcludeOpts): boolean {
  return ex.excludeInternal && isInternalIdentity(email, ex.internalIdentities);
}
/** Drop this envelope: the internal-test flag OR an internal creator identity. */
function envDropped(e: { sender_email: string; internal_test?: boolean }, ex: ExcludeOpts): boolean {
  if (!ex.excludeInternal) return false;
  return Boolean(e.internal_test) || isInternalIdentity(e.sender_email, ex.internalIdentities);
}

/** In-window iff there is no lower bound, or the timestamp is at/after it. */
function inWindow(ts: string | Date | null | undefined, since: Date | null): boolean {
  if (since === null) return true;
  if (ts == null) return false;
  return new Date(ts).getTime() >= since.getTime();
}

const IN_PROCESS = new Set(['active', 'awaiting_seal']);
const PAID_SOURCES = new Set(['x402', 'stripe']);

export interface OverviewResult {
  accountsOpened: number;
  envelopes: { created: number; completed: number; inProcess: number };
  credits: { paidInUsdMicros: string; grantedUsdMicros: string; consumedUsdMicros: string };
  activeUsers: { dau: number; wau: number; mau: number };
}

interface CreditRow { email: string; source: string; delta_usd_micros: number | string; created_at: string | Date }
interface EnvRow { sender_email: string; status: string; created_at: string | Date; completed_at?: string | Date | null; internal_test?: boolean }
interface SessionRow { email: string; last_used_at: string | Date }
interface UserRow { email: string; balance_usd_micros: number | string; created_at: string | Date }

export async function getOverview(
  pool: DbPool,
  opts: { since: Date | null; now: Date; excludeInternal?: boolean; internalIdentities?: readonly string[] },
): Promise<OverviewResult> {
  const { since, now } = opts;
  const ex = resolveExclude(opts);
  const [users, envelopes, ledger, sessions] = await Promise.all([
    pool.query('SELECT email, balance_usd_micros, created_at FROM user_credits'),
    pool.query('SELECT sender_email, status, created_at, completed_at, internal_test FROM envelopes'),
    pool.query('SELECT email, source, delta_usd_micros, created_at FROM credit_ledger'),
    pool.query('SELECT email, last_used_at FROM auth_sessions'),
  ]);
  const userRows = (users.rows as UserRow[]).filter((u) => !identityDropped(u.email, ex));
  const envRows = (envelopes.rows as EnvRow[]).filter((e) => !envDropped(e, ex));
  const ledgerRows = (ledger.rows as CreditRow[]).filter((l) => !identityDropped(l.email, ex));
  const sessionRows = (sessions.rows as SessionRow[]).filter((s) => !identityDropped(s.email, ex));

  const accountsOpened = userRows.filter((u) => inWindow(u.created_at, since)).length;

  const cohort = envRows.filter((e) => inWindow(e.created_at, since));
  const envelopeCounts = {
    created: cohort.length,
    completed: cohort.filter((e) => e.status === 'completed').length,
    inProcess: cohort.filter((e) => IN_PROCESS.has(e.status)).length,
  };

  let paidIn = 0n;
  let granted = 0n;
  let consumed = 0n;
  for (const row of ledgerRows) {
    if (!inWindow(row.created_at, since)) continue;
    const delta = BigInt(row.delta_usd_micros);
    if (PAID_SOURCES.has(row.source) && delta > 0n) paidIn += delta;
    else if (row.source === 'signup_grant') granted += delta;
    else if (row.source === 'envelope') consumed += -delta; // debits are negative → positive consumed
  }

  const activeInBand = (bandMs: number): number => {
    const floor = now.getTime() - bandMs;
    const emails = new Set<string>();
    for (const s of sessionRows) if (new Date(s.last_used_at).getTime() >= floor) emails.add(s.email);
    for (const e of envRows) if (new Date(e.created_at).getTime() >= floor) emails.add(e.sender_email);
    return emails.size;
  };

  return {
    accountsOpened,
    envelopes: envelopeCounts,
    credits: {
      paidInUsdMicros: paidIn.toString(),
      grantedUsdMicros: granted.toString(),
      consumedUsdMicros: consumed.toString(),
    },
    activeUsers: { dau: activeInBand(24 * H), wau: activeInBand(7 * D), mau: activeInBand(30 * D) },
  };
}

interface ApiKeyRow { creator_email: string; revoked_at?: string | Date | null }

export interface AccountRow {
  email: string;
  /** DD-41: agent = x402-funded and never signed in; else human. */
  kind: 'human' | 'agent';
  /** a human that also paid via the wallet rail (x402). */
  walletFunded: boolean;
  /** AC-185: holds ≥1 non-revoked API key. */
  programmatic: boolean;
  envelopes: { created: number; completed: number; inProcess: number };
  balanceUsdMicros: string;
  lastSeen: string | null;
  joined: string | null;
}

/**
 * F-34.3 / AC-184-185 — the Accounts page. One row per identity ACTIVE in the
 * window (created an envelope, opened an account, or had a session in-window),
 * with a derived Human/Agent(wallet) classification (DD-41), per-identity envelope
 * counts for the window, current balance, last-seen, and joined.
 */
export async function getAccounts(
  pool: DbPool,
  opts: { since: Date | null; now: Date; excludeInternal?: boolean; internalIdentities?: readonly string[] },
): Promise<AccountRow[]> {
  const { since } = opts;
  const ex = resolveExclude(opts);
  const [users, envelopes, ledger, sessions, keys] = await Promise.all([
    pool.query('SELECT email, balance_usd_micros, created_at FROM user_credits'),
    pool.query('SELECT sender_email, status, created_at, completed_at, internal_test FROM envelopes'),
    pool.query('SELECT email, source, delta_usd_micros, created_at FROM credit_ledger'),
    pool.query('SELECT email, last_used_at FROM auth_sessions'),
    pool.query('SELECT creator_email, revoked_at FROM api_keys'),
  ]);
  const userRows = (users.rows as UserRow[]).filter((u) => !identityDropped(u.email, ex));
  const envRows = (envelopes.rows as EnvRow[]).filter((e) => !envDropped(e, ex));
  const ledgerRows = (ledger.rows as CreditRow[]).filter((l) => !identityDropped(l.email, ex));
  const sessionRows = (sessions.rows as SessionRow[]).filter((s) => !identityDropped(s.email, ex));
  const keyRows = (keys.rows as ApiKeyRow[]).filter((k) => !identityDropped(k.creator_email, ex));

  const userByEmail = new Map(userRows.map((u) => [u.email, u]));
  const envByEmail = new Map<string, EnvRow[]>();
  for (const e of envRows) (envByEmail.get(e.sender_email) ?? envByEmail.set(e.sender_email, []).get(e.sender_email)!).push(e);
  const sourcesByEmail = new Map<string, Set<string>>();
  for (const l of ledgerRows) (sourcesByEmail.get(l.email) ?? sourcesByEmail.set(l.email, new Set()).get(l.email)!).add(l.source);
  const sessionMaxByEmail = new Map<string, string>();
  for (const s of sessionRows) {
    const iso = new Date(s.last_used_at).toISOString();
    const prev = sessionMaxByEmail.get(s.email);
    if (!prev || iso > prev) sessionMaxByEmail.set(s.email, iso);
  }
  const programmaticEmails = new Set(keyRows.filter((k) => k.revoked_at == null).map((k) => k.creator_email));

  const allEmails = new Set<string>([
    ...userByEmail.keys(),
    ...envByEmail.keys(),
    ...sourcesByEmail.keys(),
    ...sessionMaxByEmail.keys(),
  ]);

  const activeInWindow = (email: string): boolean => {
    if (since === null) return true;
    const u = userByEmail.get(email);
    if (u && inWindow(u.created_at, since)) return true;
    if ((envByEmail.get(email) ?? []).some((e) => inWindow(e.created_at, since))) return true;
    const seen = sessionMaxByEmail.get(email);
    if (seen && inWindow(seen, since)) return true;
    return false;
  };

  const rows: AccountRow[] = [];
  for (const email of allEmails) {
    if (!activeInWindow(email)) continue;
    const sources = sourcesByEmail.get(email) ?? new Set<string>();
    const hasSession = sessionMaxByEmail.has(email);
    const hasSignupGrant = sources.has('signup_grant');
    const hasX402 = sources.has('x402');
    const cohort = (envByEmail.get(email) ?? []).filter((e) => inWindow(e.created_at, since));
    rows.push({
      email,
      kind: hasSession || hasSignupGrant ? 'human' : 'agent',
      walletFunded: hasX402,
      programmatic: programmaticEmails.has(email),
      envelopes: {
        created: cohort.length,
        completed: cohort.filter((e) => e.status === 'completed').length,
        inProcess: cohort.filter((e) => IN_PROCESS.has(e.status)).length,
      },
      balanceUsdMicros: String(userByEmail.get(email)?.balance_usd_micros ?? '0'),
      lastSeen: sessionMaxByEmail.get(email) ?? null,
      joined: userByEmail.get(email) ? new Date(userByEmail.get(email)!.created_at).toISOString() : null,
    });
  }
  // Most-recently-active first (a session beats no session); tiebreak by joined.
  rows.sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '') || (b.joined ?? '').localeCompare(a.joined ?? ''));
  return rows;
}

interface EnvListRow {
  id: string; sender_email: string; document_name: string;
  status: string; created_at: string | Date; completed_at?: string | Date | null; internal_test?: boolean;
}

export interface EnvelopeFunnelResult {
  created: number;
  completed: number;
  /** completed / created (0 when nothing was created). */
  completionRate: number;
  /** mean (completed_at − created_at) over completed envelopes, ms; null if none. */
  avgTimeToCompleteMs: number | null;
  /** in-process (active/awaiting_seal) envelopes bucketed by age. */
  aging: { lt1d: number; d1to3: number; d3to7: number; gt7d: number };
  voided: number;
  expired: number;
  list: Array<{ id: string; sender_email: string; document_name: string; status: string; created_at: string; completed_at: string | null }>;
}

/**
 * F-34.4 / AC-186 — the Envelopes page funnel for the window's create-cohort:
 * created/completed + rate, mean time-to-complete, in-process aging buckets,
 * void/expire counts, and a newest-first drill-down list.
 */
export async function getEnvelopeFunnel(
  pool: DbPool,
  opts: { since: Date | null; now: Date; excludeInternal?: boolean; internalIdentities?: readonly string[] },
): Promise<EnvelopeFunnelResult> {
  const { since, now } = opts;
  const ex = resolveExclude(opts);
  const res = await pool.query(
    'SELECT id, sender_email, document_name, status, created_at, completed_at, internal_test FROM envelopes',
  );
  const cohort = (res.rows as EnvListRow[]).filter((e) => !envDropped(e, ex) && inWindow(e.created_at, since));

  const created = cohort.length;
  const completed = cohort.filter((e) => e.status === 'completed').length;
  const completionRate = created === 0 ? 0 : completed / created;

  const done = cohort.filter((e) => e.status === 'completed' && e.completed_at != null);
  const avgTimeToCompleteMs = done.length === 0
    ? null
    : Math.round(
        done.reduce((sum, e) => sum + (new Date(e.completed_at!).getTime() - new Date(e.created_at).getTime()), 0) / done.length,
      );

  const aging = { lt1d: 0, d1to3: 0, d3to7: 0, gt7d: 0 };
  for (const e of cohort) {
    if (!IN_PROCESS.has(e.status)) continue;
    const age = now.getTime() - new Date(e.created_at).getTime();
    if (age < D) aging.lt1d += 1;
    else if (age < 3 * D) aging.d1to3 += 1;
    else if (age < 7 * D) aging.d3to7 += 1;
    else aging.gt7d += 1;
  }

  const list = [...cohort]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 200)
    .map((e) => ({
      id: String(e.id),
      sender_email: e.sender_email,
      document_name: e.document_name,
      status: e.status,
      created_at: new Date(e.created_at).toISOString(),
      completed_at: e.completed_at ? new Date(e.completed_at).toISOString() : null,
    }));

  return {
    created,
    completed,
    completionRate,
    avgTimeToCompleteMs,
    aging,
    voided: cohort.filter((e) => e.status === 'voided').length,
    expired: cohort.filter((e) => e.status === 'expired').length,
    list,
  };
}

interface SignerRow { envelope_id: string; status: string; undeliverable_at?: string | Date | null }

export interface SignalsResult {
  deliverability: { invited: number; signed: number; undeliverable: number };
  agentAdoption: { walletCreates: number; humanCreates: number; apiKeyHolders: number };
}

/**
 * F-34.5 / AC-187 — operator-health signals for the window: signer deliverability
 * (invited / signed / undeliverable-hard-bounce, over signers of envelopes created
 * in-window) and agent adoption (wallet-vs-human create share — a create counts as
 * wallet if its creator ever funded via x402 — plus the count of identities holding
 * a non-revoked API key).
 */
export async function getSignals(
  pool: DbPool,
  opts: { since: Date | null; excludeInternal?: boolean; internalIdentities?: readonly string[] },
): Promise<SignalsResult> {
  const { since } = opts;
  const ex = resolveExclude(opts);
  const [envs, signers, ledger, keys] = await Promise.all([
    pool.query('SELECT id, sender_email, created_at, internal_test FROM envelopes'),
    pool.query('SELECT envelope_id, status, undeliverable_at FROM envelope_signers'),
    pool.query('SELECT email, source FROM credit_ledger'),
    pool.query('SELECT creator_email, revoked_at FROM api_keys'),
  ]);
  const inWindowEnvs = (envs.rows as Array<{ id: string; sender_email: string; created_at: string | Date; internal_test?: boolean }>)
    .filter((e) => !envDropped(e, ex) && inWindow(e.created_at, since));
  const inWindowIds = new Set(inWindowEnvs.map((e) => String(e.id)));

  const relevantSigners = (signers.rows as SignerRow[]).filter((s) => inWindowIds.has(String(s.envelope_id)));
  const deliverability = {
    invited: relevantSigners.length,
    signed: relevantSigners.filter((s) => s.status === 'signed').length,
    undeliverable: relevantSigners.filter((s) => s.undeliverable_at != null).length,
  };

  const x402Emails = new Set(
    (ledger.rows as Array<{ email: string; source: string }>).filter((l) => l.source === 'x402').map((l) => l.email),
  );
  let walletCreates = 0;
  let humanCreates = 0;
  for (const e of inWindowEnvs) {
    if (x402Emails.has(e.sender_email)) walletCreates += 1;
    else humanCreates += 1;
  }
  const apiKeyHolders = new Set(
    (keys.rows as ApiKeyRow[])
      .filter((k) => k.revoked_at == null && !identityDropped(k.creator_email, ex))
      .map((k) => k.creator_email),
  ).size;

  return { deliverability, agentAdoption: { walletCreates, humanCreates, apiKeyHolders } };
}
