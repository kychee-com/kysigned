/**
 * CreateEnvelopePage.disclosure.test.tsx — F-44.1 (AC-261): the cover-page
 * disclosure demoted to one calm collapsed line below the Document card.
 * Collapsed by default for guests AND signed-in creators, per-page-load state
 * only (never persisted), every fact reachable inline on expand, and the
 * expand records `cover_details_expanded` through the once-rail with no other
 * value riding it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { apiPostMock, apiGetMock, navigateMock, authHolder, telemetryEventMock, telemetryOnceMock } = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  apiGetMock: vi.fn(),
  navigateMock: vi.fn(),
  authHolder: { current: { user: null as null | { email: string }, loading: false, refresh: vi.fn(), signOut: vi.fn() } },
  telemetryEventMock: vi.fn(),
  telemetryOnceMock: vi.fn(),
}));

vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../auth/auth-core', () => ({
  useAuth: () => authHolder.current,
  broadcastAuthEvent: vi.fn(),
}));

vi.mock('../auth/passkey', () => ({
  passkeysSupported: () => false,
  conditionalMediationAvailable: async () => false,
  startConditionalPasskeyLogin: async () => ({ ok: false }),
  signInWithPasskey: async () => ({ ok: false }),
}));

vi.mock('../lib/api', async (importActual) => {
  const actual = await importActual<typeof import('../lib/api')>();
  return { ...actual, apiPost: apiPostMock, apiGet: apiGetMock };
});

vi.mock('../lib/telemetry', () => ({
  telemetryEvent: telemetryEventMock,
  telemetryEventOnce: telemetryOnceMock,
  telemetryPageView: vi.fn(),
}));

import { CreateEnvelopePage } from './CreateEnvelopePage';

function renderPage() {
  return render(
    <MemoryRouter>
      <CreateEnvelopePage />
    </MemoryRouter>,
  );
}

const COLLAPSED_LINE = /We add a one-page cover with the signer.s legal consent record\./;
const EXPAND_AFFORDANCE = /what.s on it/i;
/** Facts that must be hidden until expand and all present after it. */
const EXPANDED_FACTS = [
  /cover page \(page 1\)/i,
  /shown to signers as .Sender./i,
  /ESIGN, UETA/,
  /eIDAS/,
  /verify the document hash/i,
  /keep your original PDF/i,
];

const expandedCalls = () => telemetryOnceMock.mock.calls.filter(([e]) => e === 'cover_details_expanded');

describe('CreateEnvelopePage — cover-page disclosure demoted (F-44.1 / AC-261)', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiPostMock.mockResolvedValue({ ok: true });
    apiGetMock.mockReset();
    apiGetMock.mockRejectedValue(new Error('not stubbed'));
    navigateMock.mockReset();
    telemetryEventMock.mockReset();
    telemetryOnceMock.mockReset();
    authHolder.current = { user: null, loading: false, refresh: vi.fn(), signOut: vi.fn() };
  });

  it('renders collapsed by default for a guest: the calm line, no expanded facts', () => {
    renderPage();
    expect(screen.getByText(COLLAPSED_LINE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: EXPAND_AFFORDANCE })).toBeInTheDocument();
    for (const fact of EXPANDED_FACTS) {
      expect(screen.queryByText(fact)).toBeNull();
    }
  });

  it('renders collapsed by default for a signed-in creator too', () => {
    authHolder.current = { user: { email: 'creator@example.com' }, loading: false, refresh: vi.fn(), signOut: vi.fn() };
    renderPage();
    expect(screen.getByText(COLLAPSED_LINE)).toBeInTheDocument();
    for (const fact of EXPANDED_FACTS) {
      expect(screen.queryByText(fact)).toBeNull();
    }
  });

  it('the line sits BELOW the Document card, not above it', () => {
    renderPage();
    const documentCardHeading = screen.getByRole('heading', { name: 'Document' });
    const line = screen.getByText(COLLAPSED_LINE);
    // DOCUMENT_POSITION_FOLLOWING: the line comes after the card heading in DOM order.
    expect(documentCardHeading.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('expanding reveals every disclosure fact inline, with no navigation', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: EXPAND_AFFORDANCE }));
    for (const fact of EXPANDED_FACTS) {
      expect(screen.getByText(fact)).toBeInTheDocument();
    }
    const howItWorks = screen.getByRole('link', { name: /how this works/i });
    expect(howItWorks).toHaveAttribute('href', '/how-it-works');
    expect(howItWorks).toHaveAttribute('target', '_blank');
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('the disclosure never says "envelope" — document vocabulary only (AC-234)', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: EXPAND_AFFORDANCE }));
    const region = screen.getByTestId('cover-disclosure');
    expect(region.textContent).not.toMatch(/envelope/i);
  });

  it('expanding fires cover_details_expanded through the once-rail only', () => {
    renderPage();
    expect(expandedCalls()).toHaveLength(0);
    const toggle = screen.getByRole('button', { name: EXPAND_AFFORDANCE });
    fireEvent.click(toggle);
    expect(expandedCalls().length).toBeGreaterThan(0);
    // Dedupe belongs to the RAIL (eventOnce): the plain event channel must
    // never carry it, exactly like draft_started (DD-52).
    expect(telemetryEventMock.mock.calls.filter(([e]) => e === 'cover_details_expanded')).toHaveLength(0);
    // No element / detail value rides the fact.
    for (const call of expandedCalls()) {
      expect(call[1]).toBeUndefined();
    }
  });

  it('collapse and re-expand keeps routing through the once-rail (no plain-channel leak)', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: EXPAND_AFFORDANCE }));
    // Collapsed again: the affordance re-renders (aria-expanded false path).
    fireEvent.click(screen.getByTestId('cover-disclosure-toggle'));
    fireEvent.click(screen.getByTestId('cover-disclosure-toggle'));
    expect(screen.getByText(EXPANDED_FACTS[0]!)).toBeInTheDocument();
    expect(telemetryEventMock.mock.calls.filter(([e]) => e === 'cover_details_expanded')).toHaveLength(0);
  });

  it('a fresh mount renders collapsed again — the state is per page load, never persisted', () => {
    const first = renderPage();
    fireEvent.click(screen.getByRole('button', { name: EXPAND_AFFORDANCE }));
    expect(screen.getByText(EXPANDED_FACTS[0]!)).toBeInTheDocument();
    first.unmount();
    renderPage();
    for (const fact of EXPANDED_FACTS) {
      expect(screen.queryByText(fact)).toBeNull();
    }
  });
});
