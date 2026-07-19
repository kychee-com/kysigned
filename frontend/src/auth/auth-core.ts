/**
 * auth-core.ts — the non-component half of the auth module: the React context
 * object, the `useAuth` hook, and the cross-tab broadcast helper.
 *
 * Split out of AuthContext.tsx so that file exports ONLY the <AuthProvider>
 * component (react-refresh/only-export-components): mixing component and
 * non-component exports in one file breaks Vite HMR fast-refresh granularity.
 * The provider lives in AuthContext.tsx; everything callers import at
 * runtime (useAuth, broadcastAuthEvent) lives here.
 */
import { createContext, useContext } from 'react';

export const AUTH_BROADCAST_CHANNEL = 'kysigned-auth';
// localStorage signal key — written by `broadcastAuthEvent` to trigger the
// `storage` event on OTHER tabs (reliable cross-tab notification, more
// dependable across browsers than BroadcastChannel for short-lived senders).
// The VALUE carries the type + timestamp; it has zero authority — the
// receiving tab still re-fetches /v1/auth/user to confirm.
export const AUTH_STORAGE_SIGNAL_KEY = 'kysigned_auth_signal';

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

export const AuthContext = createContext<AuthContextValue | null>(null);

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
