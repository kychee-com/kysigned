-- 009 — F-30.2 / F-13.5: align the credit_ledger source CHECK with the
-- payment-agnostic 001 schema. Databases created before the reshape carry an
-- enumerated CHECK (source IN ('stripe','envelope','admin_credit',
-- 'admin_debit','refund','signup_grant')) that names a provider and rejects
-- the x402 rail's source='x402' rows (46.8 live: a SETTLED mainnet payment
-- answered 500 internal_x402_credit against it). The ledger's source column
-- is payment-agnostic by design: any non-empty tag, uniqueness rides
-- UNIQUE (source, external_ref).
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_source_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_source_check CHECK (source <> '');
