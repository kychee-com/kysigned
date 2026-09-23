-- 022_signer_rejections.sql — F-45 (spec 0.72.0, #166; DD-70).
-- A signer whose forward was rejected is made visible to the creator: the dashboard's
-- needs-attention state (F-45.5) and the API's `last_rejection` field (F-45.6) read
-- `last_rejection_class` / `last_rejection_at`, the LATEST rejection of a signer who has
-- not signed yet (pending or superseded; cleared on sign and on edit). The creator is
-- emailed at most once per signer, per envelope, per kind of problem (F-45.3):
-- `rejection_notice_classes` records the classes already told, and only the run that
-- appends a class sends that notice, so a retried run never double-sends. An address
-- change is delete + add, so the new row starts empty.
ALTER TABLE envelope_signers
  ADD COLUMN IF NOT EXISTS last_rejection_class TEXT,
  ADD COLUMN IF NOT EXISTS last_rejection_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_notice_classes TEXT[] NOT NULL DEFAULT '{}';
