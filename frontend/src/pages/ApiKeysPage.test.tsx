/**
 * ApiKeysPage.test.tsx — creator API keys UI (spec F-30.1 / AC-132).
 *
 * Mint shows the raw key EXACTLY ONCE (dismiss removes it from the DOM and it
 * never reappears); list is metadata-only; revoke confirms then DELETEs.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiKeysPage } from './ApiKeysPage';

const sampleList = {
  keys: [
    {
      id: 'k-1',
      label: 'mcp agent',
      created_at: '2026-07-01T10:00:00Z',
      last_used_at: '2026-07-06T08:00:00Z',
      revoked_at: null,
    },
    {
      id: 'k-2',
      label: null,
      created_at: '2026-07-02T10:00:00Z',
      last_used_at: null,
      revoked_at: '2026-07-05T00:00:00Z',
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ApiKeysPage (F-30.1 / AC-132)', () => {
  it('lists key metadata, marking revoked keys and never rendering a secret', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(sampleList), { status: 200 })),
    ));

    render(
      <MemoryRouter>
        <ApiKeysPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('apikeys-row-k-1')).toBeInTheDocument();
      expect(screen.getByTestId('apikeys-row-k-2')).toBeInTheDocument();
    });
    expect(screen.getByText('mcp agent')).toBeInTheDocument();
    // The revoked key is labelled and offers no revoke action.
    expect(screen.getByTestId('apikeys-revoked-k-2')).toBeInTheDocument();
    expect(screen.queryByTestId('apikeys-revoke-k-2')).not.toBeInTheDocument();
  });

  it('mint POSTs the label and shows the raw key exactly once — dismiss removes it for good', async () => {
    const RAW = 'ksk_' + 'a'.repeat(64);
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/v1/api-keys') && init?.method === 'POST') {
        return Promise.resolve(new Response(
          JSON.stringify({ id: 'k-new', key: RAW, label: 'ci bot', created_at: new Date().toISOString() }),
          { status: 201 },
        ));
      }
      // Every (re)load of the list.
      return Promise.resolve(new Response(JSON.stringify(sampleList), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <MemoryRouter>
        <ApiKeysPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('apikeys-row-k-1')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('apikeys-label'), { target: { value: 'ci bot' } });
    fireEvent.click(screen.getByTestId('apikeys-create'));

    // The one-time panel shows the raw key + a copy affordance.
    await waitFor(() => expect(screen.getByTestId('apikeys-minted-key')).toBeInTheDocument());
    expect(screen.getByTestId('apikeys-minted-key').textContent).toContain(RAW);
    expect(screen.getByTestId('apikeys-copy')).toBeInTheDocument();

    // The POST carried the label + the CSRF header.
    const post = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(post).toBeTruthy();
    const postInit = post![1] as RequestInit;
    expect(JSON.parse(String(postInit.body))).toEqual({ label: 'ci bot' });
    expect((postInit.headers as Record<string, string>)['X-Kysigned-Csrf']).toBeTruthy();

    // Dismiss → the raw key is GONE from the DOM (shown exactly once).
    fireEvent.click(screen.getByTestId('apikeys-dismiss'));
    expect(screen.queryByTestId('apikeys-minted-key')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(RAW);
  });

  it('revoke asks for confirmation, DELETEs, and reloads the list', async () => {
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/v1/api-keys/k-1') && init?.method === 'DELETE') {
        return Promise.resolve(new Response(JSON.stringify({ id: 'k-1', revoked: true }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(sampleList), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <MemoryRouter>
        <ApiKeysPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('apikeys-row-k-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('apikeys-revoke-k-1'));
    fireEvent.click(screen.getByTestId('apikeys-confirm-k-1'));

    await waitFor(() => {
      const del = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE');
      expect(del).toBeTruthy();
      expect(String(del![0])).toContain('/v1/api-keys/k-1');
    });
  });

  it('tap targets meet the 44px convention and secondary text avoids text-gray-400', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(sampleList), { status: 200 })),
    ));
    const { container } = render(
      <MemoryRouter>
        <ApiKeysPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('apikeys-row-k-1')).toBeInTheDocument());
    expect(screen.getByTestId('apikeys-create').className).toContain('min-h-[44px]');
    expect(container.querySelectorAll('.text-gray-400').length).toBe(0);
  });
});
