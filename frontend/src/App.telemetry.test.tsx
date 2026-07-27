/**
 * App.telemetry.test.tsx — F-38 (AC-214/AC-215): the SPA emits one telemetry
 * page view per route (a soft-nav is a NEW sequence), the sign-in landing
 * reports page `signin`, and a fresh fork (no operator config) sends nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

async function freshApp() {
  vi.resetModules();
  const { App } = await import('./App');
  return App;
}

function flushBeacon(): void {
  window.dispatchEvent(new Event('pagehide'));
}

function beaconBodies(spy: ReturnType<typeof vi.fn>): Array<{ page: string; records: Array<{ event: string }> }> {
  return spy.mock.calls.map(([, blob]) => JSON.parse((blob as { __text: string }).__text));
}

/**
 * The payload for ONE page, whichever position it flushed in. `freshApp()`
 * re-imports the rail per test (vi.resetModules), and a PREVIOUS instance's
 * `pagehide` listener is still registered — so an earlier test's payload can
 * land at index 0 of this test's spy. Asserting on position tested flush
 * ORDER, not the behaviour, and made the file order-dependent; assert on the
 * page we actually asked for instead.
 */
function bodyForPage(spy: ReturnType<typeof vi.fn>, page: string) {
  const all = beaconBodies(spy);
  const matches = all.filter((b) => b.page === page);
  expect(matches.length, 'beacon pages seen: ' + JSON.stringify(all.map((b) => b.page))).toBe(1);
  return matches[0]!;
}

describe('App mount — telemetry rail wiring', () => {
  let beacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    beacon = vi.fn(() => true);
    // jsdom has no sendBeacon/Blob-text combo; capture the payload synchronously.
    vi.stubGlobal(
      'Blob',
      class {
        __text: string;
        constructor(parts: string[]) {
          this.__text = parts.join('');
        }
      },
    );
    Object.defineProperty(window.navigator, 'sendBeacon', { value: beacon, configurable: true, writable: true });
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 })),
    ));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('with the operator flag on, a route landing records a page_view for that page', async () => {
    vi.stubEnv('VITE_OPERATOR_CONFIG', JSON.stringify({ telemetry: true }));
    const App = await freshApp();
    render(
      <MemoryRouter initialEntries={['/verify']}>
        <App />
      </MemoryRouter>,
    );
    flushBeacon();
    expect(bodyForPage(beacon, '/verify').records[0]).toMatchObject({ event: 'page_view' });
  });

  it('the sign-in landing (/?intent=signin) reports page `signin`, not home', async () => {
    vi.stubEnv('VITE_OPERATOR_CONFIG', JSON.stringify({ telemetry: true }));
    const App = await freshApp();
    render(
      <MemoryRouter initialEntries={['/?intent=signin']}>
        <App />
      </MemoryRouter>,
    );
    flushBeacon();
    expect(bodyForPage(beacon, 'signin').records[0]).toMatchObject({ event: 'page_view' });
  });

  it('fresh-fork default: the same landing sends NOTHING and writes no storage', async () => {
    const App = await freshApp();
    render(
      <MemoryRouter initialEntries={['/verify']}>
        <App />
      </MemoryRouter>,
    );
    flushBeacon();
    expect(beacon).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
