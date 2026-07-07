/**
 * ApiKeysPage — `/account/api-keys` (spec F-30.1 / AC-132).
 *
 * Creator API keys for agents and scripts: mint (the raw `ksk_…` value is
 * shown EXACTLY ONCE, here, and never again), list metadata, revoke. The keys
 * authenticate the creator envelope actions on `/v1` via the Authorization
 * header (CSRF-exempt bearer mode); key MANAGEMENT stays on the cookie
 * session — a key cannot mint or revoke keys.
 *
 * Wrapped in <RequireAuth/> by App.tsx — never rendered for anonymous visitors.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPost } from '../lib/api';

interface ApiKeyRow {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface MintedKey {
  id: string;
  key: string;
  label: string | null;
}

export function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await apiGet<{ keys: ApiKeyRow[] }>('/v1/api-keys');
      setKeys(data.keys ?? []);
    } catch (e) {
      setError((e as Error).message ?? 'Failed to load API keys');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createKey = async () => {
    setCreating(true);
    setError('');
    setCopied(false);
    try {
      const r = await apiPost<MintedKey>('/v1/api-keys', { label: label.trim() || null });
      setMinted(r);
      setLabel('');
      await load();
    } catch (e) {
      setError((e as Error).message ?? 'Failed to create the API key');
    } finally {
      setCreating(false);
    }
  };

  const copyKey = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.key);
      setCopied(true);
    } catch {
      // Clipboard can be unavailable (permissions); the key is selectable text.
    }
  };

  const revokeKey = async (id: string) => {
    setError('');
    try {
      await apiDelete(`/v1/api-keys/${encodeURIComponent(id)}`);
      setConfirmRevokeId(null);
      await load();
    } catch (e) {
      setError((e as Error).message ?? 'Failed to revoke the API key');
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8" data-testid="apikeys-page">
      <h1 className="text-2xl font-semibold mb-2">API keys</h1>
      <p className="text-sm text-gray-600 mb-6">
        Keys let an agent or script send and track envelopes as you — pass one in the{' '}
        <code className="font-mono text-xs">Authorization</code> header (works with{' '}
        <code className="font-mono text-xs">kysigned-mcp</code> via{' '}
        <code className="font-mono text-xs">KYSIGNED_AUTHORIZATION</code>). A key cannot manage
        keys or your account. Revoking takes effect on the key's next use.
      </p>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* One-time minted-key panel — the ONLY place the raw key ever renders. */}
      {minted && (
        <div className="mb-8 p-4 border border-green-200 bg-green-50 rounded-lg" data-testid="apikeys-minted">
          <h2 className="text-sm font-semibold text-green-900 mb-1">
            Key created{minted.label ? ` — ${minted.label}` : ''}
          </h2>
          <p className="text-xs text-green-800 mb-3">
            Copy it now — this is the only time it is shown. Anyone holding it can act as you on
            envelope actions until you revoke it.
          </p>
          <div className="flex gap-2 items-center">
            <code
              className="flex-1 font-mono text-xs bg-white border border-green-200 rounded-lg px-3 py-2 break-all select-all"
              data-testid="apikeys-minted-key"
            >
              {minted.key}
            </code>
            <button
              onClick={copyKey}
              className="inline-flex items-center justify-center min-h-[44px] px-4 py-2 bg-green-700 text-white rounded-lg text-sm font-medium transition-colors duration-150 hover:bg-green-800 cursor-pointer"
              data-testid="apikeys-copy"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={() => setMinted(null)}
              className="inline-flex items-center justify-center min-h-[44px] px-4 py-2 border border-green-300 text-green-900 rounded-lg text-sm font-medium transition-colors duration-150 hover:bg-green-100 cursor-pointer"
              data-testid="apikeys-dismiss"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Mint */}
      <div className="mb-8 p-4 border border-gray-200 rounded-lg bg-white">
        <h2 className="text-sm font-semibold mb-3">Create a key</h2>
        <div className="flex gap-2 items-center">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder='Label (e.g. "mcp agent")'
            maxLength={100}
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            data-testid="apikeys-label"
          />
          <button
            onClick={createKey}
            disabled={creating}
            className="inline-flex items-center justify-center min-h-[44px] px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium transition-colors duration-150 hover:bg-gray-700 active:bg-gray-950 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="apikeys-create"
          >
            {creating ? 'Creating…' : 'Create key'}
          </button>
        </div>
      </div>

      <h2 className="text-sm font-semibold mb-3">Your keys</h2>
      {loading ? (
        <div className="text-center py-8">
          <div className="animate-spin h-5 w-5 border-4 border-gray-300 border-t-gray-900 rounded-full mx-auto" />
        </div>
      ) : keys.length === 0 ? (
        <p className="text-sm text-gray-600 py-8 text-center bg-white border border-gray-200 rounded-lg">
          No API keys yet. Create one above to let an agent send envelopes as you.
        </p>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-700">Label</th>
                <th className="text-left px-4 py-2 font-medium text-gray-700">Created</th>
                <th className="text-left px-4 py-2 font-medium text-gray-700">Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-t border-gray-100" data-testid={`apikeys-row-${k.id}`}>
                  <td className="px-4 py-2">{k.label || <em className="text-gray-600">unnamed</em>}</td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {new Date(k.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {k.revoked_at ? (
                      <span
                        className="text-xs text-gray-600 border border-gray-200 rounded px-2 py-0.5"
                        data-testid={`apikeys-revoked-${k.id}`}
                      >
                        Revoked
                      </span>
                    ) : confirmRevokeId === k.id ? (
                      <span className="text-xs">
                        <button
                          onClick={() => revokeKey(k.id)}
                          className="text-red-600 hover:underline mr-2"
                          data-testid={`apikeys-confirm-${k.id}`}
                        >
                          Confirm revoke
                        </button>
                        <button
                          onClick={() => setConfirmRevokeId(null)}
                          className="text-gray-600 hover:underline"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setConfirmRevokeId(k.id)}
                        className="text-xs text-red-600 hover:underline"
                        data-testid={`apikeys-revoke-${k.id}`}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
