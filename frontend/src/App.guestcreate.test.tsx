/**
 * App.guestcreate.test.tsx — F-39.1 (AC-223): the envelope editor is open to
 * guests. The create route renders WITHOUT a session while every other
 * dashboard route keeps its RequireAuth gate (the carve is exactly one route).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';

describe('App routing — guest access to the envelope editor (F-39.1 / AC-223)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Anonymous visitor: every API probe answers 401 (AuthProvider → user null).
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 })),
    ));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('/dashboard/create renders the editor for a guest — no sign-in screen on the way in', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboard/create']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: /send for signing/i })).toBeTruthy();
    expect(screen.queryByTestId('signin-screen')).toBeNull();
  });

  it('/dashboard (the list) still bounces a guest to the sign-in screen', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('signin-screen')).toBeTruthy();
  });

  it('/dashboard/envelope/:id (detail) still bounces a guest to the sign-in screen', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboard/envelope/abc-123']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('signin-screen')).toBeTruthy();
  });
});
