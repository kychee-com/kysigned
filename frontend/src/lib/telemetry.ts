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
 * Identifier-free by construction: NO cookie, NO browser-storage WRITE of any
 * kind, no click-id value (presence only), and the per-page-load seq lives
 * only in module memory — a new page (or SPA soft-nav) is a new sequence,
 * never joinable to the last. The rail makes exactly ONE storage read (spec
 * 0.64.0, F-38.1/F-38.5): it asks the F-37 first-party ad-click record whether
 * this VISIT arrived from an ad, and keeps only that yes/no — see `paidVisit`.
 * Every failure is silent; collection never blocks or alters navigation.
 *
 * Static pages run the same rail via /telemetry.mjs (frontend/public/) — a
 * standalone vanilla mirror; the interop tests in telemetry.test.ts hold the
 * two implementations to the same wire shape.
 */
import { getOperatorConfig } from '../config/operator';
import { readStoredAttribution } from './attribution';
import { CLIENT_TELEMETRY_EVENTS, type ClientTelemetryEvent } from './telemetryEvents';

export { CLIENT_TELEMETRY_EVENTS };
export type { ClientTelemetryEvent };

export const TELEMETRY_ENDPOINT = '/v1/telemetry';
/** Per-page-load record cap — mirrors the server's TELEMETRY_MAX_PAGE_SEQ. */
export const TELEMETRY_PAGE_CAP = 60;
/** Records per POST — mirrors the server's TELEMETRY_MAX_RECORDS_PER_POST. */
const BATCH_CAP = 25;
/**
 * How long a queued record may wait before it is sent anyway (FC30.1/BT-30.1).
 *
 * The rail used to reach `flush()` from exactly three places — `pagehide`,
 * `visibilitychange → hidden`, and the 25-record batch cap — so a page load
 * that ended without a DELIVERED `pagehide` lost its whole batch, `page_view`
 * included: a discarded tab, an OS kill on mobile, a crash, or an automated
 * ceremony that just closes its context. That is measurement loss for exactly
 * the abandoning-visitor cohort these diagnostics exist to count.
 *
 * This is a delivery fix, not a chattiness regression: the debounce re-arms on
 * every queued record, so a burst (page view → a click → the click's follow-on
 * fact) coalesces into ONE POST, and a visitor who navigates inside the window
 * still leaves on the `pagehide` backstop with no extra POST at all. An
 * ordinary page load therefore stays at ~1–3 posts, nowhere near the server's
 * per-source limiter (`createTelemetryLimiter`, 30 posts / 60 s).
 *
 * `frontend/public/telemetry.mjs` MUST use the same value — the interop tests
 * hold the two implementations to one timing contract, not just one wire shape.
 */
export const FLUSH_DEBOUNCE_MS = 2000;

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
  /**
   * 0.60.0 — the campaign rider: the landing URL's raw `utm_campaign` value
   * (the server normalizes + stores the bounded token). Held in page memory
   * only; omitted entirely when the load carried none.
   */
  utm?: string;
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

/**
 * True on the EDITOR (`/dashboard/create`) — F-39.5 / AC-227.
 *
 * The editor's measured events are exactly the funnel steps it fires by hand
 * (`draft_started`, `send_clicked`) plus the two F-44.4 affordance facts. The
 * F-38.2 every-clickable rule does NOT extend to it, so neither click bucket
 * may record here — not the catch-all, and not a named `[data-telemetry]`
 * element either (the site header renders above this page and carries several).
 *
 * TRAP (this is why the guard is its own function): it mirrors the SERVER's
 * `normalizeTelemetryPage` editor rule, NOT the client's `SEGMENT_TO_PAGE` —
 * that map has no `create` entry at all, because only the server splits
 * `/dashboard/create` out of `dashboard`. A guard written as
 * `normalizeDestination(page) === 'create'` therefore silently never fires.
 * Exactly like the server rule, it matches `/dashboard/create` and nothing
 * deeper, so an envelope id under `/dashboard/*` is unaffected.
 */
