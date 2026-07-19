/**
 * AuthContext.test.tsx — TDD for the shared SPA auth shell (2F.AUTH7, F2.1.10).
 *
 * AuthContext is the SPA's single source of truth for "who is signed in."
 * It hydrates from `GET /v1/auth/user` on mount, listens to a
 * `BroadcastChannel('kysigned-auth')` for cross-tab sync, and re-fetches on
 * `visibilitychange` so a sign-in completed in another tab is picked up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider } from './AuthContext';
import { useAuth } from './auth-core';

function AuthProbe() {
  const { user, loading } = useAuth();
  if (loading) return <div data-testid="state">loading</div>;
  return <div data-testid="state">{user ? `signed-in:${user.email}` : 'signed-out'}</div>;
}

// SS.3 / F1.11: probe that surfaces the creator's saved name.
function DisplayNameProbe() {
  const { user, loading } = useAuth();
  if (loading) return <div data-testid="dn">loading</div>;
  return <div data-testid="dn">{user ? `name:${user.display_name ?? '(none)'}` : 'signed-out'}</div>;
}

describe('AuthContext', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Default: signed-out
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 }))));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('hydrates from /v1/auth/user on mount → 200 populates user', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ email: 'alice@example.com' }), { status: 200 })),
    ));

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('state').textContent).toBe('signed-in:alice@example.com');
    });
  });

  it('hydrates from /v1/auth/user on mount → 401 sets user=null', async () => {
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('state').textContent).toBe('signed-out');
    });
  });

  it('uses credentials:include on the hydration fetch', async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ email: 'a@b.c' }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.credentials).toBe('include');
  });

  it('reacts to BroadcastChannel signed-out → clears user', async () => {
    // Start signed in
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ email: 'alice@example.com' }), { status: 200 })),
    ));

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('state').textContent).toBe('signed-in:alice@example.com');
    });

    // Broadcast signed-out from another tab
    await act(async () => {
      const channel = new BroadcastChannel('kysigned-auth');
      channel.postMessage({ type: 'signed-out' });
      channel.close();
      // Give the listener a microtask to fire
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('state').textContent).toBe('signed-out');
    });
  });

  it('reacts to BroadcastChannel signed-in → re-fetches /v1/auth/user to confirm', async () => {
    // Start signed out
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 })),
    );
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('state').textContent).toBe('signed-out');
    });

    // After the initial 401, sign-in completes in another tab.
    // Switch the fetch to return 200 for /v1/auth/user.
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ email: 'bob@example.com' }), { status: 200 })),
    );

    await act(async () => {
      const channel = new BroadcastChannel('kysigned-auth');
      channel.postMessage({ type: 'signed-in', email: 'bob@example.com' });
      channel.close();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('state').textContent).toBe('signed-in:bob@example.com');
    });
  });

  // SS.3 / DD-97 / F1.11: the creator's saved name flows through to the SPA.
  it('surfaces display_name from /v1/auth/user when present', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ email: 'creator@example.com', display_name: 'Jordan R' }), { status: 200 })),
    ));

    render(
      <AuthProvider>
        <DisplayNameProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('dn').textContent).toBe('name:Jordan R');
    });
  });
});
