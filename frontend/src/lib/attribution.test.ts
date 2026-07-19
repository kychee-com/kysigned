/**
 * attribution.test.ts — F-37 first-party gclid capture (AC-205).
 *
 * The capture module is the browser half of the paid-acquisition attribution
 * rail: land with `?gclid=` on any page → store `{gclid, capturedAt}`
 * first-party, 90 days, FIRST-TOUCH (an unexpired stored id is never replaced);
 * the magic-link submit later reads it back together with the consent banner's
 * recorded choice. Everything is operator-config-gated (`captureGclid`,
 * default FALSE) — a fresh fork must never write a byte.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ATTRIBUTION_STORAGE_KEY,
  ATTRIBUTION_WINDOW_MS,
  captureAttribution,
  readStoredAttribution,
  readAttributionForSubmit,
} from './attribution';
import { initAttributionCapture } from '../../public/attribution-capture.mjs';

const NOW = new Date('2026-07-19T12:00:00.000Z');
const CONSENT_KEY = 'kychee_consent';

function stored(): { gclid: string; capturedAt: string } | null {
  const raw = window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function seed(gclid: string, capturedAt: string): void {
  window.localStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify({ gclid, capturedAt }));
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllEnvs());

describe('captureAttribution — disabled (fresh-fork default)', () => {
  it('writes NOTHING even when a gclid arrives (no VITE_OPERATOR_CONFIG at all)', () => {
    captureAttribution({ search: '?gclid=Cj0Kfork', now: NOW });
    expect(window.localStorage.length).toBe(0);
  });

  it('readAttributionForSubmit returns null when disabled, even over a seeded record', () => {
    seed('Cj0Kstale', NOW.toISOString());
    expect(readAttributionForSubmit({ now: NOW })).toBeNull();
  });
});

describe('captureAttribution — enabled', () => {
  it('is driven by the operator config flag (captureGclid: true), not code changes', () => {
    vi.stubEnv('VITE_OPERATOR_CONFIG', JSON.stringify({ captureGclid: true }));
    captureAttribution({ search: '?gclid=Cj0Kconfig', now: NOW });
    expect(stored()).toEqual({ gclid: 'Cj0Kconfig', capturedAt: NOW.toISOString() });
  });

  it('stores {gclid, capturedAt} from any page URL, other params ignored', () => {
    captureAttribution({ search: '?utm_source=google&gclid=Cj0Kabc-123_x&kw=esign', now: NOW, enabled: true });
    expect(stored()).toEqual({ gclid: 'Cj0Kabc-123_x', capturedAt: NOW.toISOString() });
  });

  it('no gclid param → no write, and an existing record is untouched', () => {
    seed('Cj0Kfirst', NOW.toISOString());
    captureAttribution({ search: '?utm_source=google', now: NOW, enabled: true });
    expect(stored()).toEqual({ gclid: 'Cj0Kfirst', capturedAt: NOW.toISOString() });
  });

  it('FIRST-TOUCH: a later different gclid does NOT replace an unexpired one', () => {
    const early = new Date(NOW.getTime() - 5 * 24 * 3600 * 1000);
    seed('Cj0Kfirst', early.toISOString());
    captureAttribution({ search: '?gclid=Cj0Ksecond', now: NOW, enabled: true });
    expect(stored()).toEqual({ gclid: 'Cj0Kfirst', capturedAt: early.toISOString() });
  });

  it('an EXPIRED record (>90d) lapses: the next click captures fresh', () => {
    const expired = new Date(NOW.getTime() - ATTRIBUTION_WINDOW_MS - 24 * 3600 * 1000);
    seed('Cj0Kold', expired.toISOString());
    captureAttribution({ search: '?gclid=Cj0Knew', now: NOW, enabled: true });
    expect(stored()).toEqual({ gclid: 'Cj0Knew', capturedAt: NOW.toISOString() });
  });

  it('a malformed stored record is treated as absent (recaptures, never throws)', () => {
    window.localStorage.setItem(ATTRIBUTION_STORAGE_KEY, '{not json');
    captureAttribution({ search: '?gclid=Cj0Krepair', now: NOW, enabled: true });
    expect(stored()).toEqual({ gclid: 'Cj0Krepair', capturedAt: NOW.toISOString() });
  });

  it('rejects garbage gclids (empty / whitespace / oversize) without writing', () => {
    captureAttribution({ search: '?gclid=', now: NOW, enabled: true });
    captureAttribution({ search: `?gclid=${'x'.repeat(600)}`, now: NOW, enabled: true });
    captureAttribution({ search: '?gclid=a%20b', now: NOW, enabled: true });
    expect(window.localStorage.length).toBe(0);
  });
});

describe('readStoredAttribution / readAttributionForSubmit', () => {
  it('returns the unexpired record; null once the 90-day window lapses', () => {
    seed('Cj0Klive', NOW.toISOString());
    expect(readStoredAttribution(NOW)?.gclid).toBe('Cj0Klive');
    const later = new Date(NOW.getTime() + ATTRIBUTION_WINDOW_MS + 1000);
    expect(readStoredAttribution(later)).toBeNull();
  });

  it('submit payload carries consent null when the banner never recorded a choice', () => {
    seed('Cj0Ksubmit', NOW.toISOString());
    expect(readAttributionForSubmit({ now: NOW, enabled: true })).toEqual({
      gclid: 'Cj0Ksubmit',
      captured_at: NOW.toISOString(),
      consent: null,
    });
  });

  it('maps the recorded banner choice: marketing true → granted, false → denied', () => {
    seed('Cj0Kconsent', NOW.toISOString());
    window.localStorage.setItem(CONSENT_KEY, JSON.stringify({ essential: true, analytics: true, marketing: true }));
    expect(readAttributionForSubmit({ now: NOW, enabled: true })?.consent).toBe('granted');
    window.localStorage.setItem(CONSENT_KEY, JSON.stringify({ essential: true, analytics: false, marketing: false }));
    expect(readAttributionForSubmit({ now: NOW, enabled: true })?.consent).toBe('denied');
  });

  it('an unparseable consent record maps to null (never fabricated)', () => {
    seed('Cj0Kbadconsent', NOW.toISOString());
    window.localStorage.setItem(CONSENT_KEY, '{broken');
    expect(readAttributionForSubmit({ now: NOW, enabled: true })?.consent).toBeNull();
  });

  it('returns null with no record at all', () => {
    expect(readAttributionForSubmit({ now: NOW, enabled: true })).toBeNull();
  });
});

describe('static-page snippet (frontend/public/attribution-capture.mjs) — same rail, same key', () => {
  it('captures on a static page and the SPA module reads what it wrote (interop)', () => {
    initAttributionCapture({ search: '?gclid=Cj0Kstatic', now: NOW });
    expect(readStoredAttribution(NOW)).toEqual({ gclid: 'Cj0Kstatic', capturedAt: NOW.toISOString() });
  });

  it('honors first-touch over a record the SPA module wrote', () => {
    captureAttribution({ search: '?gclid=Cj0Kspa', now: NOW, enabled: true });
    initAttributionCapture({ search: '?gclid=Cj0Klater', now: NOW });
    expect(stored()?.gclid).toBe('Cj0Kspa');
  });

  it('replaces an expired record and ignores pages with no gclid', () => {
    const expired = new Date(NOW.getTime() - ATTRIBUTION_WINDOW_MS - 1000);
    seed('Cj0Kexpired', expired.toISOString());
    initAttributionCapture({ search: '', now: NOW });
    expect(stored()?.gclid).toBe('Cj0Kexpired');
    initAttributionCapture({ search: '?gclid=Cj0Kfresh', now: NOW });
    expect(stored()).toEqual({ gclid: 'Cj0Kfresh', capturedAt: NOW.toISOString() });
  });
});
