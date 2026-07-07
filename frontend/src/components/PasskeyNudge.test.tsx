import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PasskeyNudge } from './PasskeyNudge';

describe('PasskeyNudge', () => {
  const orig = (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;

  beforeEach(() => {
    localStorage.clear();
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = function () {};
  });
  afterEach(() => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = orig;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  function mockList(passkeys: unknown[]) {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ passkeys }), { status: 200 })),
    ));
  }

  it('renders nothing when passkeys are unsupported', () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = undefined;
    mockList([]);
    const { container } = render(<PasskeyNudge />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when previously dismissed', () => {
    localStorage.setItem('kysigned_passkey_nudge_dismissed', '1');
    mockList([]);
    const { container } = render(<PasskeyNudge />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the nudge when the signed-in user has no passkeys', async () => {
    mockList([]);
    render(<PasskeyNudge />);
    expect(await screen.findByTestId('passkey-nudge')).toBeInTheDocument();
    expect(screen.getByTestId('passkey-nudge-create')).toBeInTheDocument();
  });

  it('does NOT show when the user already has a passkey', async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ passkeys: [{ id: 'pk1' }] }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchSpy);
    render(<PasskeyNudge />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await waitFor(() => undefined); // flush the resolved fetch→json→setState chain
    expect(screen.queryByTestId('passkey-nudge')).not.toBeInTheDocument();
  });

  it('Dismiss hides it and remembers the choice', async () => {
    mockList([]);
    render(<PasskeyNudge />);
    fireEvent.click(await screen.findByTestId('passkey-nudge-dismiss'));
    expect(screen.queryByTestId('passkey-nudge')).not.toBeInTheDocument();
    expect(localStorage.getItem('kysigned_passkey_nudge_dismissed')).toBe('1');
  });
});
