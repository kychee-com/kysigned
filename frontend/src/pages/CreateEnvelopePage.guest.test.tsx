/**
 * CreateEnvelopePage.guest.test.tsx — F-39.1/.2 (AC-223/AC-224): the editor as
 * a GUEST. The self-sign row is ABSENT (its values belong to a signed-in
 * creator), the free-trial line answers the cost question before any gate, and
 * no billing read fires (a guest has no balance to read).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { apiPostMock, apiGetMock, navigateMock } = vi.hoisted(() => ({ apiPostMock: vi.fn(), apiGetMock: vi.fn(), navigateMock: vi.fn() }));

vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

// A GUEST — no session.
vi.mock('../auth/auth-core', () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    refresh: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock('../lib/api', async (importActual) => {
  const actual = await importActual<typeof import('../lib/api')>();
  return { ...actual, apiPost: apiPostMock, apiGet: apiGetMock };
});

import { CreateEnvelopePage } from './CreateEnvelopePage';

function renderPage() {
  return render(
    <MemoryRouter>
      <CreateEnvelopePage />
    </MemoryRouter>,
  );
}

describe('CreateEnvelopePage — guest mode (F-39.1/.2)', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiGetMock.mockReset();
    // VITE_OPERATOR_CONFIG default in tests has no showBilling; force it ON so
    // the assertion "no balance read for a guest" bites even where billing shows.
    vi.stubEnv('VITE_OPERATOR_CONFIG', JSON.stringify({ showBilling: true }));
  });

  it('renders the full editor with NO self-sign row (AC-224)', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /send for signing/i })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /also sign/i })).toBeNull();
    // The drafting surface is intact: file input, doc name, signer fields.
    expect(screen.getByPlaceholderText('e.g., NDA for Acme Corp')).toBeTruthy();
    expect(screen.getByPlaceholderText('jane.smith@example.com')).toBeTruthy();
  });

  it('shows the free-trial line — the cost question answered before the gate (AC-223)', () => {
    renderPage();
    expect(screen.getByTestId('guest-trial-line').textContent).toMatch(/first 4 .*free/i);
    expect(screen.getByTestId('guest-trial-line').textContent).toMatch(/no credit card/i);
  });

  it('reads NO billing balance for a guest (nothing to read; no 401 noise)', () => {
    renderPage();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  // F-023 (Cycle 19, AC-231) — the visual sweep's blocking findings on the
  // guest-facing editor: sub-44 tap targets (+Add signer, Back link, text
  // inputs), an unlabeled file input, and low-contrast .text-gray-400 hints.
  describe('a11y — the Cycle-19 visual-sweep locks (F-023 / AC-231)', () => {
    it('interactive controls carry the 44px tap-target class', () => {
      renderPage();
      expect(screen.getByRole('button', { name: /add signer/i }).className).toMatch(/min-h-\[44px\]/);
      expect(screen.getByText(/back to home/i).closest('a')!.className).toMatch(/min-h-\[44px\]/);
      expect((screen.getByPlaceholderText('e.g., NDA for Acme Corp') as HTMLInputElement).className).toMatch(/min-h-\[44px\]/);
      expect((screen.getAllByPlaceholderText('e.g., Jane Smith')[0] as HTMLInputElement).className).toMatch(/min-h-\[44px\]/);
      expect((screen.getAllByPlaceholderText('jane.smith@example.com')[0] as HTMLInputElement).className).toMatch(/min-h-\[44px\]/);
    });

    it('the file input has an accessible name (bound label)', () => {
      renderPage();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(input.id).toBeTruthy();
      expect(document.querySelector(`label[for="${input.id}"]`)).toBeTruthy();
    });

    it('no low-contrast .text-gray-400 remains on the editor', () => {
      const { container } = renderPage();
      expect(container.querySelectorAll('.text-gray-400')).toHaveLength(0);
    });
  });
});
