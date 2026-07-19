-- F-37 (spec 0.57.0, DD-47): paid-acquisition attribution — the gclid rail.
--
-- `attribution_captures` holds PENDING captures ridden in on magic-link
-- requests (normalized email → click id + the consent banner's recorded
-- choice at submit). At account establishment (the first magic-link-confirmed
-- sign-in) the EARLIEST unexpired capture binds into `creator_attribution`
-- and the email's pending rows are deleted.
--
-- `creator_attribution` is the once-only establishment stamp: exactly one row
-- per account, written at establishment and NEVER overwritten. gclid NULL =
-- the account established organic (no unexpired capture at that moment) and
-- stays organic forever — a later ad click never rewrites acquisition truth.
-- consent_state is only ever a RECORDED banner choice, never fabricated
-- (F-37.5).
CREATE TABLE IF NOT EXISTS attribution_captures (
  normalized_email TEXT NOT NULL,
  gclid            TEXT NOT NULL,
  captured_at      TIMESTAMPTZ NOT NULL,
  consent_state    TEXT CHECK (consent_state IN ('granted', 'denied')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (normalized_email, gclid)
);

CREATE TABLE IF NOT EXISTS creator_attribution (
  normalized_email TEXT PRIMARY KEY,
  gclid            TEXT,
  captured_at      TIMESTAMPTZ,
  consent_state    TEXT CHECK (consent_state IN ('granted', 'denied')),
  established_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
