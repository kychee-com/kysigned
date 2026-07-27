/**
 * PasskeysPage.google.test.tsx — F-41.4 (AC-247/AC-248): the page becomes
 * "Sign-in methods" and gains the Google row — Connect (server-initiated link
 * ceremony) / Connected-as (from the identities opt-in) — feature-detected
 * like every Google surface.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('the link ceremony reports its outcome ON THIS PAGE (AC-248)', () => {
  // Barry, walk 5: the platform correctly refused connecting a Google identity
  // already linked to his other account — and he was shown NOTHING, so he
  // reasonably concluded it might have worked. "refused in plain words" is the
  // clause that failed, and it failed because the round trip returned to a page
  // that never reads the result. It now returns HERE, so here is where both
  // outcomes are told.
  it('#error=identity_already_linked says so in plain words, naming no code or vendor error', async () => {
    renderPage('#error=identity_already_linked&state=gc_00000000-0000-4000-8000-000000000001');
    const note = await screen.findByTestId('google-ceremony-error');
    expect(note.textContent).toMatch(/already connected to a different sign-in/i);
    expect(note.textContent).not.toMatch(/identity_already_linked|run402|\b[45]\d\d\b/);
    // Consumed once — a refresh must not replay it.
    expect(window.location.hash).toBe('');
  });

  it('#code confirms the connection after exchanging, and refreshes the row', async () => {
    apiPostMock.mockResolvedValue({ ok: true, linked: true, email: 'owner@x.com' });
    let identityCalls = 0;
    apiGetMock.mockImplementation(async (path: string) => {
      if (path === '/v1/auth/methods') return { google: true };
      if (path === '/v1/auth/user?identities=1') {
        identityCalls += 1;
        // Connected only AFTER the exchange lands.
        return identityCalls > 1
          ? { email: 'owner@x.com', google_connected: true, google_email: 'owner@gmail.com' }
          : { email: 'owner@x.com', google_connected: false };
      }
      if (path === '/v1/auth/passkeys') return { passkeys: [] };
      throw new Error(`unexpected apiGet ${path}`);
    });
    renderPage('#code=abc&state=gc_00000000-0000-4000-8000-000000000001');
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith('/v1/auth/google/exchange', {
        code: 'abc',
        ceremony: 'gc_00000000-0000-4000-8000-000000000001',
      }),
    );
    expect((await screen.findByTestId('google-linked-note')).textContent).toMatch(/google is connected/i);
    await waitFor(() => expect(screen.getByTestId('google-row').textContent).toMatch(/connected as owner@gmail\.com/i));
  });

  it('a foreign or absent hash changes nothing', async () => {
    renderPage('#code=abc&state=not-ours');
    await screen.findByTestId('google-connect');
    expect(apiPostMock).not.toHaveBeenCalledWith('/v1/auth/google/exchange', expect.anything());
    expect(screen.queryByTestId('google-ceremony-error')).toBeNull();
  });
});

afterEach(() => {
  // Leave the URL as we found it. These tests drive real location state
  // (ceremony hashes), and a leftover path routed a LATER test file to the
  // wrong page and timed it out. Cleaning up keeps the suite order-independent.
  window.history.replaceState({}, '', '/');
  sessionStorage.clear();
});

describe('Disconnect Google (F-41.8 / AC-254)', () => {
  function connected() {
    apiGetMock.mockImplementation(async (path: string) => {
      if (path === '/v1/auth/methods') return { google: true };
      if (path === '/v1/auth/user?identities=1')
        return { email: 'owner@x.com', google_connected: true, google_email: 'owner@gmail.com' };
      if (path === '/v1/auth/passkeys') return { passkeys: [] };
      throw new Error(`unexpected apiGet ${path}`);
    });
  }

  it('offers Disconnect when connected, and will NOT act on a single click', async () => {
    connected();
    renderPage();
    const btn = await screen.findByTestId('google-disconnect');
    fireEvent.click(btn);
    // A confirmation stands between the click and the removal.
    expect(await screen.findByTestId('google-disconnect-confirm')).toBeTruthy();
    expect(apiPostMock).not.toHaveBeenCalledWith('/v1/auth/google/disconnect', expect.anything());
  });

  it('confirming disconnects and returns the row to Connect', async () => {
    // The fake behaves like the real server: once the disconnect POST lands,
    // the identity read stops reporting a connection. Swapping the mock after
    // the fact raced the component's own re-read, which is a test artefact, not
    // a product behaviour.
    let stillConnected = true;
    apiGetMock.mockImplementation(async (path: string) => {
      if (path === '/v1/auth/methods') return { google: true };
      if (path === '/v1/auth/user?identities=1')
        return stillConnected
          ? { email: 'owner@x.com', google_connected: true, google_email: 'owner@gmail.com' }
          : { email: 'owner@x.com', google_connected: false };
      if (path === '/v1/auth/passkeys') return { passkeys: [] };
      throw new Error(`unexpected apiGet ${path}`);
    });
    apiPostMock.mockImplementation(async (path: string) => {
      if (path === '/v1/auth/google/disconnect') {
        stillConnected = false;
        return { ok: true, disconnected: true };
      }
      throw new Error(`unexpected apiPost ${path}`);
    });
    renderPage();
    fireEvent.click(await screen.findByTestId('google-disconnect'));
    fireEvent.click(await screen.findByTestId('google-disconnect-confirm'));
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith('/v1/auth/google/disconnect', {}));
    await waitFor(() => expect(screen.getByTestId('google-connect')).toBeTruthy());
    expect(screen.queryByTestId('google-disconnect')).toBeNull();
  });

  it('a stale sign-in asks for a fresh one in plain words, naming no code or vendor', async () => {
    connected();
    const err = Object.assign(new Error('reauth'), { status: 401, code: 'auth_reauth_required' });
    apiPostMock.mockRejectedValue(err);
    renderPage();
    fireEvent.click(await screen.findByTestId('google-disconnect'));
    fireEvent.click(await screen.findByTestId('google-disconnect-confirm'));
    const note = await screen.findByTestId('google-reauth-note');
    expect(note.textContent).toMatch(/sign in again/i);
    expect(note.textContent).not.toMatch(/401|R402_|run402|token/i);
    // And it offers that sign-in directly rather than leaving them to find it.
    expect(screen.getByTestId('google-reauth-signin')).toBeTruthy();
  });
});
