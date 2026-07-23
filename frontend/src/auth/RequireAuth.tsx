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
import { useAuth } from './auth-core';
import { SignInScreen } from './SignInScreen';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <div className="animate-spin h-6 w-6 border-4 border-gray-300 border-t-gray-900 rounded-full mx-auto" />
      </div>
    );
  }

  if (!user) {
    // F-38.3 — the visitor BOUNCED here from a protected action (e.g. a
    // signed-out create-envelope attempt): the prompt records the redirect
    // trigger, distinguishing "reached the gate" from "came to sign in".
    return <SignInScreen telemetryTrigger="redirect" />;
  }

  return <>{children}</>;
}
