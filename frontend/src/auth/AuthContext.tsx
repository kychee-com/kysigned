/**
 * AuthContext.tsx — single source of truth for signed-in state across the SPA
 * (2F.AUTH7 / F2.1.10 / DD-72).
 *
 * Responsibilities:
 *   - Hydrate from `GET /v1/auth/user` on mount (cookie attaches automatically
 *     via `credentials:'include'`). 200 → populate user; 401 → user=null.
 *   - Subscribe to `BroadcastChannel('kysigned-auth')`:
 *     - `{type:'signed-in', email}` → re-fetch /v1/auth/user to confirm + update.
 *     - `{type:'signed-out'}` → clear user immediately.
 *   - Re-fetch /v1/auth/user on `visibilitychange` (catches cookie set by
 *     another tab). Replaces the per-page visibilitychange interim from AUTH4.
 *   - Expose `signOut()` which POSTs /v1/auth/signout, broadcasts signed-out,
 *     and clears local state.
 *
 * BroadcastChannel is used (not localStorage `storage` event) because the
 * session moved to HttpOnly cookies in 2F.AUTH4 — cookies don't emit storage
 * events. BroadcastChannel is supported in all evergreen browsers.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

const AUTH_BROADCAST_CHANNEL = 'kysigned-auth';
// localStorage signal key — written by `broadcastAuthEvent` to trigger the
// `storage` event on OTHER tabs (reliable cross-tab notification, more
// dependable across browsers than BroadcastChannel for short-lived senders).
// The VALUE carries the type + timestamp; it has zero authority — the
// receiving tab still re-fetches /v1/auth/user to confirm.
const AUTH_STORAGE_SIGNAL_KEY = 'kysigned_auth_signal';
const API_BASE = (import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE || '';

export interface AuthUser {
  email: string;
  /** SS.3 / F1.11: the creator's own saved name, surfaced so the create form can prefill the sender-as-signer row. Absent until the creator has saved one. */
  display_name?: string;
}

export interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

export type AuthBroadcastMessage =
  | { type: 'signed-in'; email: string }
  | { type: 'signed-out' };

/**
 * Broadcast a sign-in / sign-out event to other tabs. Fires through TWO
 * channels for reliability:
 *
 *   1. BroadcastChannel('kysigned-auth') — instant, but flaky for senders
 *      that close immediately after posting. Some browsers may drop the
 *      message if the channel is GC'd before delivery.
 *   2. localStorage write — emits a `storage` event on OTHER tabs of the
 *      same origin. Rock-solid cross-tab signal; lower-latency than
 *      visibilitychange because it fires while tabs are still in the
 *      background. The value is timestamped so a duplicate write still
 *      triggers a fresh storage event.
 *
 * Either path triggers AuthContext.refresh() on the receiving tab, which
 * re-fetches /v1/auth/user and updates the user state.
 */
export function broadcastAuthEvent(msg: AuthBroadcastMessage): void {
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(AUTH_BROADCAST_CHANNEL);
    try {
      channel.postMessage(msg);
    } finally {
      // Defer close to a microtask so the message has a chance to dispatch.
      // close()-before-dispatch is a known cross-browser flakiness mode.
      setTimeout(() => channel.close(), 0);
    }
  }
  if (typeof localStorage !== 'undefined') {
    try {
      // Timestamp the value so back-to-back broadcasts (e.g. signed-out
      // followed by signed-in) each produce a distinct storage event.
      localStorage.setItem(
        AUTH_STORAGE_SIGNAL_KEY,
        JSON.stringify({ ...msg, t: Date.now() }),
      );
    } catch {
      // localStorage may be disabled (privacy mode quirks); BroadcastChannel
      // is still in flight as a fallback.
    }
  }
}

async function fetchAuthUser(): Promise<AuthUser | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/auth/user`, {
      method: 'GET',
      credentials: 'include',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { email?: string; display_name?: string };
    return body.email ? { email: body.email, ...(body.display_name ? { display_name: body.display_name } : {}) } : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const userRef = useRef<AuthUser | null>(null);

  const refresh = useCallback(async () => {
    const result = await fetchAuthUser();
    setUser(result);
    userRef.current = result;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await fetch(`${API_BASE}/v1/auth/signout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Kysigned-Csrf': '1' },
      });
    } catch {
      // Best-effort — the cookie clears either way once the server responds,
      // and even if the network call failed, we still want to surface as
      // signed-out locally + tell other tabs.
    }
    broadcastAuthEvent({ type: 'signed-out' });
    setUser(null);
    userRef.current = null;
  }, []);

  // Initial hydrate.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await fetchAuthUser();
      if (cancelled) return;
      setUser(result);
      userRef.current = result;
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Cross-tab + return-to-tab signals. Four sources, all leading to the same
  // action (re-fetch /v1/auth/user via refresh()). Belt-and-suspenders: any
  // one of them firing is enough to pivot the UI on a tab that was sitting
  // on the sign-in screen while sign-in completed in a sibling tab.
  useEffect(() => {
    const handleAuthMessage = (msg: AuthBroadcastMessage | undefined) => {
      if (!msg) return;
      if (msg.type === 'signed-out') {
        setUser(null);
        userRef.current = null;
        return;
      }
      if (msg.type === 'signed-in') {
        // Re-confirm via /v1/auth/user (the broadcast might claim an email
        // the server doesn't actually have a session for — never trust the
        // claim, only use it as a "go check the cookie" trigger).
        void refresh();
      }
    };

    // (1) BroadcastChannel — instant within the same origin.
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(AUTH_BROADCAST_CHANNEL);
      channel.addEventListener('message', (ev: MessageEvent) =>
        handleAuthMessage(ev.data as AuthBroadcastMessage | undefined),
      );
    }

    // (2) localStorage `storage` event — reliable cross-tab fallback.
    const handleStorage = (ev: StorageEvent) => {
      if (ev.key !== AUTH_STORAGE_SIGNAL_KEY || !ev.newValue) return;
      try {
        const parsed = JSON.parse(ev.newValue) as AuthBroadcastMessage & { t?: number };
        handleAuthMessage(parsed);
      } catch {
        // ignore malformed signals
      }
    };
    window.addEventListener('storage', handleStorage);

    // (3) `visibilitychange` — fires when the user clicks back to this tab.
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      void refresh();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // (4) window `focus` — extra safety net. Some browsers don't fire
    //     visibilitychange on tab focus when the tab was never hidden
    //     (e.g. window focus loss without backgrounding).
    const handleFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      if (channel) {
        channel.close();
      }
      window.removeEventListener('storage', handleStorage);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleFocus);
    };
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, refresh, signOut }),
    [user, loading, refresh, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
