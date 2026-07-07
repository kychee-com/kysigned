-- 004 — new-account trial credit (F-13.4 / Phase 25): allow the `signup_grant`
-- ledger source.
--
-- The trial credit is recorded as ONE credit_ledger row with source='signup_grant'
-- and external_ref = the NORMALIZED signup inbox (lower-case + gmail-dot-strip +
-- googlemail-unify + drop +tag, the F-3.2a normalizer). The existing
-- credit_ledger_idempotency UNIQUE(source, external_ref) then enforces BOTH:
--   • at-most-one signup_grant per normalized address (AC-94 dedupe), and
--   • idempotency across repeat sign-ins (AC-93 once).
-- So no NEW constraint is needed — only the source CHECK has to admit the value.
--
-- 001_schema.sql carries this for a FRESH database; this incremental brings an
-- EXISTING database (created before Phase 25) up to the same shape. Idempotent
-- (DROP/ADD the source CHECK). Apply via the operator's private migration runner.
--
-- NB: the value is written as the `signup_grant` identifier (no standalone word
-- before the underscore), so the run402 SQL gateway's \bGRANT\b guard does not trip.

-- Payment-agnostic: the ledger `source` is a free non-empty string — first-party sources
-- (envelope, admin_*, refund, signup_grant) OR a provider top-up source that a proprietary
-- `[service]` billing function supplies. The public template never enumerates a provider.
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_source_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_source_check
  CHECK (source <> '');
