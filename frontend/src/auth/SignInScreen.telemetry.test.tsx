/**
 * SignInScreen.telemetry.test.tsx — F-38.3 (AC-216): the sign-in gate trio.
 *
 * Three ordered steps: the prompt becoming visible (naming HOW the visitor got
 * there — direct, or redirected from a signed-out create attempt), the FIRST
 * interaction with the email field (the focus fact only — never a value, never
 * a keystroke, once per page load), and the magic-link submit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

function flushBeacon(): void {
  window.dispatchEvent(new Event('pagehide'));
}

describe('SignInScreen — telemetry trio', () => {
  let beacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    beacon = vi.fn(() => true);
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

  function records(): Array<{ event: string; element?: string }> {
    return beacon.mock.calls
      .map(([, blob]) => JSON.parse((blob as { __text: string }).__text))
      .flatMap((b: { records: Array<{ event: string; element?: string }> }) => b.records);
  }

  async function renderSignIn(trigger?: 'direct' | 'redirect') {
    vi.stubEnv('VITE_OPERATOR_CONFIG', JSON.stringify({ telemetry: true }));
    const { SignInScreen } = await import('./SignInScreen');
    const { AuthProvider } = await import('./AuthContext');
    const { telemetryPageView } = await import('../lib/telemetry');
    telemetryPageView('signin'); // the App route effect does this in prod
    render(
      <MemoryRouter>
        <AuthProvider>
          <SignInScreen {...(trigger ? { telemetryTrigger: trigger } : {})} />
        </AuthProvider>
      </MemoryRouter>,
    );
  }

  it('prompt-shown records once with the DIRECT trigger by default', async () => {
    await renderSignIn();
    flushBeacon();
    const prompts = records().filter((r) => r.event === 'signin_prompt');
    expect(prompts).toEqual([{ event: 'signin_prompt', element: 'direct', seq: expect.any(Number) }]);
  });

  it('prompt-shown carries the REDIRECT trigger when rendered from a bounced create attempt', async () => {
    await renderSignIn('redirect');
    flushBeacon();
    const prompts = records().filter((r) => r.event === 'signin_prompt');
    expect(prompts[0].element).toBe('redirect');
  });

  it('email-field focus records EXACTLY once, and nothing typed ever reaches a batch', async () => {
    await renderSignIn();
    const input = screen.getByTestId('signin-email');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'secret-visitor@example.com' } });
    fireEvent.blur(input);
    fireEvent.focus(input); // second focus — must NOT double-record
    flushBeacon();
    const focuses = records().filter((r) => r.event === 'signin_email_focus');
    expect(focuses).toHaveLength(1);
    const wire = beacon.mock.calls.map(([, b]) => (b as { __text: string }).__text).join('');
    expect(wire).not.toContain('secret-visitor');
  });

  it('the magic-link submit records the request step', async () => {
    await renderSignIn();
    const input = screen.getByTestId('signin-email');
    fireEvent.change(input, { target: { value: 'visitor@example.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    flushBeacon();
    expect(records().some((r) => r.event === 'signin_submit')).toBe(true);
    const wire = beacon.mock.calls.map(([, b]) => (b as { __text: string }).__text).join('');
    expect(wire).not.toContain('visitor@example.com');
  });

  it('fresh-fork default: the whole trio is silent', async () => {
    const { SignInScreen } = await import('./SignInScreen');
    const { AuthProvider } = await import('./AuthContext');
    render(
      <MemoryRouter>
        <AuthProvider>
          <SignInScreen />
        </AuthProvider>
      </MemoryRouter>,
    );
    const input = screen.getByTestId('signin-email');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'x@example.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    flushBeacon();
    expect(beacon).not.toHaveBeenCalled();
  });
});
