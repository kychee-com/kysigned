/**
 * AppHeader.test.tsx — TDD for the canonical SPA header (2F.AUTH7 / F11.9).
 *
 * Structure: logo-left / centered-link-cluster / auth-widget-right.
 * Signed-out widget: `Sign in` button, no Dashboard link.
 * Signed-in widget: `{email ▾}` dropdown with Dashboard / Account / Passkeys / Sign out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthContext';
import { AppHeader } from './AppHeader';

describe('AppHeader — signed-out state', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 })),
    ));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders Sign in button when signed out', async () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <AppHeader />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('header-signin')).toBeInTheDocument();
    });
  });

  it('does NOT render Dashboard link when signed out', async () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <AppHeader />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('header-signin')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('header-dashboard-link')).not.toBeInTheDocument();
  });

  it('does NOT render the email dropdown when signed out', async () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <AppHeader />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('header-signin')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('header-user-menu')).not.toBeInTheDocument();
  });

  it('renders static information links through deploy-safe aliases', async () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <AppHeader />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('header-signin')).toBeInTheDocument();
    });
    const howItWorks = screen.getByRole('link', { name: /how it works/i });
    expect(howItWorks).toHaveAttribute('href', '/how-it-works');
    const faq = screen.getByRole('link', { name: /faq/i });
    expect(faq).toHaveAttribute('href', '/faq');
  });

  // GH#103 / F-17.7: Pricing is operator-specific — the public default (no
  // VITE_OPERATOR_CONFIG) shows NO "Pricing" nav item.
  it('does NOT render a Pricing nav item by default (operator-free)', async () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <AppHeader />
        </AuthProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('header-signin')).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: /pricing/i })).not.toBeInTheDocument();
  });

  // FC1.7 / F-003: the public repo 404s until the launch flip (task 20.8), so the
  // header must NOT link it pre-launch. (Re-add + flip this assertion at launch.)
  it('does NOT link the public repo before launch (no GitHub nav link, no 404)', async () => {
    const { container } = render(
      <MemoryRouter>
        <AuthProvider>
          <AppHeader />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('header-signin')).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: /github/i })).not.toBeInTheDocument();
    const repoLinks = container.querySelectorAll('a[href*="github.com/kychee-com/kysigned"]');
    expect(repoLinks.length).toBe(0);
  });

  // GH#24 — mobile header must not garble: the Sign-in chip stays one line, and
  // the centered link cluster collapses on small screens (shown md+ only) so it
  // can't overflow/wrap a ~360px viewport.
  it('keeps the Sign-in chip on one line and collapses the centered nav on mobile (GH#24)', async () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <AppHeader />
        </AuthProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('header-signin')).toBeInTheDocument());
    const chip = screen.getByTestId('header-signin');
    expect(chip.className).toMatch(/whitespace-nowrap/);
    const nav = chip.closest('header')!.querySelector('nav')!;
    expect(nav.className).toMatch(/hidden/);
    expect(nav.className).toMatch(/md:flex/);
  });
});

describe('AppHeader — signed-in state', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ email: 'alice@example.com' }), { status: 200 })),
    ));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders {email ▾} dropdown trigger', async () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <AppHeader />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('header-user-menu')).toBeInTheDocument();
    });
    expect(screen.getByTestId('header-user-menu')).toHaveTextContent('alice@example.com');
  });

  it('renders Dashboard link', async () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <AppHeader />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('header-dashboard-link')).toBeInTheDocument();
    });
  });

  it('reveals Sign out item when dropdown trigger is clicked', async () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <AppHeader />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('header-user-menu')).toBeInTheDocument();
    });

    // Dropdown closed initially
    expect(screen.queryByTestId('header-signout')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('header-user-menu'));

    expect(screen.getByTestId('header-signout')).toBeInTheDocument();
  });

  it('clicking Sign out calls /v1/auth/signout', async () => {
    const fetchSpy = vi.fn((url: string) => {
      if (url.endsWith('/v1/auth/user')) {
        return Promise.resolve(new Response(JSON.stringify({ email: 'alice@example.com' }), { status: 200 }));
      }
      if (url.endsWith('/v1/auth/signout')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <MemoryRouter>
        <AuthProvider>
          <AppHeader />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('header-user-menu')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('header-user-menu'));
    fireEvent.click(screen.getByTestId('header-signout'));

    await waitFor(() => {
      const signoutCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/v1/auth/signout'));
      expect(signoutCall).toBeDefined();
    });
  });
});

// GH#41 / AC-84 — the authed app shell must be mobile-correct: a hamburger that
// exposes the nav + account, a compact signed-in INDICATOR instead of the raw
// email in the bar, and the email shown INSIDE the menu. Desktop is md:-gated and
// untouched (asserted via the classes on the desktop widget).
describe('AppHeader — mobile shell (GH#41 / AC-84)', () => {
  const renderHeader = () =>
    render(
      <MemoryRouter>
        <AuthProvider>
          <AppHeader />
        </AuthProvider>
      </MemoryRouter>,
    );

  describe('signed in', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ email: 'alice@example.com' }), { status: 200 })),
      ));
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('renders a mobile hamburger toggle and a signed-in indicator (not the raw email) in the bar', async () => {
      renderHeader();
      await waitFor(() => expect(screen.getByTestId('header-mobile-toggle')).toBeInTheDocument());
      // Indicator shows the initial, not the address.
      const indicator = screen.getByTestId('header-mobile-indicator');
      expect(indicator).toHaveTextContent('A');
      // The mobile bar must NOT carry the raw email before the menu is opened.
      const cluster = screen.getByTestId('header-mobile-cluster');
      expect(within(cluster).queryByText('alice@example.com')).not.toBeInTheDocument();
    });

    it('keeps the email-bearing desktop widget md:-gated (desktop untouched)', async () => {
      renderHeader();
      await waitFor(() => expect(screen.getByTestId('header-user-menu')).toBeInTheDocument());
      const desktopWidget = screen.getByTestId('header-user-menu').closest('div.relative')!;
      expect(desktopWidget.className).toMatch(/hidden/);
      expect(desktopWidget.className).toMatch(/md:block/);
    });

    it('opening the hamburger reveals the nav links, the email (inside the menu), and Sign out', async () => {
      renderHeader();
      await waitFor(() => expect(screen.getByTestId('header-mobile-toggle')).toBeInTheDocument());
      expect(screen.queryByTestId('header-mobile-menu')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('header-mobile-toggle'));

      const menu = screen.getByTestId('header-mobile-menu');
      expect(within(menu).getByText('alice@example.com')).toBeInTheDocument();
      // Pricing is operator-gated (absent by default); the always-present nav
      // links prove the menu populated.
      expect(within(menu).queryByText('Pricing')).not.toBeInTheDocument();
      expect(within(menu).getByText('How it works')).toBeInTheDocument();
      expect(within(menu).getByTestId('header-signout-mobile')).toBeInTheDocument();
    });
  });

  describe('signed out', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 })),
      ));
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('renders the hamburger + a mobile Sign in; the menu exposes the nav links', async () => {
      renderHeader();
      await waitFor(() => expect(screen.getByTestId('header-mobile-toggle')).toBeInTheDocument());
      expect(screen.getByTestId('header-signin-mobile')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('header-mobile-toggle'));
      const menu = screen.getByTestId('header-mobile-menu');
      expect(within(menu).getByText('FAQ')).toBeInTheDocument();
      expect(within(menu).getByText('Verify')).toBeInTheDocument();
    });

    // FC1.2 regression (system-test cycle-1 F-002, UX-004/005/007): the header
    // tap targets were below the 44x44 WCAG minimum on mobile (logo a.flex 111x32,
    // Sign-in a.px-3 71x34, hamburger button.p-1.5 34x34). Assert the min-size
    // utility classes are present so the touch targets meet 44px.
    it('header tap targets meet the 44px touch-target minimum (F-002)', async () => {
      renderHeader();
      await waitFor(() => expect(screen.getByTestId('header-mobile-toggle')).toBeInTheDocument());
      // hamburger: 44x44
      const burger = screen.getByTestId('header-mobile-toggle');
      expect(burger.className).toMatch(/min-h-\[44px\]/);
      expect(burger.className).toMatch(/min-w-\[44px\]/);
      // mobile Sign-in: >=44px tall
      expect(screen.getByTestId('header-signin-mobile').className).toMatch(/min-h-\[44px\]/);
      // logo link: >=44px tall
      const logo = burger.closest('header')!.querySelector('a[href="/"]')!;
      expect(logo.className).toMatch(/min-h-\[44px\]/);
    });
  });
});

// GH#103 / F-17.7 / AC-128 — operator identity is config-injected. With
// showPricing enabled (as kysigned.com does via VITE_OPERATOR_CONFIG) the
// "Pricing" nav item returns, and the brand wordmark follows brandName.
describe('AppHeader — operator config injected', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 })),
    ));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('renders the Pricing nav item and the operator brand when the config enables them', async () => {
    vi.stubEnv('VITE_OPERATOR_CONFIG', JSON.stringify({ brandName: 'Acme Sign', showPricing: true }));
    render(
      <MemoryRouter>
        <AuthProvider>
          <AppHeader />
        </AuthProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('header-signin')).toBeInTheDocument();
    });
    const pricing = screen.getByRole('link', { name: /pricing/i });
    expect(pricing).toHaveAttribute('href', '/pricing');
    expect(screen.getByRole('link', { name: /Acme Sign/i })).toBeInTheDocument();
  });
});
