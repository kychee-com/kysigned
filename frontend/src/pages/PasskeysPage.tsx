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
import { apiDelete, apiGet } from '../lib/api';
import { passkeysSupported, registerPasskey } from '../auth/passkey';

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
      <h1 className="text-2xl font-semibold mb-2">Passkeys</h1>
      <p className="text-sm text-gray-500 mb-6">
        Passkeys let you sign in with Touch ID, Face ID, or a security key — no email
        roundtrip. Add one to make next sign-in one tap. Delete the ones you no longer use.
      </p>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm">
          {error}
        </div>
      )}

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
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            <button
              onClick={addPasskey}
              disabled={adding}
              className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium transition-colors duration-150 hover:bg-gray-700 active:bg-gray-950 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
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
        <div className="text-center py-8">
          <div className="animate-spin h-5 w-5 border-4 border-gray-300 border-t-gray-900 rounded-full mx-auto" />
        </div>
      ) : passkeys.length === 0 ? (
        <p className="text-sm text-gray-500 py-8 text-center bg-white border border-gray-200 rounded-lg">
          No passkeys yet. Add one above to enable one-tap sign-in.
        </p>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
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
                  <td className="px-4 py-2">{p.label || <em className="text-gray-400">unnamed</em>}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-500">{p.rp_id}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {new Date(p.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {p.last_used_at ? new Date(p.last_used_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {confirmDeleteId === p.id ? (
                      <span className="text-xs">
                        <button
                          onClick={() => removePasskey(p.id)}
                          className="text-red-600 hover:underline mr-2"
                          data-testid={`passkeys-confirm-${p.id}`}
                        >
                          Confirm delete
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          className="text-gray-500 hover:underline"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(p.id)}
                        className="text-xs text-red-600 hover:underline"
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
