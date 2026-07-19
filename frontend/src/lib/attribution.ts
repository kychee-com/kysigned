/**
 * attribution — F-37 first-party gclid capture + submit read (AC-205/AC-206).
 *
 * The browser half of the paid-acquisition attribution rail: when a visitor
 * lands from a Google ad, auto-tagging puts `?gclid=` on the URL. With the
 * operator flag `captureGclid` ON (default OFF — a fresh fork writes nothing),
 * the click id is stored first-party as `{gclid, capturedAt}` for 90 days with
 * FIRST-TOUCH semantics, then rides the magic-link REQUEST (the email submit
 * happens in the browser that holds the capture; the link itself may be opened
 * on another device — that's why capture never waits for the session).
 *
 * The consent value sent with the submit is read LIVE from the consent
 * banner's recorded choice (`kychee_consent`, written by the deploy-injected
 * banner): a recorded `marketing: true` → 'granted', a recorded false →
 * 'denied', no/unreadable record → null. It is never fabricated (F-37.5).
 *
 * The static pages run the same rail via /attribution-capture.mjs
 * (frontend/public/) — a standalone mirror of the capture semantics; the
 * interop tests in attribution.test.ts hold the two implementations together.
 */
import { getOperatorConfig } from '../config/operator';

export const ATTRIBUTION_STORAGE_KEY = 'kysigned.attribution';
export const ATTRIBUTION_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Google click ids are URL-safe token characters; bound the size defensively. */
const GCLID_RE = /^[A-Za-z0-9_-]{1,512}$/;
const CONSENT_STORAGE_KEY = 'kychee_consent';

export interface StoredAttribution {
  gclid: string;
  capturedAt: string;
}

/** Wire shape of the magic-link rider (snake_case like the API body it joins). */
export interface AttributionSubmission {
  gclid: string;
  captured_at: string;
  consent: 'granted' | 'denied' | null;
}

interface CaptureOptions {
  search?: string;
  now?: Date;
  /** Test/override seam; defaults to the operator config flag. */
  enabled?: boolean;
}

function enabledByConfig(explicit: boolean | undefined): boolean {
  return explicit ?? getOperatorConfig().captureGclid;
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function readValid(now: Date): StoredAttribution | null {
  const storage = safeStorage();
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(ATTRIBUTION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAttribution>;
    const at = Date.parse(parsed?.capturedAt ?? '');
    if (
      typeof parsed?.gclid === 'string' &&
      GCLID_RE.test(parsed.gclid) &&
      Number.isFinite(at) &&
      now.getTime() - at <= ATTRIBUTION_WINDOW_MS
    ) {
      return { gclid: parsed.gclid, capturedAt: parsed.capturedAt as string };
    }
  } catch {
    // malformed record → treated as absent (recapture will repair it)
  }
  return null;
}

/**
 * Capture an arriving gclid from the page URL (first-touch, 90 days).
 * No-ops entirely — zero storage writes — unless attribution is enabled.
 */
export function captureAttribution(options: CaptureOptions = {}): void {
  if (!enabledByConfig(options.enabled)) return;
  const storage = safeStorage();
  if (!storage) return;
  const search =
    options.search ?? (typeof window !== 'undefined' ? window.location.search : '');
  const now = options.now ?? new Date();
  let gclid: string | null = null;
  try {
    gclid = new URLSearchParams(search).get('gclid');
  } catch {
    return;
  }
  if (!gclid || !GCLID_RE.test(gclid)) return;
  try {
    if (readValid(now)) return; // first-touch wins while unexpired
    storage.setItem(
      ATTRIBUTION_STORAGE_KEY,
      JSON.stringify({ gclid, capturedAt: now.toISOString() }),
    );
  } catch {
    // storage blocked (private mode) — capture is best-effort
  }
}

/** The unexpired stored capture, or null. */
export function readStoredAttribution(now: Date = new Date()): StoredAttribution | null {
  return readValid(now);
}

function recordedConsent(): 'granted' | 'denied' | null {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { marketing?: unknown };
    if (typeof parsed?.marketing !== 'boolean') return null;
    return parsed.marketing ? 'granted' : 'denied';
  } catch {
    return null;
  }
}

/**
 * The payload the magic-link request carries: the unexpired capture plus the
 * banner's LIVE recorded choice. Null (send nothing) when attribution is
 * disabled or no unexpired capture exists — organic signups stay organic.
 */
export function readAttributionForSubmit(
  options: CaptureOptions = {},
): AttributionSubmission | null {
  if (!enabledByConfig(options.enabled)) return null;
  const record = readValid(options.now ?? new Date());
  if (!record) return null;
  return {
    gclid: record.gclid,
    captured_at: record.capturedAt,
    consent: recordedConsent(),
  };
}
