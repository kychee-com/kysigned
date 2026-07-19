/**
 * operator.ts — build-time operator identity config (GH#103, F-14.10 / F-17.7).
 *
 * The PUBLIC repo ships ZERO operator-specifics. Everything an operator would
 * brand — company name, contact, URL, whether a pricing surface shows, and the
 * home marketing content — is read from a single build-time JSON env var
 * (`VITE_OPERATOR_CONFIG`) with GENERIC, forker-replaceable defaults baked in
 * here. A fresh fork built with no env (e.g. `run402 up`, which runs the public
 * `build:run402-cloud` with nothing set) gets the generic defaults: a
 * placeholder hero, no pricing, a generic footer, no hardcoded `kysigned.com`
 * or Kychee brand.
 *
 * kysigned.com (operator #1) restores its identity by having its private deploy
 * tooling pass `VITE_OPERATOR_CONFIG` = its private operator config into the
 * vite build, so the SAME
 * compiled SPA renders kysigned.com's real home + pricing + brand UNCHANGED.
 * Nothing operator-specific lives in this file — only generic defaults + the
 * shape.
 *
 * Read at call time (not memoized) so tests can `vi.stubEnv('VITE_OPERATOR_CONFIG', …)`.
 */

/** Hero block — title/subtitle render as text, body/note may carry inline HTML. */
export interface OperatorHero {
  title: string;
  subtitle: string;
  /** May include inline HTML (e.g. <strong>) — operator-controlled, not user input. */
  bodyHtml: string;
  /** Optional small note under the CTA (kysigned: trial offer; fork: "replace this"). */
  note?: string;
}

/** One row of the "why switch?" comparison table (operator-specific → optional). */
export interface OperatorComparisonRow {
  label: string;
  /** "Traditional" cell — may include inline HTML. */
  aHtml: string;
  /** Highlighted "ours" cell — may include inline HTML. */
  bHtml: string;
}

export interface OperatorComparison {
  heading: string;
  /** [traditional-column-header, ours-column-header]. */
  columns: [string, string];
  rows: OperatorComparisonRow[];
}

export interface OperatorAudienceCard {
  kicker: string;
  tagline: string;
  /** Bullet items — may include inline HTML. */
  itemsHtml: string[];
  ctaLabel: string;
  ctaHref: string;
  ctaStyle: 'primary' | 'secondary';
  /** true → full-navigation <a> (static page); false → SPA <Link>. */
  ctaExternal?: boolean;
  /**
   * 'github' → the CTA renders as an icon-only GitHub-mark link (always a
   * full-navigation <a>, new tab); ctaLabel becomes the accessible name
   * (aria-label/title) instead of visible text.
   */
  ctaIcon?: 'github';
  /**
   * Optional quiet text link under the CTA (e.g. a "how it works" explainer).
   * Rendered (as a full-navigation <a>) only when BOTH label and href are set.
   */
  ctaSubLabel?: string;
  ctaSubHref?: string;
}

export interface OperatorAudiences {
  heading: string;
  cards: OperatorAudienceCard[];
}

/**
 * Home marketing content. `comparison`/`audiences` are operator-specific
 * (they carry pricing + the operator's positioning), so they are omitted for a
 * generic fork and present only when an operator injects them.
 */
export interface OperatorHome {
  hero: OperatorHero;
  comparison?: OperatorComparison | null;
  audiences?: OperatorAudiences | null;
}

export interface OperatorConfig {
  /** Product/brand wordmark in the header. Default: the project name, "kysigned". */
  brandName: string;
  /** Footer © company name. Generic default: "Your Company". */
  companyName: string;
  /** Footer company link. Empty → render the name without a link. */
  companyUrl: string;
  /** Footer "Contact" mailto. Empty → omit the Contact link. */
  contactEmail: string;
  /** Whether the "Pricing" nav item shows. Generic default: false (no pricing). */
  showPricing: boolean;
  /**
   * Whether billing/balance surfaces show (the dashboard credit balance, the
   * "Add credits" top-up, and the `/v1/credits/*` reads that drive them). All
   * billing/balance is `[service]`/private (GH#108): a fresh fork shows NONE of
   * it and never hits the proprietary credit endpoints. Generic default: false.
   */
  showBilling: boolean;
  /**
   * Whether the F-37 paid-acquisition capture runs (store an arriving Google
   * Ads click id first-party and ride it on the magic-link request). Generic
   * default: false — a fresh fork captures nothing anywhere.
   */
  captureGclid: boolean;
  home: OperatorHome;
}

/**
 * Generic, operator-free defaults. This is EXACTLY what a fresh fork renders
 * with no `VITE_OPERATOR_CONFIG`: a placeholder hero with a "replace this"
 * note, no pricing table, no audience cards, a generic footer. (F-14.10 / AC-128)
 */
export const GENERIC_OPERATOR_CONFIG: OperatorConfig = {
  brandName: 'kysigned',
  companyName: 'Your Company',
  companyUrl: '',
  contactEmail: '',
  showPricing: false,
  showBilling: false,
  captureGclid: false,
  home: {
    hero: {
      title: 'E-signatures that live in your inbox',
      subtitle: 'Simple, secure signing, powered by your email.',
      bodyHtml:
        'Sign documents by forwarding an email. The <strong>DKIM</strong> signature your ' +
        'email provider already adds <em>is</em> the signature — no accounts and no apps for signers.',
      note:
        'This is placeholder copy for your own deployment. Replace the home content, brand, ' +
        'and pricing in your operator config (VITE_OPERATOR_CONFIG).',
    },
    comparison: null,
    audiences: null,
  },
};

function readEnvConfig(): string | undefined {
  // Reference the whole `import.meta.env` object and read the key dynamically —
  // NOT a literal `import.meta.env.VITE_OPERATOR_CONFIG` member access, which
  // rolldown-vite statically inlines at transform (freezing it to `undefined`
  // and defeating `vi.stubEnv` in tests). Through a variable the value stays
  // live: the production build still bakes it into the env object, and vitest
  // can stub it. Cast avoids needing a vite-env typing augmentation.
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  return env['VITE_OPERATOR_CONFIG'];
}

/**
 * Resolve the active operator config: the generic defaults, deep-merged with a
 * parsed `VITE_OPERATOR_CONFIG` when present. Unparseable JSON falls back to the
 * generic defaults (a fork never white-pages on a bad config).
 */
export function getOperatorConfig(): OperatorConfig {
  const raw = readEnvConfig();
  if (!raw) return GENERIC_OPERATOR_CONFIG;
  let parsed: Partial<OperatorConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<OperatorConfig>;
  } catch {
    return GENERIC_OPERATOR_CONFIG;
  }
  const g = GENERIC_OPERATOR_CONFIG;
  const home: Partial<OperatorHome> = parsed.home ?? {};
  return {
    brandName: parsed.brandName ?? g.brandName,
    companyName: parsed.companyName ?? g.companyName,
    companyUrl: parsed.companyUrl ?? g.companyUrl,
    contactEmail: parsed.contactEmail ?? g.contactEmail,
    showPricing: parsed.showPricing ?? g.showPricing,
    showBilling: parsed.showBilling ?? g.showBilling,
    captureGclid: parsed.captureGclid ?? g.captureGclid,
    home: {
      hero: { ...g.home.hero, ...(home.hero ?? {}) },
      // Operator-specific sections: present only when the operator supplies them.
      comparison: home.comparison ?? null,
      audiences: home.audiences ?? null,
    },
  };
}
