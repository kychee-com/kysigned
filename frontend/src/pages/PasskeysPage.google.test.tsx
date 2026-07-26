/**
 * PasskeysPage.google.test.tsx — F-41.4 (AC-247/AC-248): the page becomes
 * "Sign-in methods" and gains the Google row — Connect (server-initiated link
 * ceremony) / Connected-as (from the identities opt-in) — feature-detected
 * like every Google surface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { apiGetMock, apiPostMock, apiDeleteMock, hardNavigateMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiDeleteMock: vi.fn(),
  hardNavigateMock: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => {
  const actual = await importActual<typeof import('../lib/api')>();
  return { ...actual, apiGet: apiGetMock, apiPost: apiPostMock, apiDelete: apiDeleteMock };
});

vi.mock('../lib/hardNavigate', () => ({ hardNavigate: hardNavigateMock }));

vi.mock('../auth/passkey', () => ({
  passkeysSupported: () => false,
  registerPasskey: async () => ({ ok: false }),
}));

import { PasskeysPage } from './PasskeysPage';
import { resetAuthMethodsCache } from '../auth/google';

function renderPage(search = '') {
  window.history.replaceState({}, '', `/account/passkeys${search}`);
  return render(
    <MemoryRouter>
      <PasskeysPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiDeleteMock.mockReset();
  hardNavigateMock.mockReset();
  resetAuthMethodsCache();
  apiGetMock.mockImplementation(async (path: string) => {
    if (path === '/v1/auth/methods') return { google: true };
    if (path === '/v1/auth/user?identities=1') return { email: 'owner@x.com', google_connected: false };
    if (path === '/v1/auth/passkeys') return { passkeys: [] };
    throw new Error(`unexpected apiGet ${path}`);
  });
});

describe('the page presents itself as Sign-in methods (F-41.4)', () => {
  it('heading reads Sign-in methods; the passkeys section remains', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: /sign-in methods/i })).toBeTruthy();
    expect(screen.getByText(/passkeys let you sign in/i)).toBeTruthy();
  });
});

describe('the Google row', () => {
  it('offers Connect when not connected: starts the server link ceremony and navigates', async () => {
    apiPostMock.mockResolvedValue({ authorization_url: 'https://accounts.google.com/link' });
    renderPage();
    const btn = await screen.findByTestId('google-connect');
    fireEvent.click(btn);
    await waitFor(() => expect(hardNavigateMock).toHaveBeenCalledWith('https://accounts.google.com/link'));
    expect(apiPostMock).toHaveBeenCalledWith('/v1/auth/google/link', {});
  });

  it('shows Connected as <google email> when linked, with no Connect action', async () => {
    apiGetMock.mockImplementation(async (path: string) => {
      if (path === '/v1/auth/methods') return { google: true };
      if (path === '/v1/auth/user?identities=1')
        return { email: 'owner@x.com', google_connected: true, google_email: 'owner@gmail.com' };
      if (path === '/v1/auth/passkeys') return { passkeys: [] };
      throw new Error(`unexpected apiGet ${path}`);
    });
    renderPage();
    const row = await screen.findByTestId('google-row');
    expect(row.textContent).toMatch(/connected as owner@gmail\.com/i);
    expect(screen.queryByTestId('google-connect')).toBeNull();
  });

  it('is absent entirely when the platform reports google off', async () => {
    apiGetMock.mockImplementation(async (path: string) => {
      if (path === '/v1/auth/methods') return { google: false };
      if (path === '/v1/auth/passkeys') return { passkeys: [] };
      throw new Error(`unexpected apiGet ${path}`);
    });
    renderPage();
    await screen.findByRole('heading', { level: 1, name: /sign-in methods/i });
    expect(screen.queryByTestId('google-row')).toBeNull();
  });

  it('celebrates a just-completed link (?linked=1) in plain words', async () => {
    apiGetMock.mockImplementation(async (path: string) => {
      if (path === '/v1/auth/methods') return { google: true };
      if (path === '/v1/auth/user?identities=1')
        return { email: 'owner@x.com', google_connected: true, google_email: 'owner@gmail.com' };
      if (path === '/v1/auth/passkeys') return { passkeys: [] };
      throw new Error(`unexpected apiGet ${path}`);
    });
    renderPage('?linked=1');
    expect((await screen.findByTestId('google-linked-note')).textContent).toMatch(/google is connected/i);
  });

  it('a failed link start shows friendly copy, not a code', async () => {
    apiPostMock.mockRejectedValue(new Error('503'));
    renderPage();
    fireEvent.click(await screen.findByTestId('google-connect'));
    await waitFor(() => expect(screen.getByTestId('passkeys-page').textContent).toMatch(/email sign-in link/i));
    expect(hardNavigateMock).not.toHaveBeenCalled();
  });
});
