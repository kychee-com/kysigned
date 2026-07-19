/**
 * attribution-capture — F-37 first-party gclid capture for STATIC pages.
 *
 * Standalone vanilla module (no imports) served at /attribution-capture.mjs on
 * every deployment. A page runs it only when the OPERATOR wires it in (the
 * private deploy injects the import into its final static pages when
 * attribution is enabled) — the public generic pages never reference it, so a
 * fresh fork writes nothing anywhere.
 *
 * Semantics (must stay identical to frontend/src/lib/attribution.ts — the
 * interop tests in attribution.test.ts run both against the same storage):
 * store `{gclid, capturedAt}` under `kysigned.attribution`, keep 90 days,
 * FIRST-TOUCH (an unexpired stored id is never replaced; an expired one
 * lapses). Capture only — the SPA reads it back at the magic-link submit.
 */

const STORAGE_KEY = 'kysigned.attribution';
const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const GCLID_RE = /^[A-Za-z0-9_-]{1,512}$/;

function readValid(storage, nowMs) {
  let raw = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const at = Date.parse(parsed && parsed.capturedAt);
    if (
      parsed &&
      typeof parsed.gclid === 'string' &&
      GCLID_RE.test(parsed.gclid) &&
      Number.isFinite(at) &&
      nowMs - at <= WINDOW_MS
    ) {
      return { gclid: parsed.gclid, capturedAt: parsed.capturedAt };
    }
  } catch {
    /* malformed → treat as absent */
  }
  return null;
}

/**
 * Capture an arriving gclid. Options are test seams; on a real page both
 * default to the live environment.
 */
export function initAttributionCapture(options) {
  const opts = options || {};
  if (typeof window === 'undefined') return;
  const search = typeof opts.search === 'string' ? opts.search : window.location.search;
  const now = opts.now instanceof Date ? opts.now : new Date();
  let gclid = null;
  try {
    gclid = new URLSearchParams(search).get('gclid');
  } catch {
    return;
  }
  if (!gclid || !GCLID_RE.test(gclid)) return;
  try {
    if (readValid(window.localStorage, now.getTime())) return; // first-touch wins
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ gclid, capturedAt: now.toISOString() }),
    );
  } catch {
    /* storage blocked (private mode) — capture is best-effort */
  }
}
