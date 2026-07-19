/**
 * Admin API — F2.8 management endpoints for allowed_senders.
 *
 * The library exposes pure handlers; the deploying service wires authentication
 * (e.g., static admin token, session cookie, or platform IAM) before calling them.
 */
import type { DbPool } from '../db/pool.js';
import {
  addAllowedSender,
  removeAllowedSender,
  listAllowedSenders,
  type IdentityType,
} from '../db/allowedSenders.js';
import { listOutstandingArchiveConfirmations } from '../db/signatureArtifacts.js';
import { parseWindow, parseExcludeInternal } from './adminWindow.js';
import { getOverview, getAccounts, getEnvelopeFunnel, getSignals, listCreditLedger, listActiveIdentities } from '../db/adminAnalytics.js';

export interface AdminContext {
  pool: DbPool;
  operator: string; // identity of the human/system making the change (audit trail)
  /** F-35 — console internal-identity exclusion rules (from AppDeps.internalIdentities). */
  internalIdentities?: readonly string[];
}

export interface AddAllowedSenderRequest {
  identity_type: IdentityType;
  identity: string;
  quota_per_month: number | null;
  note?: string | null;
}

const VALID_IDENTITY_TYPES: IdentityType[] = ['email', 'email_domain'];

export async function handleAddAllowedSender(ctx: AdminContext, req: AddAllowedSenderRequest) {
  if (!VALID_IDENTITY_TYPES.includes(req.identity_type)) {
    return { status: 400, body: { error: 'identity_type must be "email" or "email_domain"', code: 'validation_identity_type' } };
  }
  if (!req.identity || req.identity.trim() === '') {
    return { status: 400, body: { error: 'identity is required', code: 'validation_identity' } };
  }
  if (req.quota_per_month !== null && req.quota_per_month !== undefined && req.quota_per_month < 0) {
    return { status: 400, body: { error: 'quota_per_month must be >= 0 or null', code: 'validation_quota' } };
  }

  const row = await addAllowedSender(ctx.pool, {
    identity_type: req.identity_type,
    identity: req.identity,
    quota_per_month: req.quota_per_month ?? null,
    added_by: ctx.operator,
    note: req.note ?? null,
  });

  return { status: 201, body: row };
}

export async function handleRemoveAllowedSender(
  ctx: AdminContext,
  identity_type: IdentityType,
  identity: string
) {
  if (!VALID_IDENTITY_TYPES.includes(identity_type)) {
    return { status: 400, body: { error: 'identity_type must be "email" or "email_domain"', code: 'validation_identity_type' } };
  }
  const removed = await removeAllowedSender(ctx.pool, identity_type, identity);
  if (!removed) {
    return { status: 404, body: { error: 'Sender not found', code: 'not_found' } };
  }
  return { status: 200, body: { removed: true } };
}

export async function handleListAllowedSenders(ctx: AdminContext) {
  const rows = await listAllowedSenders(ctx.pool);
  return { status: 200, body: rows };
}

/**
 * F-33.3 (#148) — the operator dashboard's archive-confirmation reconciliation view.
 * Returns the outstanding (non-clean) artifacts with envelope + signer context, the
 * confirmation state (NULL surfaced as `unknown`), and the confirmation timestamps —
 * read from the same signature_artifacts fields F-32.6/F-32.7 write (no parallel store).
 */
export async function handleListArchiveConfirmations(ctx: AdminContext, excludeInternalParam: string | null) {
  const excludeInternal = parseExcludeInternal(excludeInternalParam);
  const artifacts = await listOutstandingArchiveConfirmations(ctx.pool, { excludeInternal, internalIdentities: ctx.internalIdentities ?? [] });
  const outstanding = artifacts.map((a) => ({
    envelope_id: a.envelope_id,
    signer_email: a.signer_email,
    dkim_domain: a.dkim_domain,
    dkim_selector: a.dkim_selector,
    state: a.archive_confirmation ?? 'unknown',
    checked_at: a.archive_confirmation_checked_at ? a.archive_confirmation_checked_at.toISOString() : null,
    healed_at: a.archive_confirmation_healed_at ? a.archive_confirmation_healed_at.toISOString() : null,
    created_at: a.created_at.toISOString(),
  }));
  return { status: 200, body: { excludeInternal, outstanding } };
}

/**
 * F-34.2 (#148) — the operator console's Overview page: window-scoped headline
 * KPIs (accounts opened, envelope funnel, credits summary, active users). The
 * `?window=` param normalizes via `parseWindow`; the applied window is echoed back.
 */
