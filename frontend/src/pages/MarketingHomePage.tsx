/**
 * MarketingHomePage — public landing at `/` on the apex domain.
 *
 * GH#103 / F-14.10 / F-17.7: this component ships ZERO operator-specifics. The
 * hero, the (optional) pricing comparison, the (optional) audience cards, and
 * the footer identity all come from `getOperatorConfig()` — generic,
 * operator-free defaults baked into the config module, overridden at build for
 * a specific operator via `VITE_OPERATOR_CONFIG`. A fresh fork renders a
 * placeholder hero + a generic "how it works" + no pricing; kysigned.com's
 * private deploy injects its config so the SAME compiled SPA renders its real
 * home UNCHANGED. Only genuinely product-level content (the 3-step "how it
 * works", the legal disclaimer) is static here — it's the same for every operator.
 *
 * Ported from the previous static marketing page so that under DD-73 (single-
 * project same-origin hosting, v0.22.1) the SPA owns the apex landing and
 * cookie-based session auth Just Works for subsequent navigation. Styling is
 * inlined (scoped to `.marketing-home-page`) so a fork ports cleanly without
 * touching the global stylesheet.
 */
import { Link } from 'react-router-dom'
import { getOperatorConfig } from '../config/operator'

const MARKETING_CSS = `
.marketing-home-page * { margin: 0; padding: 0; box-sizing: border-box; }
.marketing-home-page { font-family: 'Inter', -apple-system, system-ui, sans-serif; color: #1a1a2e; background: #fff; line-height: 1.6; min-height: 100vh; }
.marketing-home-page .container { max-width: 960px; margin: 0 auto; padding: 0 24px; }
.marketing-home-page a { color: #1a1a2e; }

.marketing-home-page nav { padding: 20px 0; border-bottom: 1px solid #eee; }
.marketing-home-page nav .container { display: flex; justify-content: space-between; align-items: center; }
.marketing-home-page .nav-logo { display: flex; align-items: center; gap: 10px; text-decoration: none; font-weight: 700; font-size: 18px; }
.marketing-home-page .nav-logo img { width: 32px; height: 32px; border-radius: 6px; }
.marketing-home-page .nav-links { display: flex; gap: 24px; font-size: 14px; }
.marketing-home-page .nav-links a { text-decoration: none; color: #666; }
.marketing-home-page .nav-links a:hover { color: #1a1a2e; }

.marketing-home-page .hero { padding: 80px 0 60px; text-align: center; }
.marketing-home-page .hero h1 { font-size: 48px; font-weight: 700; line-height: 1.1; letter-spacing: -1.5px; margin-bottom: 20px; text-wrap: balance; }
.marketing-home-page .hero h1 span { color: #666; font-weight: 400; }
.marketing-home-page .hero p { font-size: 18px; color: #666; max-width: 600px; margin: 0 auto 32px; }
.marketing-home-page .hero-ctas { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
.marketing-home-page .btn-primary { display: inline-block; background: #1a1a2e; color: #fff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; }
.marketing-home-page .btn-primary:hover { background: #2a2a40; }
.marketing-home-page .btn-secondary { display: inline-block; border: 2px solid #1a1a2e; color: #1a1a2e; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; }
.marketing-home-page .btn-secondary:hover { background: #f5f5f5; }
.marketing-home-page .btn-video { display: inline-flex; align-items: center; gap: 9px; padding: 14px 16px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; color: #1a1a2e; }
.marketing-home-page .btn-video:hover { background: #f5f5f5; }
/* Height-only sizing keeps the YouTube mark's official aspect ratio (160:110);
   its width follows from the viewBox, so the trademark is never squashed. */
.marketing-home-page .btn-video svg { display: block; height: 20px; width: auto; flex-shrink: 0; }

.marketing-home-page .comparison { padding: 60px 0; background: #f9f9f9; }
.marketing-home-page .comparison h2 { text-align: center; font-size: 28px; margin-bottom: 32px; }
.marketing-home-page .compare-table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 15px; }
.marketing-home-page .compare-table th, .marketing-home-page .compare-table td { padding: 14px 20px; text-align: left; border-bottom: 1px solid #eee; overflow-wrap: anywhere; word-break: break-word; }
.marketing-home-page .compare-table th { font-weight: 600; background: #f0f0f0; }
.marketing-home-page .compare-table .highlight { font-weight: 700; color: #1a1a2e; }

.marketing-home-page .features { padding: 60px 0; }
.marketing-home-page .features h2 { text-align: center; font-size: 28px; margin-bottom: 40px; }
.marketing-home-page .step-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
.marketing-home-page .step-card { padding: 32px 20px; border: 1px solid #eee; border-radius: 12px; text-align: center; }
.marketing-home-page .step-card h3 { font-size: 17px; margin-bottom: 10px; }
.marketing-home-page .step-card p { font-size: 14px; color: #666; }
.marketing-home-page .step-number { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; background: #1a1a2e; color: #fff; font-weight: 700; font-size: 18px; margin-bottom: 14px; }

.marketing-home-page .audiences { padding: 60px 0; background: #f9f9f9; }
.marketing-home-page .audiences h2 { text-align: center; font-size: 28px; margin-bottom: 32px; }
.marketing-home-page .audience-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; }
.marketing-home-page .audience-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px 28px; display: flex; flex-direction: column; }
.marketing-home-page .audience-card h3 { font-size: 14px; font-weight: 600; color: #5a5a6e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
.marketing-home-page .audience-card .audience-tagline { font-size: 22px; font-weight: 700; margin-bottom: 20px; color: #1a1a2e; }
.marketing-home-page .audience-card ul { list-style: none; margin: 0 0 24px 0; font-size: 14px; color: #444; flex-grow: 1; }
.marketing-home-page .audience-card li { padding: 7px 0; border-bottom: 1px solid #f5f5f5; line-height: 1.5; }
.marketing-home-page .audience-card li:last-child { border-bottom: none; }
.marketing-home-page .audience-card li::before { content: "\\2713"; color: #1a1a2e; font-weight: 700; margin-right: 8px; }
.marketing-home-page .audience-card .audience-cta { text-align: center; }
.marketing-home-page .audience-card .btn-github { display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; color: #1a1a2e; }
.marketing-home-page .audience-card .btn-github:hover { opacity: 0.7; }
.marketing-home-page .audience-card .btn-github svg { width: 40px; height: 40px; display: block; }
.marketing-home-page .audience-card .cta-sub { margin-top: 8px; font-size: 13px; }
.marketing-home-page .audience-card .cta-sub a { color: #5a5a6e; text-decoration: underline; }
.marketing-home-page .audience-card .cta-sub a:hover { color: #1a1a2e; }

@media (max-width: 720px) {
  .marketing-home-page .step-grid { grid-template-columns: 1fr; }
  .marketing-home-page .audience-grid { grid-template-columns: 1fr; }
}

.marketing-home-page footer { padding: 40px 0; border-top: 1px solid #eee; font-size: 13px; color: #5a5a6e; }
.marketing-home-page footer .container { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 16px; }
.marketing-home-page footer a { color: #5a5a6e; text-decoration: none; }
.marketing-home-page footer a:hover { color: #1a1a2e; }

@media (max-width: 640px) {
  .marketing-home-page .hero h1 { font-size: 32px; }
  .marketing-home-page .hero p { font-size: 16px; }
  .marketing-home-page .nav-links { gap: 16px; font-size: 13px; }
  /* FC1.2 (F-002): tighten comparison-table cell padding so the 3 columns +
     wrapped text fit a 375px viewport (was overflowing to 384px). Paired with
     table-layout:fixed + overflow-wrap:anywhere above. */
  .marketing-home-page .comparison { padding: 48px 0; }
  .marketing-home-page .compare-table { font-size: 14px; }
  .marketing-home-page .compare-table th,
  .marketing-home-page .compare-table td { padding: 12px 10px; }
}
`

