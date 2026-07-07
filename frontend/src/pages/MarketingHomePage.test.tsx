/**
 * MarketingHomePage.test.tsx — homepage copy (AC-31 / AC-36 / AC-128).
 *
 * GH#103 / F-14.10 / F-17.7: the PUBLIC home ships ZERO operator-specifics. The
 * default render (no VITE_OPERATOR_CONFIG) is a generic placeholder hero + a
 * generic "how it works", no pricing, no operator brand. An operator restores
 * its real home by injecting VITE_OPERATOR_CONFIG (as kysigned.com does via its
 * private deploy) — asserted below to prove the mechanism round-trips.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MarketingHomePage } from './MarketingHomePage';

function text() {
  return render(<MemoryRouter><MarketingHomePage /></MemoryRouter>).container.textContent ?? '';
}

// A representative operator config (mirrors kysigned.com's private operator.json)
// so we can prove that injecting it restores the operator-specific home.
const KYSIGNED_CONFIG = JSON.stringify({
  brandName: 'kysigned',
  companyName: 'Kychee, Inc.',
  companyUrl: 'https://kychee.com',
  contactEmail: 'info@kychee.com',
  showPricing: true,
  home: {
    hero: {
      title: 'E-signatures at $0.25 an envelope.',
      subtitle: 'Simple, secure signing, powered by your email.',
      bodyHtml: 'Other tools charge <strong>way too much</strong>. By signing with <strong>DKIM</strong> kysigned is cheaper.',
      note: 'Try 4 envelopes free, no credit card.',
    },
    comparison: {
      heading: 'Why switch?',
      columns: ['Traditional e-sign', 'kysigned'],
      rows: [{ label: 'Price', aHtml: '<strong>Way too much</strong>', bHtml: '$0.25 an envelope' }],
    },
    audiences: {
      heading: 'Two ways to use',
      cards: [
        {
          kicker: 'For signers + small teams',
          tagline: 'Use kysigned.com',
          itemsHtml: ['$0.25 an envelope'],
          ctaLabel: 'Create an envelope →',
          ctaHref: '/dashboard/create',
          ctaStyle: 'primary',
          ctaExternal: false,
        },
      ],
    },
  },
});

describe('MarketingHomePage — generic public default (no operator config, AC-128)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders a generic, operator-free placeholder hero (no pricing, no operator brand)', () => {
    const t = text();
    expect(t).toMatch(/live in your inbox/i); // the generic placeholder hero
    expect(t).toMatch(/powered by your email/i); // plain-language trust value (generic)
    expect(t).toMatch(/replace/i); // the "replace this copy" forker note
    expect(t).toMatch(/Create an envelope/i); // the CTA is always present
  });

  it('ships NO pricing, NO operator brand, NO chain/all-caps residue', () => {
    const t = text();
    expect(t).not.toMatch(/\$0\.25/); // no pricing in the public default
    expect(t).not.toMatch(/way too much/i); // the comparison copy is operator-only
    expect(t).not.toMatch(/Use kysigned\.com/i); // the audience card is operator-only
    expect(t).not.toMatch(/Kychee/); // operator company name is config-injected, not hardcoded
    expect(t).not.toMatch(/\bI SIGN\b/); // intent phrase is sentence-case
    expect(t).not.toMatch(/\$0\.39/); // superseded pricing
    expect(t).toMatch(/Your Company/); // generic footer company (default)
  });

  it('keeps the generic, product-level trust story (forward, signing record, DKIM)', () => {
    const t = text();
    expect(t).toMatch(/signing record/i);
    expect(t).toMatch(/forward/i);
    expect(t).toMatch(/DKIM/);
    expect(t).not.toMatch(/certificate authority/i); // "CA" jargon stays out of the copy
  });
});

describe('MarketingHomePage — operator config injected (kysigned.com restored, AC-128)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders the operator hero, pricing comparison, audiences, and brand from VITE_OPERATOR_CONFIG', () => {
    vi.stubEnv('VITE_OPERATOR_CONFIG', KYSIGNED_CONFIG);
    const t = text();
    expect(t).toMatch(/\$0\.25/); // operator pricing is restored
    expect(t).toMatch(/way too much/i); // the comparison table
    expect(t).toMatch(/Use kysigned\.com/); // the audience card
    expect(t).toMatch(/4 envelopes free/i); // the trial note
    expect(t).toMatch(/Kychee/); // the operator footer brand
  });
});

// ── FC1.2 regression (system-test F-002) ──────────────────────────────────
// The mobile (375px) comparison table overflowed (content 384px). The fix is
// CSS in the inlined <style>: table-layout:fixed + cell wrapping force the
// table to honour width:100% and wrap instead of pushing past the viewport,
// plus a <=640px breakpoint that tightens cell padding. We assert the CSS
// contract (jsdom doesn't lay out, so the deployed-site design-validation
// sweep is the real proof — this locks the rules against regression).
describe('mobile responsive + contrast fixes (F-002)', () => {
  function css() {
    const { container } = render(<MemoryRouter><MarketingHomePage /></MemoryRouter>);
    return container.querySelector('style')?.textContent ?? '';
  }

  it('comparison table is fixed-layout and wraps cell content (kills the 384px overflow)', () => {
    const c = css();
    expect(c).toMatch(/\.compare-table\s*\{[^}]*table-layout:\s*fixed/);
    expect(c).toMatch(/\.compare-table th[^{]*,[^{]*\.compare-table td\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('has a <=640px breakpoint that tightens comparison-table cell padding', () => {
    const c = css();
    expect(c).toMatch(/@media\s*\(max-width:\s*640px\)/);
    // the mobile breakpoint reduces the cell padding from the desktop 14px 20px
    expect(c).toMatch(/\.compare-table th[\s\S]*?\.compare-table td\s*\{\s*padding:\s*12px 10px/);
  });

  it('audience-card heading + footer text meet WCAG contrast (no #888/#999 on white)', () => {
    const c = css();
    // the two failing low-contrast greys were darkened to #5a5a6e (~5.9:1 on #fff)
    expect(c).toMatch(/\.audience-card h3\s*\{[^}]*color:\s*#5a5a6e/);
    expect(c).toMatch(/footer\s*\{[^}]*color:\s*#5a5a6e/);
    expect(c).not.toMatch(/\.audience-card h3\s*\{[^}]*color:\s*#888/);
  });

  it('the legal disclaimer is no longer 11px low-contrast grey', () => {
    const { container } = render(<MemoryRouter><MarketingHomePage /></MemoryRouter>);
    const p = Array.from(container.querySelectorAll('p')).find((el) =>
      /not a substitute for legal advice/i.test(el.textContent ?? ''),
    );
    expect(p).toBeTruthy();
    expect(p!.style.fontSize).toBe('13px'); // was 11px
    expect(p!.style.color).toBe('rgb(90, 90, 110)'); // #5a5a6e, was #999
  });
});
