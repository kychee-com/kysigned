-- F-40 (spec 0.65.0, DD-56): the pending send — a guest draft that outlives the
-- tab that composed it, so the tab a visitor LANDS in from the sign-in email can
-- finish the send.
--
-- This is the only record kysigned writes before a session exists. It is NOT an
-- envelope: nothing is delivered, no credit moves, and it is invisible on the
-- dashboard until claimed. What keeps it bounded:
--
--   bound_email          only a session for this address may claim the draft.
--   claimed_at           set by ONE conditional UPDATE, so two tabs racing
--                        produce one envelope and one credit movement.
--   claimed_envelope_id  what the claim produced; also the guard that stops a
--                        failed-create release from freeing a sent draft.
--   expires_at           7 days — DELIBERATELY longer than run402's 15-minute
--                        sign-in link. The most common failure IS the link
--                        expiring, and a draft that died with it would leave
--                        nothing to restore (F-40.3).
--
-- The document itself is NOT here: it goes to the existing content-addressed
-- `pdf_blobs` under a `pending/` key, and `storage_key` is the only reference.
-- No read path returns those bytes to an unauthenticated caller (AC-243).
CREATE TABLE IF NOT EXISTS pending_sends (
  id                  TEXT PRIMARY KEY,
  bound_email         TEXT NOT NULL,
  document_name       TEXT NOT NULL,
  storage_key         TEXT NOT NULL,
  byte_count          BIGINT NOT NULL,
  draft               JSONB NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  claimed_at          TIMESTAMPTZ,
  claimed_envelope_id TEXT
);

-- The sweep's predicate (claimed or expired) and the per-address rate check.
CREATE INDEX IF NOT EXISTS pending_sends_expires_idx ON pending_sends (expires_at);
CREATE INDEX IF NOT EXISTS pending_sends_bound_email_idx ON pending_sends (bound_email, created_at DESC);