/**
 * The official YouTube play-button mark, full colour. Geometry and colours are
 * Google's own, taken verbatim from its lockup SVG and cropped to the icon —
 * see kysigned-private/brand/third-party/youtube/PROVENANCE.md, which also
 * records the usage rules (unmodified, only ever links to YouTube).
 * KEEP IN SYNC with YOUTUBE_ICON_SVG in kysigned-private/scripts/build-home-page.ts.
 */
function YouTubeMark() {
  return (
    <svg viewBox="0 0 160 110" aria-hidden="true">
      <path
        fill="#FF0000"
        d="M154.3,17.5c-1.8-6.7-7.1-12-13.8-13.8c-12.1-3.3-60.8-3.3-60.8-3.3S31,0.5,18.9,3.8c-6.7,1.8-12,7.1-13.8,13.8C1.9,29.7,1.9,55,1.9,55s0,25.3,3.3,37.5c1.8,6.7,7.1,12,13.8,13.8c12.1,3.3,60.8,3.3,60.8,3.3s48.7,0,60.8-3.3c6.7-1.8,12-7.1,13.8-13.8c3.3-12.1,3.3-37.5,3.3-37.5S157.6,29.7,154.3,17.5z"
      />
      <polygon fill="#FFFFFF" points="64.2,78.4 104.6,55 64.2,31.6" />
    </svg>
  )
}

