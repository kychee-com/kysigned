/**
 * analytics — the four GA4 key events (F-14.6 / AC-47), fired client-side.
 *
 * GA4 + Google Consent Mode v2 + the consent banner are injected into the SPA
 * shell at DEPLOY (the operator's private repo `injectConsentAnalytics` + `consent-banner.mjs`),
 * never bundled into the forkable SPA. gtag is configured `analytics_storage:
 * 'denied'` by default and flips to 'granted' only when the visitor accepts in
 * the banner — so firing an event through `window.gtag` is automatically
 * consent-gated (denied → cookieless modelled ping, granted → full event). We
 * therefore never check consent here; we just push the event.
 *
 * The four events are the evidence-bundle funnel. They are all CREATOR-side
 * (signers sign by email and are never in the SPA):
 *   - envelope_created    — the creator sends an envelope            (CreateEnvelopePage)
 *   - signature_completed — a signer's forward is recorded, observed (EnvelopeDetailPage)
 *   - envelope_completed  — all signed + bundle distributed, observed (EnvelopeDetailPage)
 *   - credit_purchase     — a credit top-up completes                 (DashboardPage)
 *
 * `window.gtag` only exists on the deployed site; in dev / tests / a forker that
 * configured no GA4 measurement id it is absent, so every call is a safe no-op.
 */
export const GA_EVENTS = {
  ENVELOPE_CREATED: 'envelope_created',
  SIGNATURE_COMPLETED: 'signature_completed',
  ENVELOPE_COMPLETED: 'envelope_completed',
  CREDIT_PURCHASE: 'credit_purchase',
} as const;

type GtagFn = (command: 'event', name: string, params?: Record<string, unknown>) => void;

function resolveGtag(): GtagFn | null {
  if (typeof window === 'undefined') return null;
  const g = (window as unknown as { gtag?: GtagFn }).gtag;
  return typeof g === 'function' ? g : null;
}

/** Fire a GA4 event. No-op when gtag is absent (dev / test / forker-without-GA4). */
export function trackEvent(name: string, params?: Record<string, unknown>): void {
  resolveGtag()?.('event', name, params);
}

/**
 * Fire a GA4 event AT MOST ONCE per browser for `dedupeKey`. The two server-truth
 * events (signature_completed, envelope_completed) are OBSERVED on the creator's
 * envelope page, so without a dedupe they would re-fire on every page load /
 * poll. The key is persisted in localStorage; if that's unavailable (private
 * mode / SSR) we fire rather than silently drop the event.
 */
export function trackEventOnce(dedupeKey: string, name: string, params?: Record<string, unknown>): void {
  const storageKey = `ga_once:${dedupeKey}`;
  let alreadyFired = false;
  try {
    alreadyFired = typeof window !== 'undefined' && window.localStorage.getItem(storageKey) === '1';
  } catch {
    alreadyFired = false; // localStorage blocked — fall through and fire once now.
  }
  if (alreadyFired) return;
  trackEvent(name, params);
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(storageKey, '1');
  } catch {
    // best-effort — a blocked localStorage just means it may re-fire on reload.
  }
}
