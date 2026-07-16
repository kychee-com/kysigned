-- 011_key_obs_ots_proof.sql — F-6.7.1 / AC-169 (spec 0.46.0).
-- The observed-key record must carry BOTH anchors over the same key-record digest:
-- the RFC 3161 token (existing `key_obs_proof`) AND an OpenTimestamps/Bitcoin proof.
-- Previously the code stamped the TSA only, on the rationale that the key's chain
-- anchor was the public archive's witness.co record. That rationale is void: the
-- archive runs no on-chain/witness timestamping (confirmed by the archive team
-- 2026-07-15, zkemail/archive#46), so the first-party observation needs its own
-- Bitcoin anchor to be independently un-backdatable. NULL = not stamped (an OTS
-- outage degrades to a null proof and never blocks signing).
ALTER TABLE signature_artifacts
  ADD COLUMN IF NOT EXISTS key_obs_ots_proof JSONB;
