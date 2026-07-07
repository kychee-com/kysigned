-- 003 — Family B (per-signer cover + hash) + recipient editing / manual seal.
--
-- The evidence-bundle Family-B re-spec (Phases 21-23) added:
--   • per-signer canonical PDFs — each signer signs P_i = cover_i ++ D with its
--     own sent_pdf_hash (the per-signer return-what-we-sent target, F-6.4 / DD-9);
--   • recipient editing until seal — the `superseded` signer state (a signed
--     signer edited/re-requested, prior signature dropped, F-23.2);
--   • auto-close vs manual seal (F-24) — the `auto_close` flag + the
--     `awaiting_seal` envelope state (parked all-signed, waiting for "Seal & send").
--
-- 001_schema.sql carries all of this for a FRESH database; this incremental brings
-- an EXISTING database (created from the pre-Family-B 001) up to the same shape.
-- Fully idempotent (ADD COLUMN IF NOT EXISTS + DROP/ADD the status CHECKs).
--
-- Apply via the operator's private migration runner.

-- envelope_signers: the per-signer return-what-we-sent target (F-6.4 / DD-9).
ALTER TABLE envelope_signers ADD COLUMN IF NOT EXISTS sent_pdf_hash TEXT;

-- envelopes: auto-close (default) vs manual seal (F-24). Existing rows → true.
ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS auto_close BOOLEAN NOT NULL DEFAULT true;

-- envelopes.status: add 'awaiting_seal' (F-24 manual-seal parked state). Existing
-- values (active/completed/expired/voided) all satisfy the new CHECK.
ALTER TABLE envelopes DROP CONSTRAINT IF EXISTS envelopes_status_check;
ALTER TABLE envelopes ADD CONSTRAINT envelopes_status_check
  CHECK (status IN ('active', 'awaiting_seal', 'completed', 'expired', 'voided'));

-- envelope_signers.status: add 'superseded' (F-23.2). Existing values
-- (pending/signed/declined) all satisfy the new CHECK.
ALTER TABLE envelope_signers DROP CONSTRAINT IF EXISTS envelope_signers_status_check;
ALTER TABLE envelope_signers ADD CONSTRAINT envelope_signers_status_check
  CHECK (status IN ('pending', 'signed', 'superseded', 'declined'));
