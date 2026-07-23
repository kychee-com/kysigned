-- F-38 campaign cohort dimension (spec 0.60.0, plan 67.13): the record shape
-- gains the operator's OWN campaign label — the arriving link's utm_campaign,
-- normalized to a bounded lowercase token ('other' on malformed, 'none' on
-- absent). A cohort name shared by every visitor the campaign brings, never a
-- per-visitor value; still no identifier of any kind in the table. Additive
-- (migration 015 is lock-pinned append-only).
ALTER TABLE telemetry_events
  ADD COLUMN IF NOT EXISTS campaign TEXT NOT NULL DEFAULT 'none';
