/**
 * SigningPage.test.tsx — evidence-bundle signer instructions (F-5 / F-6.3).
 *
 * The review page must tell the signer to FORWARD the email they received and type
 * "I sign this document" — NOT the dropped Mode-2 mailto / "reply I SIGN" / compose-
 * a-new-email path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));
vi.mock('../lib/api', () => ({ apiGet: apiGetMock }));

// pdf.js is dynamic-imported by the review page to rasterize the document preview to a
// <canvas> (UX-013: the platform CSP `frame-ancestors 'none'` blanks any framed blob:).
// Mock it so the canvas path is exercised deterministically without a real PDF engine.
// It is only reached when the PDF fetch succeeds; the fetch-rejects tests never touch it.
const { getDocumentMock, renderMock } = vi.hoisted(() => {
  const renderMock = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const getDocumentMock = vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: vi.fn(() =>
        Promise.resolve({
          getViewport: ({ scale = 1 }: { scale?: number }) => ({ width: 600 * scale, height: 800 * scale }),
          render: renderMock,
        }),
      ),
      destroy: vi.fn(),
    }),
  }));
  return { getDocumentMock, renderMock };
});
vi.mock('pdfjs-dist', () => ({
  getDocument: getDocumentMock,
  GlobalWorkerOptions: { workerSrc: '' },
  version: 'test',
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'test-worker-url' }));

import { SigningPage } from './SigningPage';

const INFO = {
  envelope_id: 'env-1', document_name: 'Mutual NDA', document_hash: 'a'.repeat(64),
  signer_name: 'Alice', signer_email: 'alice@example.com', status: 'active',
  already_signed: false, completed_at: null, pdf_deleted_at: null,
};

function renderAt() {
  return render(
    <MemoryRouter initialEntries={['/review/env-1/tok-1']}>
      <Routes>
        <Route path="/review/:envelopeId/:token" element={<SigningPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockResolvedValue(INFO);
  // Default: no real network for the PDF-preview fetch (overridden in the blob test).
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network'))));
  // jsdom implements neither; define so the component + spies can use them.
  (URL as unknown as { createObjectURL?: unknown }).createObjectURL = vi.fn(() => 'blob:default');
  (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SigningPage — forward-to-sign instructions', () => {
  it('instructs the signer to forward the email and type the intent line', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText(/forwarding the email we sent you/i)).toBeInTheDocument());
    // The signing mailbox (jsdom hostname is "localhost") + the verbatim intent line.
    expect(screen.getByText('forward-to-sign@localhost')).toBeInTheDocument();
    expect(screen.getByText('I sign this document')).toBeInTheDocument();
  });

  it('shows no document hash for the signer to verify (F-5.4 / AC-12 — byte-checking is the machines job)', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText(/forwarding the email/i)).toBeInTheDocument());
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('a'.repeat(64)); // the document_hash value must not be shown
    expect(text).not.toMatch(/document hash/i);
    expect(text).not.toMatch(/SHA-256/i);
  });

  it('shows NONE of the dropped Mode-2 reply path (no mailto / "I SIGN" / compose-new)', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText(/forwarding the email/i)).toBeInTheDocument());
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/opens a new email/i);
    expect(text).not.toMatch(/Send it manually/i);
    expect(text).not.toMatch(/I SIGN\b/); // case-sensitive: the all-caps Mode-2 phrase
    // No mailto anchors on the page.
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  // GH#25 — the native inline viewer is unusable on phones (iOS traps on page 1;
  // Android won't render inline). Mobile gets a full-screen open CTA instead; the
  // desktop preview surface is a md-only <canvas> host (NOT an iframe — UX-013).
  it('gives mobile a full-screen open CTA and a desktop-only canvas host, with no iframe (GH#25 / UX-013)', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText(/forwarding the email/i)).toBeInTheDocument());
    const host = document.querySelector('[data-testid="pdf-canvas-preview"]') as HTMLElement;
    expect(host).not.toBeNull();
    // The host lives inside the md-only wrapper (hidden on mobile, shown at md+).
    expect(host.parentElement?.className).toMatch(/hidden/);
    expect(host.parentElement?.className).toMatch(/md:block/);
    const cta = document.querySelector('[data-testid="mobile-open-doc"]') as HTMLAnchorElement;
    expect(cta).not.toBeNull();
    expect(cta.className).toMatch(/md:hidden/);
    expect(cta.getAttribute('href')).toContain('/pdf');
    // The refused-blob iframe is gone entirely — no framed PDF anywhere on the page.
    expect(document.querySelector('iframe')).toBeNull();
  });

  // Task 40.5 / AC-12: the loading→loaded transition was a CLS source on /review (the
  // design sweep measured 0.249/0.302). The fix renders every state inside ONE stable
  // outer shell so the root box never morphs when content swaps in; the loading spinner
  // is top-aligned in that same shell rather than a full-screen centred spinner.
  it('reserves one stable page shell across loading + loaded (no CLS morph on /review)', () => {
    apiGetMock.mockReset();
    apiGetMock.mockReturnValue(new Promise(() => {})); // never resolves → stays in loading
    renderAt();
    const shell = screen.getByTestId('review-loading');
    expect(shell.className).toContain('min-h-screen');
    expect(shell.className).toContain('max-w-3xl');
    // NOT the old full-screen centred spinner whose box morphed into the loaded layout.
    expect(shell.className).not.toMatch(/justify-center/);
  });

  // The "Powered by kysigned" footer was text-gray-400 (~2.8:1) — below the 4.5:1 gate.
  it('raises the review footer contrast to gray-500 (≥4.5:1), off the flagged gray-400', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText(/forwarding the email/i)).toBeInTheDocument());
    const footer = screen.getByText('Powered by kysigned');
    expect(footer.className).toContain('text-gray-500');
    expect(footer.className).not.toContain('text-gray-400');
  });

  // UX-013: the run402 gateway injects CSP `frame-ancestors 'none'` (+ `X-Frame-Options:
  // DENY`) on every project-site response, and a `blob:` inherits the page CSP — so a
  // framed blob PDF is refused and renders blank. The fix rasterizes the already-fetched
  // bytes to a <canvas> via pdf.js (no nested browsing context → frame-ancestors N/A).
  it('renders the pending-state preview to a pdf.js <canvas>, not a framed blob (UX-013)', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(pdfBytes, { status: 200, headers: { 'Content-Type': 'application/pdf' } })),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderAt();

    // The desktop preview surface is a <canvas> populated by pdf.js — not an iframe.
    // (Assert the host exists FIRST, so the optional-chain can't vacuously pass before
    // the review state and render chain have run.)
    await waitFor(() => {
      const host = document.querySelector('[data-testid="pdf-canvas-preview"]');
      expect(host).not.toBeNull();
      expect(host!.querySelector('canvas')).not.toBeNull();
    });
    // The bytes were FETCHED from the token URL and handed to pdf.js's getDocument.
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/envelope/env-1/tok-1/pdf');
    expect(getDocumentMock).toHaveBeenCalled();
    expect(renderMock).toHaveBeenCalled();
    // No framed PDF remains anywhere (the refused-blob <iframe src=blob:> is gone).
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.querySelector('[src^="blob:"]')).toBeNull();
  });

  // UX-014: on mobile the two PDF links and the shared CopyChip "copy" button were
  // sub-44px tap targets. They must present a ≥44px effective target at mobile widths
  // (md:min-* reverts the desktop size so the inline chip isn't visually bloated).
  it('gives the PDF links and the copy buttons a ≥44px mobile tap target (UX-014)', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText(/forwarding the email/i)).toBeInTheDocument());
    const openLink = screen.getByRole('link', { name: /open full screen/i });
    const downloadLink = screen.getByRole('link', { name: /download pdf/i });
    expect(openLink.className).toMatch(/min-h-\[44px\]/);
    expect(downloadLink.className).toMatch(/min-h-\[44px\]/);
    // Both CopyChips (forward address + intent phrase) share the one component.
    const copyButtons = screen.getAllByRole('button', { name: /^copy$/i });
    expect(copyButtons.length).toBeGreaterThanOrEqual(2);
    for (const b of copyButtons) {
      expect(b.className).toMatch(/min-h-\[44px\]/);
      expect(b.className).toMatch(/min-w-\[44px\]/);
    }
  });
});
