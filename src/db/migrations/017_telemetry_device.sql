-- F-38.9 device-class dimension (spec 0.62.0, plan 69.2): the record shape gains
-- a coarse device class — mobile | desktop | tablet | unknown — classified
-- server-side at ingestion from the request User-Agent. The class only; the raw
-- UA is never stored (same identifier-free rule as country). Historical rows
-- keep the DEFAULT 'unknown'. Additive (migration 015 is lock-pinned append-only).
ALTER TABLE telemetry_events
  ADD COLUMN IF NOT EXISTS device TEXT NOT NULL DEFAULT 'unknown';
