-- F-30.7 / #154 (spec 0.48.0, DD-37): envelope tracking tokens — the
-- envelope-scoped, read-only observer credential returned with every create
-- 201. Hash-at-rest (sha256 hex), mirroring api_keys custody; the raw ktt_
-- value exists only in create results and the stored idempotent replay body.
-- FK ON DELETE CASCADE: retention sweep + account deletion purge the token
-- with the envelope (AC-175 lifecycle) — no orphan observer credentials.
CREATE TABLE IF NOT EXISTS envelope_tracking_tokens (
  envelope_id  UUID PRIMARY KEY REFERENCES envelopes(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_envelope_tracking_tokens_hash
  ON envelope_tracking_tokens (token_hash);