export async function handleGetOverview(ctx: AdminContext, windowParam: string | null, excludeInternalParam: string | null) {
  const w = parseWindow(windowParam);
  const excludeInternal = parseExcludeInternal(excludeInternalParam);
  const overview = await getOverview(ctx.pool, { since: w.since, now: new Date(), excludeInternal, internalIdentities: ctx.internalIdentities ?? [] });
  return { status: 200, body: { window: w.key, excludeInternal, ...overview } };
}

/**
 * F-34.6 (#161) — the money-KPI drill-down: the ledger rows behind one Overview
 * tile (paid_in / granted / consumed) for the same window + exclude-internal
 * state. Identities and amounts are operator metadata (F-33.5) — this is where
 * the F-36 events' ids join back to people, inside kysigned.
 */
/**
 * F-34.8 / AC-203 — the Active tile's drill-down: the identities counted by the
 * Overview's active figure, for the SAME window + exclude-internal state. Shares
 * `activeEmailsInWindow` with the count, so the list can never disagree with the tile.
 */
export async function handleGetActiveIdentities(
  ctx: AdminContext,
  windowParam: string | null,
  excludeInternalParam: string | null,
) {
  const w = parseWindow(windowParam);
  const excludeInternal = parseExcludeInternal(excludeInternalParam);
  const rows = await listActiveIdentities(ctx.pool, {
    since: w.since,
    now: new Date(),
    excludeInternal,
    internalIdentities: ctx.internalIdentities ?? [],
  });
  return { status: 200, body: { window: w.key, excludeInternal, rows } };
}

export async function handleGetLedger(
  ctx: AdminContext,
  windowParam: string | null,
  excludeInternalParam: string | null,
  groupParam: string | null,
) {
  const group = groupParam ?? '';
  if (group !== 'paid_in' && group !== 'granted' && group !== 'consumed') {
    return { status: 400, body: { error: 'group must be paid_in, granted, or consumed', code: 'validation_group' } };
  }
  const w = parseWindow(windowParam);
  const excludeInternal = parseExcludeInternal(excludeInternalParam);
  const rows = await listCreditLedger(ctx.pool, {
    since: w.since,
    group,
    excludeInternal,
    internalIdentities: ctx.internalIdentities ?? [],
  });
  return {
    status: 200,
    body: {
      window: w.key,
      excludeInternal,
      group,
      rows: rows.map((r) => ({
        id: r.id,
        email: r.email,
        delta_usd_micros: r.deltaUsdMicros,
        source: r.source,
        external_ref: r.externalRef,
        created_at: r.createdAt,
      })),
    },
  };
}

/**
 * F-34.3 (#148) — the operator console's Accounts page: one row per identity
 * active in the window, with a Human/Agent(wallet) classification, per-identity
 * envelope counts, balance, last-seen, and joined.
 */
export async function handleGetAccounts(ctx: AdminContext, windowParam: string | null, excludeInternalParam: string | null) {
  const w = parseWindow(windowParam);
  const excludeInternal = parseExcludeInternal(excludeInternalParam);
  const accounts = await getAccounts(ctx.pool, { since: w.since, now: new Date(), excludeInternal, internalIdentities: ctx.internalIdentities ?? [] });
  return { status: 200, body: { window: w.key, excludeInternal, accounts } };
}

/**
 * F-34.4 (#148) — the operator console's Envelopes page: the create-cohort funnel
 * (created/completed + rate, mean time-to-complete, in-process aging, void/expire)
 * plus a drill-down list, for the window.
 */
export async function handleGetEnvelopes(ctx: AdminContext, windowParam: string | null, excludeInternalParam: string | null) {
  const w = parseWindow(windowParam);
  const excludeInternal = parseExcludeInternal(excludeInternalParam);
  const funnel = await getEnvelopeFunnel(ctx.pool, { since: w.since, now: new Date(), excludeInternal, internalIdentities: ctx.internalIdentities ?? [] });
  return { status: 200, body: { window: w.key, excludeInternal, ...funnel } };
}

/**
 * F-34.5 (#148) — the operator console's signals: signer deliverability + agent
 * adoption for the window.
 */
export async function handleGetSignals(ctx: AdminContext, windowParam: string | null, excludeInternalParam: string | null) {
  const w = parseWindow(windowParam);
  const excludeInternal = parseExcludeInternal(excludeInternalParam);
  const signals = await getSignals(ctx.pool, { since: w.since, excludeInternal, internalIdentities: ctx.internalIdentities ?? [] });
  return { status: 200, body: { window: w.key, excludeInternal, ...signals } };
}
