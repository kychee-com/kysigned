/**
 * telemetry — F-38 pre-signin funnel rail for STATIC pages (spec 0.59.0).
 *
 * Standalone vanilla module (no imports) served at /telemetry.mjs on every
 * deployment. A page runs it only when the OPERATOR wires it in (the private
 * deploy injects the import into its final static pages when telemetry is
 * enabled) — the public generic pages never reference it, so a fresh fork
 * sends nothing anywhere.
 *
 * Semantics (must stay identical to frontend/src/lib/telemetry.ts — the
 * interop tests in telemetry.test.ts run both): landing page_view, ONE
 * delegated click listener over the `data-telemetry="name:location"` registry
 * with a normalized-destination catch-all for unnamed links, home-only scroll
 * depth once per threshold, per-page-load seq, batched sendBeacon delivery.
 * Identifier-free: NO cookie, NO browser-storage WRITE, no click-id value
 * (presence only), silent on every failure, never blocks navigation. Its ONE
 * storage read is the F-37 ad-click record, reduced to the paid yes/no
 * (spec 0.64.0, F-38.5) — see `storedGclidPresent`.
 */

const ENDPOINT = '/v1/telemetry';
const PAGE_CAP = 60;
const BATCH_CAP = 25;

// F-37 first-party ad-click record — the ONE key this rail reads (presence and
// freshness only). Mirrors attribution-capture.mjs; deliberately INLINED
// rather than imported so /telemetry.mjs stays a standalone drop-in that a
// deployment without the attribution module cannot break.
const ATTRIBUTION_KEY = 'kysigned.attribution';
const ATTRIBUTION_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const GCLID_RE = /^[A-Za-z0-9_-]{1,512}$/;

/**
 * Did this VISIT arrive from an ad? (spec 0.64.0, F-38.5.) Only an ad visit's
 * LANDING url carries the click id, so every later page asks the stored
 * record instead. Presence + freshness ONLY — the value is never read into the
 * batch, never sent, never stored — and every failure answers false.
 */
function storedGclidPresent(nowMs) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    const raw = window.localStorage.getItem(ATTRIBUTION_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    const at = Date.parse(parsed && parsed.capturedAt);
    return (
      !!parsed &&
      typeof parsed.gclid === 'string' &&
      GCLID_RE.test(parsed.gclid) &&
      Number.isFinite(at) &&
      nowMs - at <= ATTRIBUTION_WINDOW_MS
    );
  } catch {
    return false;
  }
}

const SEGMENT_TO_PAGE = {
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

function segOf(path) {
  return path.split('?')[0].split('#')[0].replace(/^\/+/, '').split('/')[0].toLowerCase().replace(/\.html$/, '');
}

function normalizeDest(href, ownHost) {
  try {
    if (/^https?:\/\//i.test(href)) {
      const u = new URL(href);
      const host = u.hostname.toLowerCase();
      const own = (ownHost || '').toLowerCase();
      if (host !== own && !host.endsWith('.' + own)) return 'external';
      href = u.pathname;
    }
  } catch {
    return 'external';
  }
  return SEGMENT_TO_PAGE[segOf(href)] || 'other';
}

/**
 * Boot the static rail. Options are test seams; a real page calls
 * `initStaticTelemetry()` with no arguments from the injected snippet.
 */
export function initStaticTelemetry(opts) {
  const o = opts || {};
  const doc = o.doc || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  const path = o.path !== undefined ? o.path : location.pathname;
  const referrer = o.referrer !== undefined ? o.referrer : doc.referrer;
  const search = o.search !== undefined ? o.search : location.search;
  const ownHost = o.ownHost !== undefined ? o.ownHost : location.hostname;
  const endpoint = o.endpoint || ENDPOINT;
  // F-38.5 — paid is a property of the VISIT: this url's click id, else the
  // F-37 record. One page load = one page view, so it is answered once here.
  const gclid = /[?&]gclid=/.test(search) || storedGclidPresent(Date.now());
  // 0.60.0 — the landing campaign tag (raw; server normalizes). Memory only.
  let utm = null;
  try {
    utm = new URLSearchParams(search).get('utm_campaign');
  } catch {
    utm = null;
  }

  const send =
    o.send ||
    function (batch) {
      try {
        const body = JSON.stringify(batch);
        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
          return navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
        }
        fetch(endpoint, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(
          function () {},
        );
        return true;
      } catch {
        return false;
      }
    };

  let seq = 0;
  const queue = [];
  const scrollFired = {};
  const isHome = (SEGMENT_TO_PAGE[segOf(path)] || 'other') === 'home';

  function flush() {
    if (queue.length === 0) return;
    const records = queue.splice(0, queue.length);
    try {
      for (let i = 0; i < records.length; i += BATCH_CAP) {
        const batch = { page: path, ref: referrer, gclid: gclid, records: records.slice(i, i + BATCH_CAP) };
        if (utm) batch.utm = utm;
        send(batch);
      }
    } catch {
      /* silent */
    }
  }

  function push(event, element) {
    if (seq >= PAGE_CAP) return;
    seq += 1;
    const rec = element === undefined ? { event: event, seq: seq } : { event: event, element: element, seq: seq };
    queue.push(rec);
    if (queue.length >= BATCH_CAP) flush();
  }

  push('page_view');

  try {
    doc.addEventListener(
      'click',
      function (e) {
        try {
          const el = e.target instanceof Element ? e.target : null;
          if (!el) return;
          const named = el.closest('[data-telemetry]');
          if (named) {
            const value = named.getAttribute('data-telemetry') || '';
            if (value !== '') push('click', value);
            return;
          }
          const link = el.closest('a[href]');
          if (link) push('click', 'other:' + normalizeDest(link.getAttribute('href') || '', ownHost));
        } catch {
          /* silent */
        }
      },
      { capture: true, passive: true },
    );
    if (isHome) {
      window.addEventListener(
        'scroll',
        function () {
          try {
            const root = doc.documentElement;
            const max = Math.max(1, root.scrollHeight - window.innerHeight);
            const pct = ((window.scrollY || 0) / max) * 100;
            const thresholds = ['25', '50', '75', '100'];
            for (let i = 0; i < thresholds.length; i++) {
              if (pct >= Number(thresholds[i]) && !scrollFired[thresholds[i]]) {
                scrollFired[thresholds[i]] = true;
                push('scroll', thresholds[i]);
              }
            }
          } catch {
            /* silent */
          }
        },
        { passive: true },
      );
    }
    window.addEventListener('pagehide', flush);
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState === 'hidden') flush();
    });
  } catch {
    /* silent */
  }
}

// No autoboot: the operator's deploy-injected snippet imports this module and
// calls `initStaticTelemetry()` explicitly (the attribution-capture pattern) —
// serving the file alone activates nothing.
