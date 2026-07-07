-- 007 — create-endpoint idempotency keys (spec F-30.3 / AC-136; Phase 44.5).
--
-- One row per (creator, Idempotency-Key): the request-payload hash plus the
-- stored 201 response for replay. A NULL response_status marks an in-flight
-- reservation; non-201 outcomes DELETE their reservation (failures are never
-- cached). Rows are small and bounded by real agent traffic; a retention
-- sweep can prune old rows later without semantic impact (a pruned key simply
-- allows a fresh create).
--
-- 001_schema.sql carries this table for a FRESH database; this incremental
-- brings an EXISTING database up to the same shape. Idempotent (IF NOT
-- EXISTS). Apply via the operator's private migration runner.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  creator_email    TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  response_status  INTEGER,
  response_body    JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (creator_email, idempotency_key)
);
