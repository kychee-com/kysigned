/**
 * analytics.test — the four GA4 key events (F-14.6 / AC-47).
 *
 * The events fire through `window.gtag` (the bootstrap injected into the SPA
 * shell at deploy). Consent is handled upstream by Google Consent Mode v2 + the
 * consent banner, so these helpers never check consent themselves — they just
 * push the event and let consent mode gate collection. In dev/test/forker-no-GA4
 * `window.gtag` is absent, so every call must be a safe no-op.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trackEvent, trackEventOnce, GA_EVENTS } from './analytics';

describe('analytics — GA4 key events (F-14.6 / AC-47)', () => {
  beforeEach(() => {
    (window as unknown as { gtag?: unknown }).gtag = vi.fn();
    window.localStorage.clear();
  });
  afterEach(() => {
    delete (window as unknown as { gtag?: unknown }).gtag;
  });

  it('exposes exactly the four bundle-model event names', () => {
    expect(GA_EVENTS.ENVELOPE_CREATED).toBe('envelope_created');
    expect(GA_EVENTS.SIGNATURE_COMPLETED).toBe('signature_completed');
    expect(GA_EVENTS.ENVELOPE_COMPLETED).toBe('envelope_completed');
    expect(GA_EVENTS.CREDIT_PURCHASE).toBe('credit_purchase');
  });

  it('trackEvent pushes gtag("event", name, params)', () => {
    trackEvent('envelope_created', { envelope_id: 'env_1' });
    expect((window as unknown as { gtag: ReturnType<typeof vi.fn> }).gtag).toHaveBeenCalledWith(
      'event',
      'envelope_created',
      { envelope_id: 'env_1' },
    );
  });

  it('trackEvent is a safe no-op when gtag is absent (forker without GA4 / dev / SSR)', () => {
    delete (window as unknown as { gtag?: unknown }).gtag;
    expect(() => trackEvent('envelope_created')).not.toThrow();
  });

  it('trackEventOnce fires once per dedupe key, then no-ops on repeat', () => {
    const gtag = (window as unknown as { gtag: ReturnType<typeof vi.fn> }).gtag;
    trackEventOnce('sig:env_1:a@b.com', 'signature_completed', { envelope_id: 'env_1' });
    trackEventOnce('sig:env_1:a@b.com', 'signature_completed', { envelope_id: 'env_1' });
    expect(gtag).toHaveBeenCalledTimes(1);
  });

  it('trackEventOnce fires for distinct keys (e.g. two different signers)', () => {
    const gtag = (window as unknown as { gtag: ReturnType<typeof vi.fn> }).gtag;
    trackEventOnce('sig:env_1:a@b.com', 'signature_completed');
    trackEventOnce('sig:env_1:c@d.com', 'signature_completed');
    expect(gtag).toHaveBeenCalledTimes(2);
  });

  it('trackEventOnce persists the dedupe across calls (localStorage-backed)', () => {
    trackEventOnce('complete:env_1', 'envelope_completed');
    // A fresh "page load" re-invokes with the same key → must NOT re-fire.
    const gtag = (window as unknown as { gtag: ReturnType<typeof vi.fn> }).gtag;
    gtag.mockClear();
    trackEventOnce('complete:env_1', 'envelope_completed');
    expect(gtag).not.toHaveBeenCalled();
  });
});
