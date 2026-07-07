-- 002 — drop signing_order (Barry QA 2026-06-17).
--
-- Sequential signing was removed: every envelope is PARALLEL — all signers are
-- notified at once. The active spec never carried a "signing order" feature;
-- these two columns were chain-era cruft that lingered after the evidence-bundle
-- pivot. Removing the user-facing choice, the API/MCP field, and the data.
--
-- Idempotent (DROP COLUMN IF EXISTS). For the live sandbox DB this was applied
-- out-of-band via the run402 admin SQL endpoint (apply-migrations.mjs is avoided
-- here because it would re-attempt 001_schema's gateway-blocked CREATE EXTENSION);
-- the file is kept so fresh deploys + forkers reach the same schema.
ALTER TABLE envelopes        DROP COLUMN IF EXISTS signing_order;
ALTER TABLE envelope_signers DROP COLUMN IF EXISTS signing_order;
