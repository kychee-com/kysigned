/**
 * telemetry — F-38 browser rail (spec 0.59.0, DD-50; AC-214/AC-215).
 *
 * The consent-independent, identifier-free funnel measurement: ONE delegated
 * click listener resolves elements against the declarative registry
 * (`data-telemetry="name:location"` markup — measuring one more element is one
 * attribute, zero code), unnamed links record a catch-all with their
 * NORMALIZED destination, the home page records scroll depth once per
 * threshold, and everything batches to `POST /v1/telemetry` via sendBeacon so
 * a record survives the visitor leaving the page.
 *
 * Identifier-free by construction: NO cookie, NO local/session storage read
 * or write, no click-id value (presence only), and the per-page-load seq
 * lives only in module memory — a new page (or SPA soft-nav) is a new
 * sequence, never joinable to the last. Every failure is silent; collection
 * never blocks or alters navigation.
 *
 * Static pages run the same rail via /telemetry.mjs (frontend/public/) — a
 * standalone vanilla mirror; the interop tests in telemetry.test.ts hold the
 * two implementations to the same wire shape.
 */
import { getOperatorConfig } from '../config/operator';

export const TELEMETRY_ENDPOINT = '/v1/telemetry';
/** Per-page-load record cap — mirrors the server's TELEMETRY_MAX_PAGE_SEQ. */
export const TELEMETRY_PAGE_CAP = 60;
/** Records per POST — mirrors the server's TELEMETRY_MAX_RECORDS_PER_POST. */
const BATCH_CAP = 25;

export interface TelemetryRecord {
  event: string;
  element?: string;
  seq: number;
}

/** Wire shape of one collection POST (the server normalizes + derives + discards). */
export interface TelemetryBatch {
  page: string;
  ref: string;
  gclid: boolean;
  records: TelemetryRecord[];
}

/** Segment → page-name mirror of the server's allowlist (catch-all destinations). */
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

/**
 * Normalize a click destination for the catch-all bucket: a same-origin path
 * becomes its page name (unknown → 'other'), anything off-origin is
 * 'external'. Ids, tokens, and query strings never survive.
 */
export function normalizeDestination(href: string, ownHost: string): string {
  try {
    if (/^https?:\/\//i.test(href)) {
      const u = new URL(href);
      const host = u.hostname.toLowerCase();
      const own = ownHost.toLowerCase();
      if (host !== own && !host.endsWith(`.${own}`)) return 'external';
      href = u.pathname;
    }
  } catch {
    return 'external';
  }
  const seg = href.split('?')[0].split('#')[0].replace(/^\/+/, '').split('/')[0].toLowerCase().replace(/\.html$/, '');
  return SEGMENT_TO_PAGE[seg] ?? 'other';
}

export interface TelemetryRailOptions {
  enabled?: boolean;
  /** Transport override (tests). Default: sendBeacon, then keepalive fetch. */
  send?: (batch: TelemetryBatch) => boolean;
  referrer?: string;
  search?: string;
  ownHost?: string;
  endpoint?: string;
}

interface PageState {
  page: string;
  seq: number;
  queue: TelemetryRecord[];
  scrollFired: Set<string>;
  emittedOnce: Set<string>;
}

function defaultSend(endpoint: string, batch: TelemetryBatch): boolean {
  try {
    const body = JSON.stringify(batch);
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      return navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
    }
    void fetch(endpoint, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(
      () => {},
    );
    return true;
  } catch {
    return false;
  }
}