export function MarketingHomePage() {
  const cfg = getOperatorConfig()
  const { hero, comparison, audiences } = cfg.home
  const videoLabel = hero.videoLabel ?? 'How it works'
  return (
    <div className="marketing-home-page">
      <style>{MARKETING_CSS}</style>

      {/* v0.22.0 / 2F.AUTH7: the global <AppHeader/> above the Routes
          provides the canonical logo + nav + auth-widget. The page-local
          `<nav>` that used to live here was removed to avoid duplication. */}

      {/* Hero — content from the operator config (generic placeholder for a
          fork; the operator's real hero when VITE_OPERATOR_CONFIG is injected). */}
      <section className="hero">
        <div className="container">
          <h1>
            {hero.title}
            <br />
            <span>{hero.subtitle}</span>
          </h1>
          <p dangerouslySetInnerHTML={{ __html: hero.bodyHtml }} />
          <div className="hero-ctas">
            <Link to="/dashboard/create" data-telemetry="cta_create:hero" className="btn-primary">
              Create an envelope
            </Link>
            {/* Explainer video, beside the primary CTA. Operator-specific (it's
                the operator's own video), so a fork renders nothing here. The
                visible label doesn't say "video", so the accessible name does. */}
            {hero.videoUrl ? (
              <a
                className="btn-video"
                data-telemetry="video:hero"
                href={hero.videoUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`${videoLabel}: watch the explainer on YouTube`}
                // GA4 sees this only as a generic outbound click shared with every
                // other off-site link; the named event makes the explainer separately
                // answerable. Optional-called so consent-denied / ad-blocked visitors
                // never throw on click.
                onClick={() =>
                  (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag?.(
                    'event',
                    'explainer_video_open',
                    { location: 'home_hero' },
                  )
                }
              >
                <YouTubeMark />
                <span>{videoLabel}</span>
              </a>
            ) : null}
          </div>
          {/* Operator note under the CTA — F-39.7 (AC-229): a FIRST-CLASS hero
              line at body-copy size (18px = .hero p), never a footnote. It
              carries the envelope-teaching + trial copy (F-14.8), so its
              prominence IS the requirement. KEEP IN SYNC with
              build-home-page.ts's heroSection note. */}
          {hero.note ? (
            <p style={{ marginTop: 14, fontSize: 18, fontWeight: 600, color: '#666' }}>{hero.note}</p>
          ) : null}
        </div>
      </section>

      {/* Comparison — operator-specific (carries pricing), so it renders only
          when the operator supplies it. A fresh fork omits it entirely. */}
      {comparison ? (
        <section className="comparison">
          <div className="container">
            <h2>{comparison.heading}</h2>
            <table className="compare-table">
              <thead>
                <tr>
                  <th></th>
                  <th>{comparison.columns[0]}</th>
                  <th className="highlight">{comparison.columns[1]}</th>
                </tr>
              </thead>
              <tbody>
                {comparison.rows.map((row, i) => (
                  <tr key={i}>
                    <td>{row.label}</td>
                    <td dangerouslySetInnerHTML={{ __html: row.aHtml }} />
                    <td className="highlight" dangerouslySetInnerHTML={{ __html: row.bHtml }} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="features">
        <div className="container">
          <h2>How it works</h2>
          <div className="step-grid">
            <div className="step-card">
              <div className="step-number">1</div>
              <h3>Send a PDF</h3>
              <p>Upload a PDF, add your signers&rsquo; emails, send.</p>
            </div>
            <div className="step-card">
              <div className="step-number">2</div>
              <h3>Signers forward</h3>
              <p>
                Each signer forwards the email back with &ldquo;I sign this document&rdquo;. Their own email
                provider signs that reply, and that signature is the proof. No account, no app.
              </p>
            </div>
            <div className="step-card">
              <div className="step-number">3</div>
              <h3>You keep the proof</h3>
              <p>Every signed envelope becomes one signing record for you and your signers. Each of you can verify it independently, any time, even offline.</p>
            </div>
          </div>
          <p style={{ textAlign: 'center', marginTop: 28, fontSize: 14, color: '#666' }}>
            <a href="/how-it-works-technical.html" style={{ color: '#1a1a2e', textDecoration: 'underline' }}>
              The technical details &rarr;
            </a>
          </p>
        </div>
      </section>

      {/* Audiences — operator-specific positioning (names the operator, carries
          pricing), so it renders only when the operator supplies it. A fresh
          fork omits it. Each card's CTA is an SPA <Link> (internal) or a
          full-navigation <a> (static page), per ctaExternal. */}
      {audiences ? (
        <section className="audiences">
          <div className="container">
            <h2>{audiences.heading}</h2>
            <div className="audience-grid">
              {audiences.cards.map((card, i) => (
                <div className="audience-card" key={i}>
                  <h3>{card.kicker}</h3>
                  <p className="audience-tagline">{card.tagline}</p>
                  <ul>
                    {card.itemsHtml.map((item, j) => (
                      <li key={j} dangerouslySetInnerHTML={{ __html: item }} />
                    ))}
                  </ul>
                  <div className="audience-cta">
                    {card.ctaIcon === 'github' ? (
                      /* Icon-only GitHub CTA: the mark links straight to the
                         public repo; ctaLabel is the accessible name, not text. */
                      <a
                        href={card.ctaHref}
                        className="btn-github"
                        target="_blank"
                        rel="noreferrer"
                        aria-label={card.ctaLabel}
                        title={card.ctaLabel}
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
                        </svg>
                      </a>
                    ) : card.ctaExternal ? (
                      <a href={card.ctaHref} className={`btn-${card.ctaStyle}`}>
                        {card.ctaLabel}
                      </a>
                    ) : (
                      <Link to={card.ctaHref} className={`btn-${card.ctaStyle}`}>
                        {card.ctaLabel}
                      </Link>
                    )}
                    {/* Quiet explainer link under the CTA (e.g. "How forking works"). */}
                    {card.ctaSubLabel && card.ctaSubHref ? (
                      <div className="cta-sub">
                        <a href={card.ctaSubHref}>{card.ctaSubLabel}</a>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      <div style={{ maxWidth: 960, margin: '0 auto', padding: '0 24px' }}>
        <p
          style={{
            fontSize: 13,
            color: '#5a5a6e',
            textAlign: 'center',
            lineHeight: 1.5,
            padding: '16px 0 0',
          }}
        >
          kysigned is not a substitute for legal advice. It is your responsibility to determine whether electronic
          signatures are legally valid for your use case, jurisdiction, and industry. See our{' '}
          <a href="/terms.html" style={{ color: '#1a1a2e', textDecoration: 'underline' }}>
            Terms of Service
          </a>
          .
        </p>
      </div>

      {/* Footer identity is config-injected (F-17.7): a fresh fork shows a
          generic "© Your Company", no company link, and no Contact; the
          operator's config supplies its real company/URL/contact. "Built on
          run402" and the legal links are the same for every operator. */}
      <footer>
        <div className="container">
          <div>
            &copy; 2026{' '}
            {cfg.companyUrl ? (
              <a href={cfg.companyUrl} target="_blank" rel="noreferrer">
                {cfg.companyName}
              </a>
            ) : (
              <span>{cfg.companyName}</span>
            )}{' '}
            &middot; Built on{' '}
            <a href="https://run402.com" target="_blank" rel="noreferrer">
              run402
            </a>
          </div>
          <div>
            <a href="/terms.html">Terms</a> &middot; <a href="/privacy.html">Privacy</a> &middot;{' '}
            <a href="/cookies.html">Cookies</a> &middot;{' '}
            {/* F-006 / AC-193: re-open the consent panel. openConsentSettings is
                defined by the consent banner injected into the SPA shell at deploy
                (F-008); guarded so it's a harmless no-op in dev/test. */}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                (window as unknown as { openConsentSettings?: () => void }).openConsentSettings?.();
              }}
            >
              Cookie settings
            </a>{' '}
            &middot; <a href="/aup.html">Acceptable Use</a> &middot; <a href="/dpa.html">DPA</a>
            {cfg.contactEmail ? (
              <>
                {' '}
                &middot; <a href={`mailto:${cfg.contactEmail}`}>Contact</a>
              </>
            ) : null}
          </div>
        </div>
      </footer>
    </div>
  )
}
