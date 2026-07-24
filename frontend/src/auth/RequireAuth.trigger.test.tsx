/**
 * RequireAuth.trigger.test.tsx — F-022 (Cycle 19, AC-230): a DELIBERATE
 * sign-in must be distinguishable from a protected-page bounce. The static
 * pages' Sign-in links arrive at /dashboard carrying `?intent=signin`; that
 * arrival records the `direct` trigger. A bare protected-path arrival (the
 * genuine bounce) records `redirect`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { telemetryOnceMock } = vi.hoisted(() => ({ telemetryOnceMock: vi.fn() }));

vi.mock('../lib/telemetry', () => ({
  telemetryEvent: vi.fn(),
  telemetryEventOnce: telemetryOnceMock,
  telemetryPageView: vi.fn(),
}));

vi.mock('./passkey', () => ({
  passkeysSupported: () => false,
  conditionalMediationAvailable: async () => false,
  startConditionalPasskeyLogin: async () => ({ ok: false }),
  signInWithPasskey: async () => ({ ok: false }),
}));

import { AuthProvider } from './AuthContext';
import { RequireAuth } from './RequireAuth';

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AuthProvider>
        <RequireAuth>
          <div>protected</div>
        </RequireAuth>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('RequireAuth — prompt trigger vocabulary (F-022 / AC-230)', () => {
  beforeEach(() => {
    telemetryOnceMock.mockReset();
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 })),
    ));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a deliberate arrival (?intent=signin — every static Sign-in link) records the DIRECT trigger', async () => {
    renderAt('/dashboard?intent=signin');
    await waitFor(() => expect(telemetryOnceMock).toHaveBeenCalledWith('signin_prompt', 'direct'));
    expect(telemetryOnceMock).not.toHaveBeenCalledWith('signin_prompt', 'redirect');
  });

  it('a bare protected-path arrival (the genuine bounce) still records REDIRECT', async () => {
    renderAt('/dashboard/envelope/abc');
    await waitFor(() => expect(telemetryOnceMock).toHaveBeenCalledWith('signin_prompt', 'redirect'));
  });
});
