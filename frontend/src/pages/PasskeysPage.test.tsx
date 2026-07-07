/**
 * PasskeysPage.test.tsx — list + delete UI (2F.AUTH9).
 *
 * Verifies the page renders the passkey list, surfaces delete confirmation,
 * and posts the DELETE to /v1/auth/passkeys/:id.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PasskeysPage } from './PasskeysPage';

const sampleList = {
  passkeys: [
    {
      id: 'pk-1',
      label: 'MacBook Touch ID',
      rp_id: 'kysigned.com',
      created_at: '2026-05-20T10:00:00Z',
      last_used_at: '2026-05-28T08:00:00Z',
    },
    {
      id: 'pk-2',
      label: null,
      rp_id: 'kysigned.com',
      created_at: '2026-05-22T10:00:00Z',
      last_used_at: null,
    },
  ],
};

describe('PasskeysPage', () => {
  beforeEach(() => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = function () {};
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists the passkeys returned by the API', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(sampleList), { status: 200 })),
    ));

    render(
      <MemoryRouter>
        <PasskeysPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('passkeys-row-pk-1')).toBeInTheDocument();
      expect(screen.getByTestId('passkeys-row-pk-2')).toBeInTheDocument();
    });
    expect(screen.getByText('MacBook Touch ID')).toBeInTheDocument();
  });

  it('clicking Delete shows confirm, then DELETEs on confirm', async () => {
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/v1/auth/passkeys') && (!init || init.method !== 'DELETE')) {
        return Promise.resolve(new Response(JSON.stringify(sampleList), { status: 200 }));
      }
      if (String(url).endsWith('/v1/auth/passkeys/pk-1') && init?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <MemoryRouter>
        <PasskeysPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('passkeys-row-pk-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('passkeys-delete-pk-1'));
    expect(screen.getByTestId('passkeys-confirm-pk-1')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('passkeys-confirm-pk-1'));

    await waitFor(() => {
      const deleteCall = fetchSpy.mock.calls.find(
        ([url, init]) => String(url).endsWith('/v1/auth/passkeys/pk-1') && init?.method === 'DELETE',
      );
      expect(deleteCall).toBeDefined();
    });
  });

  it('shows the empty-state message when no passkeys are registered', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ passkeys: [] }), { status: 200 })),
    ));

    render(
      <MemoryRouter>
        <PasskeysPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/no passkeys yet/i)).toBeInTheDocument();
    });
  });

  it('shows the browser-unsupported banner when PublicKeyCredential is undefined', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = undefined;
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ passkeys: [] }), { status: 200 })),
    ));

    render(
      <MemoryRouter>
        <PasskeysPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/doesn't support passkeys/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('passkeys-add')).not.toBeInTheDocument();
  });
});
