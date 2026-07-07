import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import { passkeysSupported, registerPasskey } from '../auth/passkey';

const DISMISS_KEY = 'kysigned_passkey_nudge_dismissed';

/**
 * PasskeyNudge — a dismissible dashboard banner suggesting the signed-in user set
 * up a passkey, shown ONLY when they have none (it disappears once they create
 * one). The suggestion lives here — on the dashboard the user lands on after
 * sign-in — rather than on the throwaway magic-link confirmation tab that closes
 * (Barry 2026-06-16). Renders nothing when passkeys are unsupported, when the
 * user already has one, or once dismissed.
 */
export function PasskeyNudge() {
  const [show, setShow] = useState(false);
  const [status, setStatus] = useState<'idle' | 'creating' | 'error'>('idle');

  useEffect(() => {
    if (!passkeysSupported()) return;
    if (typeof localStorage !== 'undefined' && localStorage.getItem(DISMISS_KEY)) return;
    let cancelled = false;
    apiGet<{ passkeys?: unknown[] }>('/v1/auth/passkeys')
      .then((d) => {
        if (!cancelled && (d.passkeys?.length ?? 0) === 0) setShow(true);
      })
      .catch(() => {
        /* no nudge if we can't read the list */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;

  const create = async () => {
    setStatus('creating');
    const r = await registerPasskey({ label: 'This device' });
    if (r.ok) setShow(false);
    else setStatus('error');
  };

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* localStorage may be unavailable; dismissing for this view still works */
    }
    setShow(false);
  };

  return (
    <div
      data-testid="passkey-nudge"
      className="mb-6 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm text-gray-700">
          <span className="font-medium text-gray-900">Sign in faster next time.</span>{' '}
          Set up a passkey on this device and skip the email.
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={create}
            disabled={status === 'creating'}
            data-testid="passkey-nudge-create"
            className="px-3 py-1.5 bg-gray-900 text-white rounded-md text-sm font-medium hover:bg-gray-700 cursor-pointer disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {status === 'creating' ? 'Setting up…' : 'Set up a passkey'}
          </button>
          <button
            onClick={dismiss}
            data-testid="passkey-nudge-dismiss"
            className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-900 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      </div>
      {status === 'error' && (
        <p className="text-red-500 text-xs mt-2">Couldn&rsquo;t set up the passkey. Try again.</p>
      )}
    </div>
  );
}
