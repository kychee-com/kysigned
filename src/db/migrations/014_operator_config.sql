-- F-37 follow-on (spec 0.57.0, DD-48): operator_config — a small DB-backed
-- key→JSONB store for operator runtime config that must NOT ride the Lambda
-- environment. AWS Lambda caps the TOTAL env payload at 4 KB and kysigned's
-- project env sits near that wall; the F-37 Google Ads credentials (~450 bytes)
-- tipped it over (measured 4100 bytes — every env refresh then fails until the
-- set shrinks). Deploy writes rows via the run402 admin SQL surface (source of
-- truth stays AWS SM); functions read them at cold start with their existing
-- DB access. Generic `[both]` mechanism: a fork gets an empty table; values
-- are `[service]` operator data.
CREATE TABLE IF NOT EXISTS operator_config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
