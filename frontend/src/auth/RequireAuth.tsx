/**
 * RequireAuth.tsx — route-level auth gate (2F.AUTH7 / F2.1.10).
 *
 * Wraps protected routes. While AuthContext is hydrating, renders nothing
 * (the AppHeader still shows; the routes below it are blank). On hydrate:
 * if signed-in, renders children; if signed-out, renders the unified
 * SignInScreen instead — preserving the requested path as `?next=` so we
 * can return there after sign-in.
 *
 * This is the route-level fix for the v0.22.0 driver-bug: an anonymous
 * visitor hitting `/dashboard/create` no longer sees the CreateEnvelope form
 * (which would 401 on submit). They see the sign-in screen.
 */
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from './auth-core';
import { SignInScreen } from './SignInScreen';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <div className="animate-spin h-6 w-6 border-4 border-gray-300 border-t-gray-900 rounded-full mx-auto" />
      </div>
    );
  }

  if (!user) {
    // F-38.3 / AC-230 (F-022) — name WHICH gate this is: `?intent=signin`
    // marks a DELIBERATE sign-in (every static page's Sign-in link carries it;
    // the SPA header's link routes through /?intent=signin already), while a
    // bare protected-path arrival is the genuine bounce. Before F-022 the two
    // were indistinguishable — the majority real-world path (static-header
    // Sign-in → /dashboard) recorded as a bounce.
    const deliberate = new URLSearchParams(location.search).get('intent') === 'signin';
    return <SignInScreen telemetryTrigger={deliberate ? 'direct' : 'redirect'} />;
  }

  return <>{children}</>;
}
