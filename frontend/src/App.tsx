import { useEffect } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { SigningPage } from './pages/SigningPage'
import { DashboardPage } from './pages/DashboardPage'
import { EnvelopeDetailPage } from './pages/EnvelopeDetailPage'
import { CreateEnvelopePage } from './pages/CreateEnvelopePage'
import { VerifyPage } from './pages/VerifyPage'
import { HashCheckPage } from './pages/HashCheckPage'
import { MarketingHomePage } from './pages/MarketingHomePage'
import { PasskeysPage } from './pages/PasskeysPage'
import { ApiKeysPage } from './pages/ApiKeysPage'
import { AdminConsolePage } from './pages/AdminConsolePage'
import { AuthProvider } from './auth/AuthContext'
import { RequireAuth } from './auth/RequireAuth'
import { SignInScreen } from './auth/SignInScreen'
import { AppHeader } from './components/AppHeader'
import { captureAttribution } from './lib/attribution'

// v0.22.0 / 2F.AUTH7: `/` doubles as marketing landing AND sign-in entry.
// AppHeader's "Sign in" routes through `/?intent=signin`; magic-link emails
// land on `/?token=...`. Either query param flips this route to the unified
// SignInScreen so visitors aren't stuck staring at the splash.
function HomeRoute() {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const wantsSignIn =
    params.get('intent') === 'signin' || params.has('token')
  return wantsSignIn ? <SignInScreen /> : <MarketingHomePage />
}

export function App() {
  // F-37 (AC-205): a gclid arriving on any SPA URL is captured first-party on
  // mount. `useLocation` (not window.location) so router-provided URLs — tests,
  // memory routers — are seen; operator-config-gated inside the module, so a
  // fresh fork stores nothing.
  const location = useLocation()
  useEffect(() => {
    captureAttribution({ search: location.search })
    // Capture only ever acts on the LANDING url's gclid (first-touch); no need
    // to re-run per navigation, but re-running is harmless and keeps deep-link
    // arrivals covered when the SPA soft-navigates with a fresh gclid.
  }, [location.search])
  return (
    // v0.22.0 / 2F.AUTH7 / F2.1.10: AuthProvider wraps the whole SPA.
    // <AppHeader/> renders identity-aware nav above every route.
    // <RequireAuth/> gates protected routes (dashboard, create, detail,
    // account/*) — anonymous visitors see the unified sign-in screen.
    <AuthProvider>
      <div className="min-h-screen bg-gray-50 text-gray-900">
        <AppHeader />
        <Routes>
          {/* v0.22.1 / DD-73 + AUTH7: `/` is the public marketing landing
              under the single-project same-origin model. `?intent=signin`
              and `?token=...` flip the route to SignInScreen via HomeRoute. */}
          <Route path="/" element={<HomeRoute />} />
          <Route path="/review/:envelopeId/:token" element={<SigningPage />} />
          <Route path="/sign/:envelopeId/:token" element={<SigningPage />} />
          {/* Evidence-bundle verifier (F-10.1 / AC-27): drag-drop a bundle PDF,
              verified entirely client-side by the WebCrypto engine. Public — no
              auth, no account; the file never leaves the browser. */}
          <Route path="/verify" element={<VerifyPage />} />
          <Route path="/hashcheck" element={<HashCheckPage />} />
          {/* Protected routes — 2F.AUTH7 driver-bug fix: anonymous visitors
              see the sign-in screen, NOT a 401-on-submit trap. */}
          <Route
            path="/dashboard"
            element={
              <RequireAuth>
                <DashboardPage />
              </RequireAuth>
            }
          />
          <Route
            path="/dashboard/envelope/:id"
            element={
              <RequireAuth>
                <EnvelopeDetailPage />
              </RequireAuth>
            }
          />
          <Route
            path="/dashboard/create"
            element={
              <RequireAuth>
                <CreateEnvelopePage />
              </RequireAuth>
            }
          />
          <Route
            path="/account/passkeys"
            element={
              <RequireAuth>
                <PasskeysPage />
              </RequireAuth>
            }
          />
          <Route
            path="/account/api-keys"
            element={
              <RequireAuth>
                <ApiKeysPage />
              </RequireAuth>
            }
          />
          {/* F-33 (#148) operator surface — NOT linked from the nav. RequireAuth
              blocks anonymous visitors (sign-in screen); the page's data endpoint
              is operator-gated server-side (F-33.1), so a signed-in non-operator
              gets the access-denied view rather than the reconciliation data. */}
          <Route
            path="/admin"
            element={
              <RequireAuth>
                <AdminConsolePage />
              </RequireAuth>
            }
          />
          {/* Static information pages are served by Run402 static aliases, not
              SPA routes. The AppHeader links to them via full-navigation <a>
              elements so deep-link anchors work without client routing. */}
        </Routes>
      </div>
    </AuthProvider>
  )
}