export function isEditorPage(page: string): boolean {
  if (typeof page !== 'string') return false;
  const path = page.split('?')[0].split('#')[0];
  if (path === 'create') return true; // an already-normalized page name
  const segs = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  return segs.length === 2 && segs[0].toLowerCase() === 'dashboard' && segs[1].toLowerCase() === 'create';
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
  /** This page load's paid answer (F-38.5) — see `paidVisit`. */
  gclid: boolean;
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
  const urlGclid = /[?&]gclid=/.test(search);
  // 0.60.0 — the landing load's campaign tag, kept in module memory for the
  // life of this page load (soft-navs included). Never stored anywhere.
  let utm: string | null = null;
  try {
    utm = new URLSearchParams(search).get('utm_campaign');
  } catch {
    utm = null;
  }

  let state: PageState | null = null;
  let attached = false;

  /**
   * 0.64.0 (F-38.5) — paid is a property of the VISIT, not of one page load:
   * only an ad visit's LANDING url ever carries the click id, so every later
   * page asks the F-37 first-party record (`attribution.ts`) whether this
   * visitor arrived from an ad and is still inside that record's window.
   *
   * PRESENCE ONLY: the click-id value is never read into the batch, never
   * sent, and never stored — the wire stays the same yes/no fact. This is the
   * rail's ONE browser-storage read; it still writes nothing (F-38.1), and it
   * happens only when the rail is enabled (a fresh fork reads nothing).
   */
  function paidVisit(): boolean {
    if (urlGclid) return true;
    return readStoredAttribution() !== null;
  }

  /**
   * FC30.1 — the bounded debounce that lets a record leave a page that is still
   * alive. Armed only from `push()` (so a disabled rail schedules nothing, and
   * a fresh fork stays inert — AC-221), re-armed on each new record, and
   * disarmed by every flush so a teardown flush is never double-sent.
   */
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelScheduledFlush(): void {
    if (flushTimer === null) return;
    try {
      clearTimeout(flushTimer);
    } catch {
      // Silent.
    }
    flushTimer = null;
  }

  function scheduleFlush(): void {
    if (!enabled) return;
    cancelScheduledFlush();
    try {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, FLUSH_DEBOUNCE_MS);
    } catch {
      // Silent — a host without timers still delivers on the teardown backstops.
    }
  }

  function flush(): void {
    cancelScheduledFlush();
    if (!enabled || !state || state.queue.length === 0) return;
    const records = state.queue.splice(0, state.queue.length);
    try {
      for (let i = 0; i < records.length; i += BATCH_CAP) {
        send({
          page: state.page,
          ref: referrer,
          gclid: state.gclid,
          ...(utm ? { utm } : {}),
          records: records.slice(i, i + BATCH_CAP),
        });
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
    // The batch cap and the teardown listeners are kept as backstops (defence
    // in depth); the debounce is what makes delivery independent of them.
    if (state.queue.length >= BATCH_CAP) flush();
    else scheduleFlush();
  }

  function pageView(page: string): void {
    if (!enabled) return;
    if (state) flush(); // close out the previous page's sequence (SPA soft-nav)
    state = { page, seq: 0, queue: [], scrollFired: new Set(), emittedOnce: new Set(), gclid: paidVisit() };
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
    // F-39.5 / AC-227 (FC30.2) — the editor is outside the every-clickable
    // rule: neither the named nor the catch-all bucket records here. Its
    // hand-fired funnel steps and the two F-44.4 facts are untouched — they
    // never come through this listener.
    if (isEditorPage(state.page)) return;
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

/**
 * FC30.3 — the emit helpers are typed against the DECLARED vocabulary, so a
 * name the server does not know cannot even be written at a call site: the
 * always-204 collection door would otherwise drop it silently.
 */
export function telemetryEvent(event: ClientTelemetryEvent, element?: string): void {
  getTelemetryRail().event(event, element);
}

export function telemetryEventOnce(event: ClientTelemetryEvent, element?: string): void {
  getTelemetryRail().eventOnce(event, element);
}
