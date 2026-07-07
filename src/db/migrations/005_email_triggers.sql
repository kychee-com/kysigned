-- ─────────────────────────────────────────────────────────────────────────────
-- 005_email_triggers — F-29.6: inbound email becomes run402 EMAIL TRIGGERS.
--
-- run402 now creates a durable function run directly on each inbound email event,
-- so the app-owned `inbound_replies` queue / state-machine (which only existed to
-- give the former webhook + reconciler durability + idempotency + retry state) is
-- redundant — run402 owns all of that now. Drop it.
--
-- The one thing the row's `notified` state provided that the run doesn't is
-- exactly-once acceptance-ack idempotency; move it to a per-signer marker.
--
-- MANUAL migration (kysigned rule): apply via scripts/apply-migrations.mjs before
-- the F-29.6 release. Guarded (IF NOT EXISTS / IF EXISTS) so it is safe on a fresh
-- forker schema too.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE envelope_signers
  ADD COLUMN IF NOT EXISTS acceptance_notified_at TIMESTAMPTZ;

DROP INDEX IF EXISTS idx_inbound_replies_status;
DROP INDEX IF EXISTS idx_inbound_replies_envelope;
DROP TABLE IF EXISTS inbound_replies;
