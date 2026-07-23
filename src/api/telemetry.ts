/**
 * telemetry — F-38 pre-signin funnel collection endpoint (spec 0.59.0, DD-50).
 *
 * POST /v1/telemetry — necessarily public, so everything is bounded at the
 * door (F-38.7): event names against a fixed vocabulary (server-recorded step
 * names are REJECTED from the browser — a bot may not fabricate funnel
 * bottoms), `page`/`element` normalized against fixed allowlists (a URL
 * carrying an envelope id or signer token can never become a stored value —
 * F-38.1), oversized/malformed dropped, a per-page-load record cap, and an
 * in-memory per-source rate limit (the address is held in memory for that
 * purpose only and never written). The response is always silent success —
 * collection never surfaces an error to a visitor (F-38.2).
 *
 * Rail disabled (the fork default — no ctx built) → accept-and-drop with zero
 * database work (AC-221).
 */
import type { DbPool } from '../db/pool.js';
import { insertTelemetryEvents, type TelemetryEventRow } from '../db/telemetryEvents.js';
import { deriveCountry, deriveSourceBucket } from './telemetryDerive.js';

// ── vocabulary ──────────────────────────────────────────────────────────────

/** Events the browser rail may submit. */
const BROWSER_EVENTS = new Set([
  'page_view',
  'click',
  'scroll',
  'signin_prompt',
  'signin_email_focus',
  'signin_submit',
]);

/** Server-recorded funnel steps (F-38.4) — never accepted from a browser. */
export const SERVER_EVENTS = new Set(['send_ok', 'send_failed', 'link_opened', 'session_created']);

/** The fixed set of known public pages (F-38.1 normalization targets). */
const PAGES = new Set([
  'home',
  'faq',
  'pricing',
  'how_it_works',
  'how_it_works_technical',
  'saas_vs_repo',
  'privacy',
  'terms',
  'cookies',
  'aup',
  'dpa',
  'auth_callback',
  'signin',
  'sign',
  'review',
  'verify',
  'hashcheck',
  'dashboard',
  'account',
  'admin',
  'other',
]);

/** First-path-segment → page name (ids/tokens in deeper segments never survive). */
const SEGMENT_TO_PAGE: Record<string, string> = {
  '': 'home',
  'index': 'home',
  'faq': 'faq',
  'pricing': 'pricing',
  'how-it-works': 'how_it_works',
  'how-it-works-technical': 'how_it_works_technical',
  'saas-vs-repo': 'saas_vs_repo',
  'privacy': 'privacy',
  'terms': 'terms',
  'cookies': 'cookies',
  'aup': 'aup',
  'dpa': 'dpa',
  'auth-callback': 'auth_callback',
  'signin': 'signin',
  'sign': 'sign',
  'review': 'review',
  'verify': 'verify',
  'hashcheck': 'hashcheck',
  'dashboard': 'dashboard',
  'account': 'account',
  'admin': 'admin',
};

/** F-38.2 named clickables and where they sit. */
const NAMED_CLICKABLES = new Set(['cta_create', 'signin', 'pricing', 'how_it_works', 'verify', 'repo', 'video']);
const CLICK_LOCATIONS = new Set(['hero', 'header', 'footer', 'pricing', 'audience_card']);

const SCROLL_THRESHOLDS = new Set(['25', '50', '75', '100']);
const PROMPT_TRIGGERS = new Set(['direct', 'redirect']);

// ── caps (F-38.7) ───────────────────────────────────────────────────────────

export const TELEMETRY_MAX_RECORDS_PER_POST = 25;
/** A single page load may number records only this far. */
export const TELEMETRY_MAX_PAGE_SEQ = 60;
const MAX_RAW_FIELD_LEN = 256;

// ── page normalization ──────────────────────────────────────────────────────

/**
 * Normalize a raw path / URL / page name against the fixed page set. Query and
 * hash are stripped first, only the FIRST path segment is consulted, and
 * anything unknown records as 'other' — so an envelope id or signer token can
 * never become a stored value.
 */
export function normalizeTelemetryPage(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RAW_FIELD_LEN * 4) return 'other';
  let path = raw;
  try {
    if (/^https?:\/\//i.test(raw)) path = new URL(raw).pathname;
  } catch {
    return 'other';
  }
  path = path.split('?')[0].split('#')[0];
  if (PAGES.has(path)) return path; // already a normalized name
  const seg = path.replace(/^\/+/, '').split('/')[0].toLowerCase().replace(/\.html$/, '');
  return SEGMENT_TO_PAGE[seg] ?? 'other';
}

// ── element validation ──────────────────────────────────────────────────────

