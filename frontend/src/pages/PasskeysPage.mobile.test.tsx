/**
 * PasskeysPage.mobile.test.tsx — the cycle-24 Visual & Interaction QA findings
 * on Sign-in methods (UX-028…UX-037), all confined to the pre-existing passkeys
 * table and all surfaced because F-41.4 made this page in-scope for the first
 * time.
 *
 * The root cause was one thing: a 5-column table with no mobile handling, so at
 * 375px it simply overflowed — dates clipped mid-word ("5.7.2026" → "5.7."),
 * and the Delete control sat entirely off-screen at x=404px, meaning a phone
 * user could not delete a passkey AT ALL. These tests pin the structural
 * properties that fix has to keep; the rendered proof is the design-validation
 * sweep run against the deployed page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { apiGetMock, apiPostMock, apiDeleteMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiDeleteMock: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => {
  const actual = await importActual<typeof import('../lib/api')>();
  return { ...actual, apiGet: apiGetMock, apiPost: apiPostMock, apiDelete: apiDeleteMock };
});
vi.mock('../lib/hardNavigate', () => ({ hardNavigate: vi.fn() }));
vi.mock('../auth/passkey', () => ({ passkeysSupported: () => true, registerPasskey: async () => ({ ok: false }) }));

import { PasskeysPage } from './PasskeysPage';
import { resetAuthMethodsCache } from '../auth/google';

const ROWS = [
  { id: 'pk_1', label: null, rp_id: 'kysigned.com', created_at: '2026-07-05T00:00:00Z', last_used_at: '2026-07-05T00:00:00Z' },
  { id: 'pk_2', label: 'MacBook Touch ID', rp_id: 'kysigned.com', created_at: '2026-07-06T00:00:00Z', last_used_at: null },
];

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiDeleteMock.mockReset();
  resetAuthMethodsCache();
  window.history.replaceState({}, '', '/account/passkeys');
  apiGetMock.mockImplementation(async (path: string) => {
    if (path === '/v1/auth/methods') return { google: false };
    if (path === '/v1/auth/passkeys') return { passkeys: ROWS };
    throw new Error(`unexpected apiGet ${path}`);
  });
});

function renderPage() {
  return render(
    <MemoryRouter>
      <PasskeysPage />
    </MemoryRouter>,
  );
}

describe('every passkey is reachable on a phone (UX-028…UX-033)', () => {
  it('renders a NON-table mobile layout for each passkey, not just a desktop table', async () => {
    renderPage();
    // One card per passkey, present without needing horizontal scrolling.
    const cards = await screen.findAllByTestId(/^passkey-card-/);
    expect(cards).toHaveLength(ROWS.length);
    // The desktop table still exists, but is hidden at mobile widths.
    const table = document.querySelector('[data-testid="passkeys-table-wrap"]');
    expect(table?.className).toMatch(/hidden/);
    expect(table?.className).toMatch(/sm:block|sm:table/);
  });

  it('the Delete control is reachable on mobile and meets the 44px tap minimum', async () => {
    renderPage();
    const del = await screen.findByTestId('passkeys-delete-mobile-pk_1');
    expect(del.className).toMatch(/min-h-\[44px\]/);
    expect(del.className).toMatch(/min-w-\[44px\]|px-4|w-full/);
    // Not inside the horizontally-overflowing table.
    expect(del.closest('table')).toBeNull();
  });

  it('the add-passkey label input meets the tap minimum (UX-034: it was 6px short)', async () => {
    renderPage();
    const input = await screen.findByPlaceholderText(/Label \(e\.g\./);
    expect(input.className).toMatch(/min-h-\[44px\]/);
  });
});

describe('readable text (UX-035…UX-037)', () => {
  it('the "unnamed" placeholder is not the failing light gray', async () => {
    renderPage();
    const unnamed = await screen.findAllByText('unnamed');
    for (const el of unnamed) {
      expect(el.className).not.toMatch(/text-gray-400/);
      expect(el.className).toMatch(/text-gray-600|text-gray-700/);
    }
  });
});

describe('stable layout while loading (UX-030)', () => {
  it('the loading state reserves height so the list does not shift in', async () => {
    renderPage();
    const loading = document.querySelector('[data-testid="passkeys-loading"]');
    expect(loading?.className ?? '').toMatch(/min-h-/);
  });
});

describe('the Google card holds its space from first paint (UX-030)', () => {
  // Cycle-24/25 sweeps measured CLS 0.152 then 0.182 on this page at mobile.
  // The card was rendered only AFTER the platform probe and the identity read
  // resolved, so it was inserted into an already-painted page and pushed
  // everything below it down. It now occupies its space immediately and swaps
  // a skeleton for the real content in place.
  it('renders the card (as a skeleton) before either async answer arrives', async () => {
    let resolveMethods: (v: unknown) => void = () => {};
    apiGetMock.mockImplementation(async (path: string) => {
      if (path === '/v1/auth/methods') return new Promise((r) => { resolveMethods = r; });
      if (path === '/v1/auth/passkeys') return { passkeys: [] };
      if (path === '/v1/auth/user?identities=1') return { google_connected: false };
      throw new Error(`unexpected apiGet ${path}`);
    });
    renderPage();
    // Present immediately, holding space, before anything resolved.
    const row = await screen.findByTestId('google-row');
    expect(row).toBeTruthy();
    expect(screen.getByTestId('google-row-skeleton')).toBeTruthy();
    expect(row.className).toMatch(/min-h-\[\d+px\]/);
    resolveMethods({ google: true });
  });

  it('a platform that reports Google OFF removes the card (the fork case)', async () => {
    apiGetMock.mockImplementation(async (path: string) => {
      if (path === '/v1/auth/methods') return { google: false };
      if (path === '/v1/auth/passkeys') return { passkeys: [] };
      throw new Error(`unexpected apiGet ${path}`);
    });
    renderPage();
    await screen.findByRole('heading', { level: 1, name: /sign-in methods/i });
    await waitFor(() => expect(screen.queryByTestId('google-row')).toBeNull());
  });
});
