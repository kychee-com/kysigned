-- 006 — creator API keys (spec F-30.1 / AC-131, AC-132; Phase 44.2).
--
-- One row per minted bearer key. The DB stores ONLY sha256(raw) — the raw
-- `ksk_…` value appears exactly once, in the mint response, and cannot be
-- recovered. `revoked_at` is a tombstone: the auth lookup filters
-- `revoked_at IS NULL`, so revocation takes effect on the key's next use.
--
-- 001_schema.sql carries this table for a FRESH database; this incremental
-- brings an EXISTING database (created before Phase 44) up to the same shape.
-- Idempotent (IF NOT EXISTS). Apply via the operator's private migration runner.

CREATE TABLE IF NOT EXISTS api_keys (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_email  TEXT NOT NULL,
  key_hash       TEXT NOT NULL UNIQUE,
  label          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ
);

-- The auth-gate lookup is by hash (UNIQUE above); the dashboard list is by owner.
CREATE INDEX IF NOT EXISTS api_keys_creator_email_idx ON api_keys (creator_email);
