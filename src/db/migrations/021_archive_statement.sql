-- 021_archive_statement.sql — F-32.9/F-32.10 (spec 0.71.0, zkemail/archive#46).
-- The public DKIM archive signs per-record observation statements (live 2026-08-13).
-- At receipt kysigned captures the statement matching the signer's exact observed key,
-- dual-anchors the EXACT bytes (statements are freshly signed per request — never
-- reproducible, so the captured bytes ARE the artifact), and embeds statement + proofs
-- in the evidence bundle. Sealing gates on capture with a bounded wait (F-32.10):
-- `finalizing_since` marks the wait start (set once), `finalizing_email_sent_at`
-- guards the once-only interim creator email (sent only when sealing actually waits),
-- `statement_waived_at` records a bound-expiry seal-without-statements (the operator
-- alert's paper trail; such bundles keep the live-lookup fallback semantics).
ALTER TABLE signature_artifacts
  ADD COLUMN IF NOT EXISTS archive_statement TEXT,
  ADD COLUMN IF NOT EXISTS archive_statement_tsa JSONB,
  ADD COLUMN IF NOT EXISTS archive_statement_ots JSONB,
  ADD COLUMN IF NOT EXISTS archive_statement_captured_at TIMESTAMPTZ;

ALTER TABLE envelopes
  ADD COLUMN IF NOT EXISTS finalizing_since TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalizing_email_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS statement_waived_at TIMESTAMPTZ;
