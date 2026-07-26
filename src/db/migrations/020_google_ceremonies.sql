-- F-41 (spec 0.66.0, DD-59): the Google sign-in ceremony row — one per started
-- "Continue with Google", holding everything that must NOT ride the URL hash:
--
--   pkce_verifier   RFC 7636 S256 secret; run402's start gets the derived
--                   challenge, its token exchange gets this back. Server-only.
--   draft_handle    the pending-send handle (<id>.<secret>) a send-gate
--                   ceremony carries, so the exchange can claim the held draft
--                   without the handle ever appearing in a URL.
--   gclid           the F-37 attribution submission captured in the STARTING
--                   browser (the ceremony returns to the same tab, but the
--                   rider still never rides the wire twice).
--   link_email      set on a Connect-Google ceremony: the initiating session's
--                   address; the exchange refuses to treat a link as a sign-in.
--   gate_trigger    the F-38.3 trigger value, so the funnel's chose-Google step
--                   and the session-created method agree about WHICH gate.
--   consumed_at     exactly-once: set by ONE conditional UPDATE; a replayed
--                   callback, an expired ceremony and an unknown id all read
--                   the same (nothing).
--
-- TTL matches run402's own OAuth transaction window (10 minutes); the reaper
-- deletes consumed-or-expired rows on the existing retention sweep.
CREATE TABLE IF NOT EXISTS google_signin_ceremonies (
  id            TEXT PRIMARY KEY,
  pkce_verifier TEXT NOT NULL,
  draft_handle  TEXT,
  gclid         JSONB,
  link_email    TEXT,
  gate_trigger  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS google_ceremonies_expires_idx ON google_signin_ceremonies (expires_at);
