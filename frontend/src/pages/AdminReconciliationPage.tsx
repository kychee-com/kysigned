/**
 * AdminReconciliationPage — the `/admin` operator dashboard (F-33.2/F-33.3, #148).
 *
 * OPERATOR-ONLY. Lists the outstanding archive-confirmation backlog (F-32.7's
 * non-clean signature artifacts) read from GET /v1/admin/archive-confirmations.
 * That endpoint is operator-gated server-side (F-33.1): a signed-in NON-operator
 * gets a 403, which this page renders as an access-denied notice INSTEAD of the
 * data — so a non-operator cannot view the operator view (AC-179). Anonymous
 * visitors never reach here: App.tsx wraps the route in <RequireAuth/>, which
 * shows the sign-in screen. This page is NOT linked from the creator nav.
 *
 * The mechanism is forkable `[both]`; a fork with no operator emails configured
 * fails closed (every session 403s → the denied view), and kysigned.com's operator
 * list is `[service]` config (AC-181).
 */
import { useEffect, useState } from 'react';
import { apiGet, ApiError } from '../lib/api';

interface OutstandingRow {
  envelope_id: string;
  signer_email: string;
  dkim_domain: string | null;
  dkim_selector: string | null;
  /** confirmed rows are excluded server-side; NULL is surfaced as "unknown". */
  state: 'unconfirmed' | 'outage' | 'unknown';
  checked_at: string | null;
  healed_at: string | null;
  created_at: string;
}

export function AdminReconciliationPage({ excludeInternal = true }: { excludeInternal?: boolean } = {}) {
  const [rows, setRows] = useState<OutstandingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const data = await apiGet<{ outstanding: OutstandingRow[] }>(
          `/v1/admin/archive-confirmations?exclude_internal=${excludeInternal ? '1' : '0'}`,
        );
        if (active) setRows(data.outstanding ?? []);
      } catch (e) {
        if (!active) return;
        if (e instanceof ApiError && e.status === 403) setDenied(true);
        else setError((e as Error).message ?? 'Failed to load the reconciliation view');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [excludeInternal]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-20 text-center" data-testid="admin-loading">
        <div className="animate-spin h-6 w-6 border-4 border-gray-300 border-t-gray-900 rounded-full mx-auto" />
      </div>
    );
  }

  if (denied) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center" data-testid="admin-denied">
        <h1 className="text-xl font-semibold mb-2">Operator access required</h1>
        <p className="text-sm text-gray-600">This page is restricted to kysigned operators.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8" data-testid="admin-reconciliation-page">
      <h1 className="text-2xl font-semibold mb-2">Archive-confirmation reconciliation</h1>
      <p className="text-sm text-gray-600 mb-6">
        Signature artifacts whose third-party archive confirmation is not yet clean. These self-heal
        when the archive observes the key; a row that never clears may need a re-sign, which is your
        call — signers are never contacted automatically.
      </p>
      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm" data-testid="admin-error">
          {error}
        </div>
      )}
      {rows.length === 0 ? (
        <p
          className="text-sm text-gray-600 py-8 text-center bg-white border border-gray-200 rounded-lg"
          data-testid="admin-empty"
        >
          No outstanding archive confirmations. Every signature artifact is confirmed.
        </p>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-x-auto bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-700">Envelope</th>
                <th className="text-left px-4 py-2 font-medium text-gray-700">Signer</th>
                <th className="text-left px-4 py-2 font-medium text-gray-700">Domain / selector</th>
                <th className="text-left px-4 py-2 font-medium text-gray-700">State</th>
                <th className="text-left px-4 py-2 font-medium text-gray-700">Checked</th>
                <th className="text-left px-4 py-2 font-medium text-gray-700">Signed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.envelope_id}:${r.signer_email}`}
                  className="border-t border-gray-100"
                  data-testid={`admin-row-${r.envelope_id}`}
                >
                  <td className="px-4 py-2 font-mono text-xs break-all">{r.envelope_id}</td>
                  <td className="px-4 py-2">{r.signer_email}</td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {r.dkim_domain ?? '—'}
                    {r.dkim_selector ? ` / ${r.dkim_selector}` : ''}
                  </td>
                  <td className="px-4 py-2">
                    <span className="text-xs border rounded px-2 py-0.5 border-amber-200 bg-amber-50 text-amber-800">
                      {r.state}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {r.checked_at ? new Date(r.checked_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {new Date(r.created_at).toLocaleDateString()}
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
