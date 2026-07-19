/**
 * AppHeader.tsx — canonical SPA header rendered above every route
 * (2F.AUTH7 / F2.1.10 / F11.9).
 *
 * Structure: logo-left / centered-link-cluster / auth-widget-right.
 *
 * Auth widget (desktop, ≥ md):
 *   - Signed out: primary `Sign in` button (links to `/?intent=signin&next=<path>`).
 *     Hides Dashboard from the centered cluster — unauthenticated visitors
 *     shouldn't be invited to land on the sign-in form via nav.
 *   - Signed in: `{email ▾}` dropdown with Dashboard / Account / Passkeys /
 *     Sign out. Dashboard is also added to the right edge of the centered
 *     cluster (per F11.9). Sign out calls AuthContext.signOut() which POSTs
 *     /v1/auth/signout and broadcasts signed-out.
 *
 * Mobile shell (< md, GH#41 / AC-84): the centered nav and the email-bearing
 * desktop widget are `md:`-gated, so on a phone they're replaced by a compact
 * cluster — a signed-in **indicator** (avatar initial, never the raw email,
 * which would overflow the bar) or a `Sign in` button, plus a **hamburger** that
 * opens a menu exposing every nav link AND the account actions (the email is
 * shown *inside* the menu). The desktop branch is unchanged — this is additive,
 * gated behind `md:hidden` / `hidden md:…`.
 *
 * The header is layout-only — it doesn't introspect the route, doesn't
 * inject sidebars, doesn't intercept clicks. Routes own their own layout
 * inside the body.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/auth-core';
import { getOperatorConfig } from '../config/operator';

export function AppHeader() {
  const { user, loading } = useAuth();
  const location = useLocation();
  // GH#103 / F-17.7: brand wordmark + whether the "Pricing" nav item shows are
  // config-injected. A fresh fork gets the generic brand and NO pricing item.
  const { brandName, showPricing } = getOperatorConfig();
  const [menuOpen, setMenuOpen] = useState(false); // desktop {email ▾} dropdown
  const [mobileOpen, setMobileOpen] = useState(false); // mobile hamburger panel
  const menuRef = useRef<HTMLDivElement>(null);
  const mobileRef = useRef<HTMLDivElement>(null);

  // Close whichever menu is open on an outside click.
  useEffect(() => {
    if (!menuOpen && !mobileOpen) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuOpen && !menuRef.current?.contains(t)) setMenuOpen(false);
      if (mobileOpen && !mobileRef.current?.contains(t)) setMobileOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen, mobileOpen]);

  const signinHref = (() => {
    const params = new URLSearchParams({ intent: 'signin', next: location.pathname });
    return `/?${params.toString()}`;
  })();

  const closeMobile = () => setMobileOpen(false);
  const mobileItem = 'block px-3 py-2 hover:bg-gray-50 text-gray-700';

  return (
    <header className="border-b border-gray-200 bg-white">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
        {/* Logo (left) */}
        <Link to="/" className="flex items-center gap-2 text-base font-semibold text-gray-900 shrink-0 whitespace-nowrap min-h-[44px]">
          <img src="/favicon.png" alt="" width={32} height={32} className="rounded" />
          <span>{brandName}</span>
        </Link>

        {/* Centered links — AC-168 / F11.9 order: Pricing, How it works, FAQ,
            Verify. The GitHub link is intentionally OMITTED until launch (FC1.7 /
            F-003): the public repo github.com/kychee-com/kysigned 404s until the
            visibility flip (Phase 20.8), so no live surface links it pre-launch.
            Re-add it (here + the mobile menu below + the static injectSiteHeader)
            with the flip. Desktop-only (hidden md:flex) — mobile menu mirrors these. */}
        <nav className="hidden md:flex flex-1 items-center justify-center gap-6 text-sm text-gray-600 whitespace-nowrap">
          <Link
            to="/dashboard/create"
            data-testid="header-create-link"
            className="inline-flex items-center min-h-[36px] px-3 py-1.5 rounded-md bg-[#1a1b2f] text-white font-medium hover:bg-[#2a2b42] whitespace-nowrap"
          >
            Create
          </Link>
          {/* GH#103 — Pricing is operator-specific; shown only when the operator
              config enables it (a fresh fork has no pricing surface). */}
          {showPricing && <a href="/pricing" className="hover:text-gray-900">Pricing</a>}
          {/* AC-126 — how-it-works + FAQ are STATIC pages now, so full-navigation
              <a href> (a client-side <Link> would find no SPA route and white-page). */}
          <a href="/how-it-works" className="hover:text-gray-900">How it works</a>
          <a href="/faq" className="hover:text-gray-900">FAQ</a>
          <Link to="/verify" className="hover:text-gray-900">Verify</Link>
          {user && (
            <Link
              to="/dashboard"
              className="hover:text-gray-900 font-medium text-gray-800"
              data-testid="header-dashboard-link"
            >
              Dashboard
            </Link>
          )}
        </nav>

        {/* Auth widget (right) — DESKTOP ONLY (md:block). Unchanged from the
            pre-GH#41 header; gated so the email never sits in the mobile bar. */}
        <div className="relative shrink-0 hidden md:block" ref={menuRef}>
          {loading ? null : user ? (
            <>
              <button
                onClick={() => setMenuOpen((v) => !v)}
                data-testid="header-user-menu"
                className="flex items-center gap-1 text-sm text-gray-700 hover:text-gray-900 font-mono min-w-0 max-w-[55vw] md:max-w-none"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <span className="truncate">{user.email}</span>
                <span aria-hidden="true">▾</span>
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 mt-2 w-44 rounded-md border border-gray-200 bg-white shadow-lg py-1 z-50 text-sm"
                >
                  <Link
                    to="/dashboard"
                    role="menuitem"
                    className="block px-3 py-1.5 hover:bg-gray-50"
                    onClick={() => setMenuOpen(false)}
                  >
                    Dashboard
                  </Link>
                  <Link
                    to="/account/passkeys"
                    role="menuitem"
                    className="block px-3 py-1.5 hover:bg-gray-50"
                    onClick={() => setMenuOpen(false)}
                  >
                    Passkeys
                  </Link>
                  <Link
                    to="/account/api-keys"
                    role="menuitem"
                    className="block px-3 py-1.5 hover:bg-gray-50"
                    onClick={() => setMenuOpen(false)}
                  >
                    API keys
                  </Link>
                  <SignOutMenuItem onAfter={() => setMenuOpen(false)} />
                </div>
              )}
            </>
          ) : (
            <Link
              to={signinHref}
              data-testid="header-signin"
              className="inline-flex items-center min-h-[44px] px-3 py-1.5 border border-gray-300 text-gray-900 rounded-md text-sm font-medium hover:bg-gray-50 whitespace-nowrap shrink-0"
            >
              Sign in
            </Link>
          )}
        </div>

        {/* Mobile cluster (right) — MOBILE ONLY (md:hidden). A signed-in
            indicator (initial, never the raw email) or a Sign in button, plus a
            hamburger that opens the full nav + account menu (GH#41 / AC-84). */}
        <div className="relative shrink-0 md:hidden flex items-center gap-2" ref={mobileRef} data-testid="header-mobile-cluster">
          {!loading && user && (
            <span
              aria-hidden="true"
              data-testid="header-mobile-indicator"
              title={user.email}
              className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-[#1a1b2f] text-white text-xs font-semibold shrink-0"
            >
              {user.email.charAt(0).toUpperCase()}
            </span>
          )}
          {!loading && !user && (
            <Link
              to={signinHref}
              data-testid="header-signin-mobile"
              className="inline-flex items-center min-h-[44px] px-3 py-1.5 border border-gray-300 text-gray-900 rounded-md text-sm font-medium hover:bg-gray-50 whitespace-nowrap"
            >
              Sign in
            </Link>
          )}
          <button
            onClick={() => setMobileOpen((v) => !v)}
            data-testid="header-mobile-toggle"
            aria-label="Menu"
            aria-haspopup="menu"
            aria-expanded={mobileOpen}
            className="flex items-center justify-center min-h-[44px] min-w-[44px] p-1.5 text-gray-700 hover:text-gray-900 rounded-md hover:bg-gray-50"
          >
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3.5 6h15M3.5 11h15M3.5 16h15" strokeLinecap="round" />
            </svg>
          </button>
          {mobileOpen && (
            <div
              role="menu"
              data-testid="header-mobile-menu"
              className="absolute right-0 top-full mt-2 w-56 rounded-md border border-gray-200 bg-white shadow-lg py-1 z-50 text-sm"
            >
              {/* Nav links — keep in sync with the desktop <nav> above. */}
              <Link to="/dashboard/create" role="menuitem" data-testid="header-create-mobile" className="block mx-2 my-1 px-3 py-2 rounded-md bg-[#1a1b2f] text-white font-medium text-center" onClick={closeMobile}>Create</Link>
              {showPricing && <a href="/pricing" role="menuitem" className={mobileItem} onClick={closeMobile}>Pricing</a>}
              <a href="/how-it-works" role="menuitem" className={mobileItem} onClick={closeMobile}>How it works</a>
              <a href="/faq" role="menuitem" className={mobileItem} onClick={closeMobile}>FAQ</a>
              <Link to="/verify" role="menuitem" className={mobileItem} onClick={closeMobile}>Verify</Link>
              {/* GitHub omitted until launch — see the desktop <nav> note (FC1.7/F-003). */}
              {user ? (
                <>
                  <div className="border-t border-gray-100 my-1" />
                  {/* The signed-in email lives INSIDE the menu, not in the bar. */}
                  <div className="px-3 py-1 text-xs text-gray-500 font-mono truncate" title={user.email}>{user.email}</div>
                  <Link to="/dashboard" role="menuitem" className="block px-3 py-2 hover:bg-gray-50 text-gray-800 font-medium" onClick={closeMobile}>Dashboard</Link>
                  <Link to="/account/passkeys" role="menuitem" className={mobileItem} onClick={closeMobile}>Passkeys</Link>
                  <Link to="/account/api-keys" role="menuitem" className={mobileItem} onClick={closeMobile}>API keys</Link>
                  <SignOutMenuItem testId="header-signout-mobile" onAfter={closeMobile} />
                </>
              ) : (
                <>
                  <div className="border-t border-gray-100 my-1" />
                  <Link to={signinHref} role="menuitem" className="block px-3 py-2 hover:bg-gray-50 text-gray-900 font-medium" onClick={closeMobile}>Sign in</Link>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function SignOutMenuItem({ onAfter, testId = 'header-signout' }: { onAfter: () => void; testId?: string }) {
  const { signOut } = useAuth();
  return (
    <button
      role="menuitem"
      data-testid={testId}
      onClick={async () => {
        onAfter();
        await signOut();
      }}
      className="w-full text-left px-3 py-1.5 hover:bg-gray-50 text-gray-700"
    >
      Sign out
    </button>
  );
}
