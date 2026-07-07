-- 008 — creator completion webhooks (spec F-30.3 / AC-138; Phase 44.7).
--
-- One row per envelope holding the creator-supplied callback URL + the
-- delivery-signing secret (whs_…) whose raw value is returned exactly once in
-- the create response. FK ON DELETE CASCADE: the webhook (and its secret)
-- dies with its envelope, consistent with F-9 retention.
--
-- 001_schema.sql carries this table for a FRESH database; this incremental
-- brings an EXISTING database up to the same shape. Idempotent (IF NOT
-- EXISTS). Apply via the operator's private migration runner.

CREATE TABLE IF NOT EXISTS envelope_webhooks (
  envelope_id  UUID PRIMARY KEY REFERENCES envelopes(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  secret       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
