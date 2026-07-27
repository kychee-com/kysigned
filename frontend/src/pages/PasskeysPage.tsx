/**
 * PasskeysPage — `/account/passkeys` (2F.AUTH9 / F2.1.8).
 *
 * Lists the signed-in user's registered passkeys with delete + "add new"
 * actions. Rename is NOT supported — run402 doesn't currently expose a
 * label-update endpoint, so users delete + re-register to relabel.
 *
 * Wrapped in <RequireAuth/> by App.tsx — this page is never rendered for
 * anonymous visitors.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPost } from '../lib/api';
import { passkeysSupported, registerPasskey } from '../auth/passkey';
import { fetchAuthMethods, readGoogleHash, exchangeGoogle } from '../auth/google';
import { friendlyGoogleError, GOOGLE_UNAVAILABLE } from '../lib/friendlyError';
import { hardNavigate } from '../lib/hardNavigate';

interface PasskeyRow {
  id: string;
  label: string | null;
  rp_id: string;
  created_at: string;
  last_used_at: string | null;
}

export function PasskeysPage() {
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);
  // F-41.4 — the Google row: platform availability + this account's link state
  // (the ?identities=1 opt-in — only THIS page pays the extra upstream hop).
  const [googleAvailable, setGoogleAvailable] = useState<boolean | null>(null);
  const [googleConnected, setGoogleConnected] = useState<boolean | null>(null);
  const [googleEmail, setGoogleEmail] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  /** AC-248 — what the just-returned link ceremony did, told HERE. */
  const [ceremonyError, setCeremonyError] = useState('');
  const [ceremonyLinked, setCeremonyLinked] = useState(false);
  const justLinked =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('linked') === '1';

  // AC-248 — the link ceremony returns to THIS page (googleHandlers'
  // signInMethodsLanding), because the visitor is signed in and the sign-in
  // screen that reads ceremony results never renders for them. Both outcomes
  // are consumed exactly once here: the hash is stripped immediately so a
  // refresh cannot replay a stale refusal or re-spend a code.
  const [ceremonyHash] = useState(() => {
    if (typeof window === 'undefined') return null;
    const parsed = readGoogleHash(window.location.hash);
    if (parsed) {
      const clean = new URL(window.location.href);
      clean.hash = '';
      window.history.replaceState({}, '', clean.toString());
    }
    return parsed;
  });

  useEffect(() => {
    if (!ceremonyHash) return;
    if (ceremonyHash.kind === 'error') {
      setCeremonyError(friendlyGoogleError(ceremonyHash.error));
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await exchangeGoogle(ceremonyHash.code, ceremonyHash.ceremony);
        if (cancelled) return;
        setCeremonyLinked(true);
        // Re-read so the row reflects the connection the exchange just sealed.
        const u = await apiGet<{ google_connected?: boolean; google_email?: string }>('/v1/auth/user?identities=1');
        if (cancelled) return;
        setGoogleConnected(u.google_connected === true);
        setGoogleEmail(u.google_email ?? null);
      } catch {
        if (!cancelled) setCeremonyError(friendlyGoogleError(null));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ceremonyHash]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const m = await fetchAuthMethods();
      if (cancelled) return;
      setGoogleAvailable(m.google);
      if (!m.google) return;
      try {
        const u = await apiGet<{ google_connected?: boolean; google_email?: string }>('/v1/auth/user?identities=1');
        if (cancelled) return;
        setGoogleConnected(u.google_connected === true);
        setGoogleEmail(u.google_email ?? null);
      } catch {
        if (!cancelled) setGoogleConnected(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // F-41.4 — Connect Google: the server starts the link ceremony with the
  // session's own run402 token (never exposed here); we just go where it says.
  const connectGoogle = async () => {
    if (connecting) return;
    setConnecting(true);
    setError('');
    try {
      const r = await apiPost<{ authorization_url?: string }>('/v1/auth/google/link', {});
      if (!r.authorization_url) throw new Error('no authorization_url');
      hardNavigate(r.authorization_url);
    } catch {
      setError(GOOGLE_UNAVAILABLE);
      setConnecting(false);
    }
  };

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await apiGet<{ passkeys: PasskeyRow[] }>('/v1/auth/passkeys');
      setPasskeys(data.passkeys ?? []);
    } catch (e) {
      setError((e as Error).message ?? 'Failed to load passkeys');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addPasskey = async () => {
    if (!passkeysSupported()) {
      setError('Passkeys are not supported in this browser.');
      return;
    }
    setAdding(true);
    setError('');
    const result = await registerPasskey({ label: newLabel.trim() || undefined });
    if (!result.ok) {
      setError(result.error || 'Passkey registration failed');
    } else {
      setNewLabel('');
      await load();
    }
    setAdding(false);
  };

  const removePasskey = async (id: string) => {
    setError('');
    try {
      await apiDelete(`/v1/auth/passkeys/${encodeURIComponent(id)}`);
      setConfirmDeleteId(null);
      await load();
    } catch (e) {
      setError((e as Error).message ?? 'Failed to delete passkey');
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8" data-testid="passkeys-page">
      {/* F-41.4 — this page is the account's SIGN-IN METHODS home: passkeys as
          before, plus the Google connection. The email link needs no row: it is
          the standing method every account always has. */}
      <h1 className="text-2xl font-semibold mb-2">Sign-in methods</h1>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* UX-030 — the card holds its space while the platform probe and the
          identity read are in flight. `googleAvailable === null` is "still
          asking"; only a definitive NO removes the card, which on this service
          never happens (the platform reports Google on). */}
      {googleAvailable !== false && (
        <div
          className="mb-8 p-4 border border-gray-200 rounded-lg bg-white min-h-[200px] sm:min-h-[160px]"
          data-testid="google-row"
        >
          <h2 className="text-sm font-semibold mb-1">Google</h2>
          {ceremonyError && (
            <p
              className="mb-2 px-3 py-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-sm"
              data-testid="google-ceremony-error"
            >
              {ceremonyError}
            </p>
          )}
          {(justLinked || ceremonyLinked) && googleConnected && (
            <p
              className="mb-2 px-3 py-2 rounded-lg border border-green-200 bg-green-50 text-green-800 text-sm"
              data-testid="google-linked-note"
            >
              Google is connected. From now on you can sign in with it directly.
            </p>
          )}
          {googleAvailable === null || googleConnected === null ? (
            <div className="animate-pulse" aria-hidden="true" data-testid="google-row-skeleton">
              <div className="h-4 w-3/4 bg-gray-100 rounded mt-2" />
              <div className="h-4 w-1/2 bg-gray-100 rounded mt-2" />
              <div className="h-[44px] w-40 bg-gray-100 rounded-lg mt-3" />
            </div>
          ) : googleConnected === true ? (
            <p className="text-sm text-gray-600">
              Connected as <span className="font-medium">{googleEmail ?? 'your Google account'}</span>. You can
              sign in with Google or with your email link.
            </p>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-gray-600">
                Connect your Google account to sign in with one click. Your email link keeps working either way.
              </p>
              <button
                onClick={connectGoogle}
                disabled={connecting || googleConnected === null}
                className="shrink-0 px-4 py-2 min-h-[44px] border border-gray-300 bg-white text-gray-900 rounded-lg text-sm font-medium hover:bg-gray-50 active:bg-gray-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="google-connect"
              >
                {connecting ? 'Opening Google…' : 'Connect Google'}
              </button>
            </div>
          )}
        </div>
      )}

      <h2 className="text-lg font-semibold mb-2">Passkeys</h2>
      <p className="text-sm text-gray-500 mb-6">
        Passkeys let you sign in with Touch ID, Face ID, or a security key — no email
        roundtrip. Add one to make next sign-in one tap. Delete the ones you no longer use.
      </p>

      {/* Add new passkey */}
      {passkeysSupported() ? (
        <div className="mb-8 p-4 border border-gray-200 rounded-lg bg-white">
          <h2 className="text-sm font-semibold mb-3">Add a passkey for this device</h2>
          <div className="flex gap-2 items-center">
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder='Label (e.g. "MacBook Touch ID")'
              className="flex-1 min-h-[44px] border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            <button
              onClick={addPasskey}
              disabled={adding}
              className="shrink-0 min-h-[44px] px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium transition-colors duration-150 hover:bg-gray-700 active:bg-gray-950 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="passkeys-add"
            >
              {adding ? 'Adding…' : 'Add passkey'}
            </button>
          </div>
        </div>
      ) : (
        <div className="mb-8 px-4 py-3 rounded-lg border border-yellow-200 bg-yellow-50 text-yellow-800 text-sm">
          Your browser doesn't support passkeys. Sign in with the email link instead.
        </div>
      )}

      <h2 className="text-sm font-semibold mb-3">Your passkeys</h2>
      {loading ? (
        <div className="text-center py-8 min-h-[180px]" data-testid="passkeys-loading">
          <div className="animate-spin h-5 w-5 border-4 border-gray-300 border-t-gray-900 rounded-full mx-auto" />
        </div>
      ) : passkeys.length === 0 ? (
        <p className="text-sm text-gray-500 py-8 text-center bg-white border border-gray-200 rounded-lg">
          No passkeys yet. Add one above to enable one-tap sign-in.
        </p>
      ) : (
        <>
          {/* MOBILE (UX-028…UX-033). The five-column table cannot reflow: at
              375px its dates clipped mid-word and the Delete control sat at
              x=404px, entirely off-screen — a phone user could not delete a
              passkey at all. Cards carry the same facts in a layout that has no
              horizontal axis to overflow, and put Delete in reach. */}
          <div className="sm:hidden space-y-3">
            {passkeys.map((p) => (
              <div
                key={p.id}
                className="border border-gray-200 rounded-lg bg-white p-4"
                data-testid={`passkey-card-${p.id}`}
              >
                <p className="text-sm font-medium text-gray-900 break-words">
                  {p.label || <em className="text-gray-600">unnamed</em>}
                </p>
                <dl className="mt-2 space-y-1 text-xs text-gray-600">
                  <div className="flex justify-between gap-3">
                    <dt>Created</dt>
                    <dd className="text-right">{new Date(p.created_at).toLocaleDateString()}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Last used</dt>
                    <dd className="text-right">
                      {p.last_used_at ? new Date(p.last_used_at).toLocaleDateString() : 'Not used yet'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Site</dt>
                    <dd className="text-right font-mono break-all">{p.rp_id}</dd>
                  </div>
                </dl>
                {confirmDeleteId === p.id ? (
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => removePasskey(p.id)}
                      className="flex-1 min-h-[44px] px-4 rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm font-medium cursor-pointer"
                      data-testid={`passkeys-confirm-mobile-${p.id}`}
                    >
                      Confirm delete
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="flex-1 min-h-[44px] px-4 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteId(p.id)}
                    className="mt-3 w-full min-h-[44px] min-w-[44px] px-4 rounded-lg border border-gray-300 text-red-600 text-sm font-medium cursor-pointer"
                    data-testid={`passkeys-delete-mobile-${p.id}`}
                  >
                    Delete
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* DESKTOP — unchanged layout, which the sweep found clean at 1280px. */}
          <div
            className="hidden sm:block border border-gray-200 rounded-lg overflow-hidden bg-white"
            data-testid="passkeys-table-wrap"
          >
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-2 font-medium text-gray-700">Label</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-700">RP</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-700">Created</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-700">Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {passkeys.map((p) => (
                  <tr key={p.id} className="border-t border-gray-100" data-testid={`passkeys-row-${p.id}`}>
                    <td className="px-4 py-2">{p.label || <em className="text-gray-600">unnamed</em>}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-600">{p.rp_id}</td>
                    <td className="px-4 py-2 text-xs text-gray-600">
                      {new Date(p.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-600">
                      {p.last_used_at ? new Date(p.last_used_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {confirmDeleteId === p.id ? (
                        <span className="text-xs">
                          <button
                            onClick={() => removePasskey(p.id)}
                            className="inline-flex items-center min-h-[44px] px-2 text-red-600 hover:underline cursor-pointer"
                            data-testid={`passkeys-confirm-${p.id}`}
                          >
                            Confirm delete
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="inline-flex items-center min-h-[44px] px-2 text-gray-600 hover:underline cursor-pointer"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteId(p.id)}
                          className="inline-flex items-center min-h-[44px] px-2 text-xs text-red-600 hover:underline cursor-pointer"
                          data-testid={`passkeys-delete-${p.id}`}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Last-passkey warning footnote */}
      {passkeys.length === 1 && (
        <p className="text-xs text-yellow-700 mt-4">
          Heads up — deleting your last passkey on a browser without an active session may
          lock you out of one-tap sign-in. The email magic-link still works as recovery.
        </p>
      )}
    </div>
  );
}
