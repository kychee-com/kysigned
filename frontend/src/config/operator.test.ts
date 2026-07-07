/**
 * operator.test.ts — build-time operator config (GH#103 / F-14.10 / F-17.7).
 *
 * Proves the generic operator-free defaults, the deep-merge over a partial
 * VITE_OPERATOR_CONFIG, and the safe fallback on malformed JSON.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getOperatorConfig, GENERIC_OPERATOR_CONFIG } from './operator';

describe('getOperatorConfig — generic defaults (no VITE_OPERATOR_CONFIG)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns operator-free defaults: generic brand/company, no pricing, no marketing sections', () => {
    const cfg = getOperatorConfig();
    expect(cfg.brandName).toBe('kysigned');
    expect(cfg.companyName).toBe('Your Company');
    expect(cfg.companyUrl).toBe('');
    expect(cfg.contactEmail).toBe('');
    expect(cfg.showPricing).toBe(false);
    expect(cfg.showBilling).toBe(false);
    expect(cfg.home.comparison).toBeNull();
    expect(cfg.home.audiences).toBeNull();
    expect(cfg.home.hero.title).toMatch(/inbox/i);
    // No operator specifics leak into the defaults.
    expect(JSON.stringify(cfg)).not.toMatch(/kysigned\.com|Kychee|\$0\.25/);
  });
});

describe('getOperatorConfig — injected VITE_OPERATOR_CONFIG', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('deep-merges a partial config over the defaults (identity + showPricing + hero)', () => {
    vi.stubEnv(
      'VITE_OPERATOR_CONFIG',
      JSON.stringify({
        companyName: 'Acme, Inc.',
        companyUrl: 'https://acme.example',
        showPricing: true,
        home: { hero: { title: 'Sign with Acme' } },
      }),
    );
    const cfg = getOperatorConfig();
    expect(cfg.companyName).toBe('Acme, Inc.');
    expect(cfg.companyUrl).toBe('https://acme.example');
    expect(cfg.showPricing).toBe(true);
    // Hero is merged, not replaced: the overridden title + the default subtitle.
    expect(cfg.home.hero.title).toBe('Sign with Acme');
    expect(cfg.home.hero.subtitle).toBe(GENERIC_OPERATOR_CONFIG.home.hero.subtitle);
    // brandName not supplied → still the generic default.
    expect(cfg.brandName).toBe('kysigned');
  });

  it('carries operator marketing sections when supplied', () => {
    vi.stubEnv(
      'VITE_OPERATOR_CONFIG',
      JSON.stringify({
        home: {
          comparison: { heading: 'Why switch?', columns: ['Them', 'Us'], rows: [] },
          audiences: { heading: 'Two ways', cards: [] },
        },
      }),
    );
    const cfg = getOperatorConfig();
    expect(cfg.home.comparison?.heading).toBe('Why switch?');
    expect(cfg.home.audiences?.heading).toBe('Two ways');
  });

  it('falls back to the generic defaults on malformed JSON (a fork never white-pages)', () => {
    vi.stubEnv('VITE_OPERATOR_CONFIG', '{ not valid json ');
    const cfg = getOperatorConfig();
    expect(cfg).toEqual(GENERIC_OPERATOR_CONFIG);
  });
});
