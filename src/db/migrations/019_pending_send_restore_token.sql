-- F-028 (red-team cycle 22, P0): a pending send's `id` was treated as though it
-- were a capability, so anyone holding one could read the creator's address and
-- the entire signer list with no authentication at all.
--
-- An id is not a secret. It rides `?draft=` in the URL bar, survives in browser
-- history, and is echoed back in claim requests and logs. The handle the visitor
-- holds becomes `<id>.<secret>`, and only `sha256(secret)` is stored here — the
-- same posture run402 uses for its own magic-link tokens, which persist a hash
-- and never the raw value.
--
-- Every pre-existing row is DELETED rather than migrated: those rows have no
-- secret, so under the new rule they would be permanently unreadable anyway, and
-- deleting them is what actually clears the disclosed data. They are all probe
-- and test drafts from the same day this shipped.
DELETE FROM pending_sends;

ALTER TABLE pending_sends ADD COLUMN IF NOT EXISTS restore_token_hash TEXT;
