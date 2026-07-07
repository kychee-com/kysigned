import { Routes, Route, useLocation } from 'react-router-dom'
import { SigningPage } from './pages/SigningPage'
import { DashboardPage } from './pages/DashboardPage'
import { EnvelopeDetailPage } from './pages/EnvelopeDetailPage'
import { CreateEnvelopePage } from './pages/CreateEnvelopePage'
import { VerifyPage } from './pages/VerifyPage'
import { HashCheckPage } from './pages/HashCheckPage'
import { MarketingHomePage } from './pages/MarketingHomePage'
import { PasskeysPage } from './pages/PasskeysPage'
import { AuthProvider } from './auth/AuthContext'
import { RequireAuth } from './auth/RequireAuth'
import { SignInScreen } from './auth/SignInScreen'
import { AppHeader } from './components/AppHeader'

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
          {/* Static information pages are served by Run402 static aliases, not
              SPA routes. The AppHeader links to them via full-navigation <a>
              elements so deep-link anchors work without client routing. */}
        </Routes>
      </div>
    </AuthProvider>
  )
}
