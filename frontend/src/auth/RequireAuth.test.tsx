/**
 * RequireAuth.test.tsx — TDD for the protected-route gate (2F.AUTH7).
 *
 * Renders the unified sign-in screen instead of children when no user is
 * signed in. This is also the v0.22.0 driver-bug regression test: protected
 * forms (CreateEnvelopePage) MUST be replaced by the sign-in screen for
 * anonymous visitors, NOT rendered with a 401-on-submit trap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './AuthContext';
import { RequireAuth } from './RequireAuth';

function ProtectedChild() {
  return <div data-testid="child">protected-content</div>;
}

describe('RequireAuth', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders children when user is signed in', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ email: 'alice@example.com' }), { status: 200 })),
    ));

    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <RequireAuth>
            <ProtectedChild />
          </RequireAuth>
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('child')).toBeInTheDocument();
    });
  });

  it('renders the sign-in screen (NOT children) when signed out — v0.22.0 driver-bug regression', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 })),
    ));

    render(
      <MemoryRouter initialEntries={['/dashboard/create']}>
        <AuthProvider>
          <RequireAuth>
            <ProtectedChild />
          </RequireAuth>
        </AuthProvider>
      </MemoryRouter>,
    );

    // Initial loading state — neither rendered yet
    // After hydrate completes with 401, sign-in screen replaces the child
    await waitFor(() => {
      expect(screen.queryByTestId('child')).not.toBeInTheDocument();
      // The sign-in screen has an email input (test-id wired in SignInScreen)
      expect(screen.getByTestId('signin-screen')).toBeInTheDocument();
    });
  });

  it('shows a loading state while AuthContext is hydrating', () => {
    // Block the fetch with a never-resolving promise so loading is stuck
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    render(
      <MemoryRouter>
        <AuthProvider>
          <RequireAuth>
            <ProtectedChild />
          </RequireAuth>
        </AuthProvider>
      </MemoryRouter>,
    );

    // Neither protected content nor sign-in screen is shown while loading
    expect(screen.queryByTestId('child')).not.toBeInTheDocument();
    expect(screen.queryByTestId('signin-screen')).not.toBeInTheDocument();
  });
});
