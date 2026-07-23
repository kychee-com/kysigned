-- F-38 (spec 0.59.0, DD-50): pre-signin funnel telemetry — consent-independent,
-- identifier-free by construction. One append-only table whose columns are
-- EXACTLY the F-38.1 record shape: occurrence time, event name, page, element,
-- country, traffic-source bucket, per-page-load sequence id. Deliberately NO
-- other columns — no account/visitor id, no ip, no user agent, no referrer, no
-- click-id value, and no cross-page join key (page_seq lives only within one
-- page load). Rows prune after 90 days (F-38.7) via the existing
-- retention_sweep schedule. `[both]`: a fork gets the table; the rail that
-- writes it is config-gated default OFF, so a fresh fork stores nothing.
CREATE TABLE IF NOT EXISTS telemetry_events (
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  event       TEXT NOT NULL,
  page        TEXT NOT NULL,
  element     TEXT,
  country     TEXT NOT NULL DEFAULT 'unknown',
  source      TEXT NOT NULL DEFAULT 'unknown',
  page_seq    INTEGER NOT NULL DEFAULT 0
);

-- Prune + windowed summary reads both key on time.
CREATE INDEX IF NOT EXISTS telemetry_events_occurred_at_idx
  ON telemetry_events (occurred_at);

-- The operator funnel view groups by event within a window.
CREATE INDEX IF NOT EXISTS telemetry_events_event_occurred_at_idx
  ON telemetry_events (event, occurred_at);
