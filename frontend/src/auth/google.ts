/**
 * google — the SPA side of F-41's "Continue with Google" (DD-58..60).
 *
 * The ceremony is a same-tab redirect: this module starts it (the server owns
 * PKCE + the ceremony row; the browser sees only `authorization_url`), stashes
 * the pending-send handle in sessionStorage across the round trip (strictly
 * safer than the URL the email path already rides — same-tab, same-origin,
 * cleared on use), and reads the callback hash on the landing
 * (`#code=…&state=<ceremony>` on success, `#error=…&state=<ceremony>` on
 * failure — run402 delivers the client_state both ways).
 */
import { apiGet, apiPost } from '../lib/api';

export interface AuthMethods {
  google: boolean;
}

/** sessionStorage key for the draft handle riding a Google ceremony. */
export const GOOGLE_DRAFT_STASH_KEY = 'kysigned.google.draft';

let methodsCache: AuthMethods | null = null;

/** Which methods the platform offers — cached per page load (the gate renders
 *  once; a platform flip lands on the next load). Failure reads email-only. */
export async function fetchAuthMethods(): Promise<AuthMethods> {
  if (methodsCache) return methodsCache;
  try {
    const m = await apiGet<AuthMethods>('/v1/auth/methods');
    methodsCache = { google: m?.google === true };
  } catch {
    methodsCache = { google: false };
  }
  return methodsCache;
}

/** Test seam: clear the per-load cache. */
export function resetAuthMethodsCache(): void {
  methodsCache = null;
}

export function stashGoogleDraft(handle: string): void {
  try {
    sessionStorage.setItem(GOOGLE_DRAFT_STASH_KEY, handle);
  } catch {
    // Storage may be unavailable (private mode); the server-side pending send
    // still exists — only the failure-path restore convenience is lost.
  }
}

/** Read AND clear the stashed handle (single-use, like everything else here). */
export function takeGoogleDraftStash(): string | null {
  try {
    const v = sessionStorage.getItem(GOOGLE_DRAFT_STASH_KEY);
    if (v !== null) sessionStorage.removeItem(GOOGLE_DRAFT_STASH_KEY);
    return v;
  } catch {
    return null;
  }
}

/** Peek without clearing (the editor's mount-time restore check). */
export function peekGoogleDraftStash(): string | null {
  try {
    return sessionStorage.getItem(GOOGLE_DRAFT_STASH_KEY);
  } catch {
    return null;
  }
}

export interface GoogleStartOpts {
  trigger: 'direct' | 'redirect' | 'send';
  draftHandle?: string;
  attribution?: unknown;
}

/**
 * Start the ceremony: the server mints the ceremony row and hands back
 * Google's URL. The caller navigates (kept out of here so tests can assert
 * the URL without a jsdom navigation).
 */
export async function startGoogleSignIn(opts: GoogleStartOpts): Promise<string> {
  const r = await apiPost<{ authorization_url?: string }>('/v1/auth/google/start', {
    trigger: opts.trigger,
    ...(opts.draftHandle ? { draft_id: opts.draftHandle } : {}),
    ...(opts.attribution ? { attribution: opts.attribution } : {}),
  });
  if (!r.authorization_url) throw new Error('no authorization_url');
  if (opts.draftHandle) stashGoogleDraft(opts.draftHandle);
  return r.authorization_url;
}

export type GoogleHash =
  | { kind: 'code'; code: string; ceremony: string }
  | { kind: 'error'; error: string; ceremony: string | null }
  | null;

/**
 * Read the callback hash on the landing. `state` in the hash is run402's
 * echo of our client_state — the opaque ceremony id (DD-59). Only a
 * gc_-shaped state is honored, so a foreign hash can never become an exchange.
 */
export function readGoogleHash(hash: string): GoogleHash {
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const state = params.get('state');
  const ceremony = state && /^gc_[0-9a-f-]{36}$/.test(state) ? state : null;
  const code = params.get('code');
  if (code && ceremony) return { kind: 'code', code, ceremony };
  const error = params.get('error');
  if (error && ceremony) return { kind: 'error', error, ceremony };
  return null;
}

export interface GoogleExchangeResult {
  ok?: boolean;
  email?: string;
  linked?: boolean;
  claim?: { status: number; envelope_id?: string; already_sent?: boolean; code?: string; error?: string };
}

export async function exchangeGoogle(code: string, ceremony: string): Promise<GoogleExchangeResult> {
  return apiPost<GoogleExchangeResult>('/v1/auth/google/exchange', { code, ceremony });
}