export function createTelemetryRail(opts: TelemetryRailOptions = {}) {
  const enabled = opts.enabled ?? getOperatorConfig().telemetry;
  const endpoint = opts.endpoint ?? TELEMETRY_ENDPOINT;
  const send = opts.send ?? ((b: TelemetryBatch) => defaultSend(endpoint, b));
  const referrer = opts.referrer ?? (typeof document !== 'undefined' ? document.referrer : '');
  const search = opts.search ?? (typeof window !== 'undefined' ? window.location.search : '');
  const ownHost = opts.ownHost ?? (typeof window !== 'undefined' ? window.location.hostname : '');
  const gclid = /[?&]gclid=/.test(search);

  let state: PageState | null = null;
  let attached = false;

  function flush(): void {
    if (!enabled || !state || state.queue.length === 0) return;
    const records = state.queue.splice(0, state.queue.length);
    try {
      for (let i = 0; i < records.length; i += BATCH_CAP) {
        send({ page: state.page, ref: referrer, gclid, records: records.slice(i, i + BATCH_CAP) });
      }
    } catch {
      // Silent — collection never surfaces an error (F-38.2).
    }
  }

  function push(event: string, element?: string): void {
    if (!enabled || !state) return;
    if (state.seq >= TELEMETRY_PAGE_CAP) return;
    state.seq += 1;
    const rec: TelemetryRecord = element === undefined ? { event, seq: state.seq } : { event, element, seq: state.seq };
    state.queue.push(rec);
    if (state.queue.length >= BATCH_CAP) flush();
  }

  function pageView(page: string): void {
    if (!enabled) return;
    if (state) flush(); // close out the previous page's sequence (SPA soft-nav)
    state = { page, seq: 0, queue: [], scrollFired: new Set(), emittedOnce: new Set() };
    push('page_view');
  }

  /** True on the (normalized) home page — scroll depth is home-only (F-38.2). */
  function onHome(): boolean {
    if (!state) return false;
    const seg = state.page.split('?')[0].replace(/^\/+/, '').split('/')[0].toLowerCase().replace(/\.html$/, '');
    return (SEGMENT_TO_PAGE[seg] ?? 'other') === 'home';
  }

  function handleClick(target: EventTarget | null): void {
    if (!enabled || !state) return;
    try {
      const el = target instanceof Element ? target : null;
      if (!el) return;
      const named = el.closest('[data-telemetry]');
      if (named) {
        const value = named.getAttribute('data-telemetry') ?? '';
        if (value !== '') push('click', value);
        return;
      }
      const link = el.closest('a[href]');
      if (link) push('click', `other:${normalizeDestination(link.getAttribute('href') ?? '', ownHost)}`);
    } catch {
      // Silent.
    }
  }

  function handleScroll(): void {
    if (!enabled || !state || !onHome()) return;
    try {
      const doc = document.documentElement;
      const max = Math.max(1, doc.scrollHeight - window.innerHeight);
      const pct = ((window.scrollY ?? 0) / max) * 100;
      for (const threshold of ['25', '50', '75', '100']) {
        if (pct >= Number(threshold) && !state.scrollFired.has(threshold)) {
          state.scrollFired.add(threshold);
          push('scroll', threshold);
        }
      }
    } catch {
      // Silent.
    }
  }

  /**
   * Emit an event at most once per page load (the sign-in email-field focus
   * fact — F-38.3 — and any future once-per-load step).
   */
  function eventOnce(event: string, element?: string): void {
    if (!enabled || !state) return;
    const key = `${event}|${element ?? ''}`;
    if (state.emittedOnce.has(key)) return;
    state.emittedOnce.add(key);
    push(event, element);
  }

  function attach(doc: Document): void {
    if (!enabled || attached) return;
    attached = true;
    try {
      doc.addEventListener('click', (e) => handleClick(e.target), { capture: true, passive: true });
      window.addEventListener('scroll', () => handleScroll(), { passive: true });
      window.addEventListener('pagehide', () => flush());
      doc.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'hidden') flush();
      });
    } catch {
      // Silent.
    }
  }

  return {
    pageView,
    event: push,
    eventOnce,
    flush,
    attach,
    /** Test seams. */
    handleClick,
    handleScroll,
  };
}

// ── module singleton for the SPA ────────────────────────────────────────────

let rail: ReturnType<typeof createTelemetryRail> | null = null;

/** The SPA's shared rail (config-gated; a fresh fork's rail sends nothing). */
export function getTelemetryRail(): ReturnType<typeof createTelemetryRail> {
  if (!rail) {
    rail = createTelemetryRail();
    if (typeof document !== 'undefined') rail.attach(document);
  }
  return rail;
}

/** App route-change hook: one page view per SPA page (a new sequence each). */
export function telemetryPageView(page: string): void {
  getTelemetryRail().pageView(page);
}

export function telemetryEvent(event: string, element?: string): void {
  getTelemetryRail().event(event, element);
}

export function telemetryEventOnce(event: string, element?: string): void {
  getTelemetryRail().eventOnce(event, element);
}
