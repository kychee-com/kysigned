/**
 * App.capture.test.tsx — F-37 (AC-205): the SPA runs the attribution capture
 * on mount, so a gclid arriving on ANY SPA URL is stored — and a fresh fork
 * (no operator config) stores nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';
import { ATTRIBUTION_STORAGE_KEY } from './lib/attribution';

describe('App mount — attribution capture wiring', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 })),
    ));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('captures a gclid landing on an SPA route when the operator enables attribution', () => {
    vi.stubEnv('VITE_OPERATOR_CONFIG', JSON.stringify({ captureGclid: true }));
    render(
      <MemoryRouter initialEntries={['/verify?gclid=Cj0KappWired']}>
        <App />
      </MemoryRouter>,
    );
    const raw = window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).gclid).toBe('Cj0KappWired');
  });

  it('fresh-fork default: the same landing stores NOTHING', () => {
    render(
      <MemoryRouter initialEntries={['/verify?gclid=Cj0KappWired']}>
        <App />
      </MemoryRouter>,
    );
    expect(window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY)).toBeNull();
  });
});