function validElement(event: string, element: unknown): string | null | undefined {
  // undefined = record invalid (drop); null = valid with no element.
  if (element !== undefined && element !== null && typeof element !== 'string') return undefined;
  const el = typeof element === 'string' ? element : null;
  if (el !== null && el.length > MAX_RAW_FIELD_LEN) return undefined;
  switch (event) {
    case 'page_view':
    case 'signin_email_focus':
    case 'signin_submit':
      return null; // element ignored on element-less events
    case 'scroll':
      return el !== null && SCROLL_THRESHOLDS.has(el) ? el : undefined;
    case 'signin_prompt':
      return el !== null && PROMPT_TRIGGERS.has(el) ? el : undefined;
    case 'click': {
      if (el === null) return undefined;
      const sep = el.indexOf(':');
      if (sep <= 0) return undefined;
      const name = el.slice(0, sep);
      const rest = el.slice(sep + 1);
      if (name === 'other') {
        // Catch-all carries a NORMALIZED destination: a known page or 'external'.
        return rest === 'external' || PAGES.has(rest) ? el : undefined;
      }
      return NAMED_CLICKABLES.has(name) && CLICK_LOCATIONS.has(rest) ? el : undefined;
    }
    default:
      return undefined;
  }
}

// ── per-source rate limiting (in-memory only) ───────────────────────────────

export interface TelemetryLimiter {
  /** true → this source may record now; false → drop silently. */
  allow(sourceAddr: string | null, now: number): boolean;
}

/**
 * Sliding-window per-source limiter. The address lives ONLY in this map, is
 * never written anywhere, and the map is pruned so a flood of distinct
 * sources cannot grow memory unboundedly.
 */
export function createTelemetryLimiter(opts: { maxPostsPerWindow?: number; windowMs?: number; maxSources?: number } = {}): TelemetryLimiter {
  const maxPosts = opts.maxPostsPerWindow ?? 30;
  const windowMs = opts.windowMs ?? 60_000;
  const maxSources = opts.maxSources ?? 10_000;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    allow(sourceAddr, now) {
      const key = sourceAddr ?? 'unknown';
      let w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        if (windows.size >= maxSources) {
          for (const [k, v] of windows) {
            if (now - v.start >= windowMs) windows.delete(k);
          }
          if (windows.size >= maxSources) windows.clear(); // hard bound over precision
        }
        w = { start: now, count: 0 };
        windows.set(key, w);
      }
      w.count += 1;
      return w.count <= maxPosts;
    },
  };
}

// ── the collection handler ──────────────────────────────────────────────────

export interface TelemetryCollectCtx {
  pool: DbPool;
  /** The deployment's own host — an own-host referrer buckets as direct. */
  ownHost: string;
  limiter: TelemetryLimiter;
  /** Test seam; defaults to wall clock. */
  now?: () => Date;
}

/**
 * Process one collection POST. NEVER throws and returns nothing — the caller
 * answers the visitor with silent success regardless (the response body is
 * not part of this rail's contract). `ctx` undefined = rail disabled (fork
 * default): accept-and-drop, zero database work.
 */
export async function handleTelemetryCollect(
  ctx: TelemetryCollectCtx | undefined,
  req: { body: unknown; headers: Headers; sourceAddr: string | null },
): Promise<void> {
  if (!ctx) return;
  try {
    const now = ctx.now ? ctx.now() : new Date();
    if (!ctx.limiter.allow(req.sourceAddr, now.getTime())) return;

    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return;
    const b = body as Record<string, unknown>;
    if (typeof b.page !== 'string' || !Array.isArray(b.records)) return;

    const page = normalizeTelemetryPage(b.page);
    // F-38.5 derivation riders — used here, then DISCARDED. Never stored.
    const referrer = typeof b.ref === 'string' && b.ref.length <= MAX_RAW_FIELD_LEN * 8 ? b.ref : null;
    const gclidPresent = b.gclid === true;
    const source = deriveSourceBucket({ referrer, gclidPresent, ownHost: ctx.ownHost });
    const country = deriveCountry(req.headers);

    const rows: TelemetryEventRow[] = [];
    for (const raw of b.records) {
      if (rows.length >= TELEMETRY_MAX_RECORDS_PER_POST) break;
      if (typeof raw !== 'object' || raw === null) continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.event !== 'string' || !BROWSER_EVENTS.has(r.event)) continue;
      const element = validElement(r.event, r.element);
      if (element === undefined) continue;
      const seq = typeof r.seq === 'number' && Number.isInteger(r.seq) && r.seq >= 0 && r.seq <= TELEMETRY_MAX_PAGE_SEQ ? r.seq : null;
      if (seq === null) continue;
      rows.push({ occurredAt: now, event: r.event, page, element, country, source, pageSeq: seq });
    }
    if (rows.length === 0) return;
    await insertTelemetryEvents(ctx.pool, rows);
  } catch {
    // Silent drop on ANY failure — collection never surfaces an error (F-38.2).
  }
}
