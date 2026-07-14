-- 010_archive_confirmation.sql — F-32.6/F-32.7 (spec 0.44.0, #147/#148/#149).
-- Receipt-time verifier-parity confirmation state + reconciliation-sweep bookkeeping
-- on signature_artifacts. `archive_confirmation` records whether, at receipt (or at a
-- later sweep re-check), the public DKIM archive held the EXACT observed key bytes
-- with a usable last-seen — the same predicate the verifier's provenance gate applies.
-- NULL = not applicable (legacy rows, or the archive step didn't run).
ALTER TABLE signature_artifacts
  ADD COLUMN IF NOT EXISTS archive_confirmation TEXT
    CHECK (archive_confirmation IS NULL OR archive_confirmation IN ('confirmed', 'unconfirmed', 'outage')),
  ADD COLUMN IF NOT EXISTS archive_confirmation_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archive_confirmation_healed_at TIMESTAMPTZ;

-- The daily sweep (F-32.7) reads a narrow created_at window of non-clean rows.
CREATE INDEX IF NOT EXISTS idx_sig_artifacts_archive_confirmation_sweep
  ON signature_artifacts (created_at)
  WHERE archive_confirmation IS DISTINCT FROM 'confirmed';
