-- kysigned canonical schema (evidence-bundle model).
--
-- This single file is the authoritative schema for a kysigned deployment. It
-- replaces the former 20 incremental migrations (001_envelopes … 020_signature_
-- artifacts): the complete "DB redo" that removed every dead chain / Mode-2
-- column the pre-pivot stack left behind. Every table here carries ONLY the
-- columns the evidence-bundle service actually uses.
--
-- The deploy-side apply mechanism globs `migrations/*.sql` in sorted order and
-- runs each (every statement is idempotent via IF NOT EXISTS), so a single
-- 001_schema.sql applies cleanly on a fresh database. Migrations are MANUAL —
-- apply via scripts/apply-migrations.mjs.
--
-- Compatible with any PostgreSQL 15+.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────────────────────────────────────
-- envelopes — one row per signing envelope. Creator identity is ALWAYS the
-- creator's email (sender_email); there is no wallet/Mode-2 sender path.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS envelopes (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_email              TEXT NOT NULL,         -- the envelope creator (Sender)
  document_name             TEXT NOT NULL,
  document_hash             TEXT NOT NULL,         -- SHA-256 hex of canonical PDF (cover + content, F22.9)
  -- SHA-256 of the creator's pre-assembly source bytes (v0.19.x+). Distinct from
  -- document_hash; drives dashboard grouping (F16.5/F16.7) + F16.10 same-document
  -- detection. NULL for legacy rows → queries COALESCE to document_hash.
  source_hash               TEXT,
  -- Lifecycle (F-24): active(=open) → awaiting_seal (all-signed, manual-seal mode,
  -- not yet sealed) → completed(=sealed+distributed); plus expired / voided.
  status                    TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'awaiting_seal', 'completed', 'expired', 'voided')),
  -- F-24 — auto-close (default) vs manual seal. false ⇒ an all-signed envelope
  -- waits in 'awaiting_seal' for the creator's "Seal & send" action.
  auto_close                BOOLEAN NOT NULL DEFAULT true,
  consent_language_version  TEXT NOT NULL DEFAULT '1.0',  -- F3.3 signing-intent string version ("1.0" = I SIGN)
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at              TIMESTAMPTZ,
  pdf_storage_key           TEXT,                  -- object-storage key for the canonical PDF
  expiry_at                 TIMESTAMPTZ,
  pdf_deleted_at            TIMESTAMPTZ,           -- F8.6 ephemeral retention: when the PDF blob was dropped
  -- 2F.CD.3/CD.4 (F7.5) — stamped after the all-party completion distribution
  -- finished (creator emailed last); the exactly-once gate for completion.
  completion_distributed_at TIMESTAMPTZ,
  -- F-3.7 — internal-test envelope (no credit, excluded from metrics).
  internal_test             BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_envelopes_sender_email
  ON envelopes (sender_email) WHERE sender_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_envelopes_status ON envelopes (status);
CREATE INDEX IF NOT EXISTS idx_envelopes_document_hash ON envelopes (document_hash);
CREATE INDEX IF NOT EXISTS idx_envelopes_source_hash ON envelopes (source_hash);
CREATE INDEX IF NOT EXISTS idx_envelopes_expiry ON envelopes (expiry_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_envelopes_retention_sweep
  ON envelopes (status, completed_at)
  WHERE pdf_storage_key IS NOT NULL AND pdf_deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_envelopes_internal_test
  ON envelopes (internal_test) WHERE internal_test = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- envelope_signers — one row per invited signer. reply-to-sign (email DKIM) is
-- the only signing method.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS envelope_signers (
  id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id                       UUID NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  email                             TEXT NOT NULL,
  name                              TEXT NOT NULL,
  -- F-22.2 — organisation the signer declared signing on behalf of (NULL = individual).
  on_behalf_of                      TEXT,
  -- Family B (F-3.3 / DD-9) — SHA-256 hex of THIS signer's canonical PDF
  -- P_i = cover_i ++ D; the per-signer return-what-we-sent target (F-6.4). P_i
  -- itself is NOT stored — it is regenerated deterministically from the signer
  -- fields + the shared document D. NULL only for legacy/pre-Family-B rows.
  sent_pdf_hash                     TEXT,
  verification_level                INTEGER NOT NULL DEFAULT 2
                                      CHECK (verification_level IN (1, 2, 5)),
  signing_method                    TEXT CHECK (signing_method IN ('email')),
  -- F-23.2 — a signer edited/re-requested after they signed returns to 'superseded'
  -- (their prior signature dropped) until they re-sign the regenerated P_i.
  status                            TEXT NOT NULL DEFAULT 'pending'
                                      CHECK (status IN ('pending', 'signed', 'superseded', 'declined')),
  signing_token                     TEXT NOT NULL UNIQUE,
  token_expires_at                  TIMESTAMPTZ NOT NULL,
  signed_at                         TIMESTAMPTZ,
  reminder_count                    INTEGER NOT NULL DEFAULT 0,
  last_reminder_at                  TIMESTAMPTZ,
  completion_email_delivered_at     TIMESTAMPTZ,
  completion_email_bounced_at       TIMESTAMPTZ,
  completion_email_provider_msg_id  TEXT,
  -- F-9.8/AC-50 — set when the signing-request email hard-bounced.
  undeliverable_at                  TIMESTAMPTZ,
  -- F-7.3 / F-29.6 — exactly-once acceptance-ack marker (the email-trigger inbound
  -- run sends the ack iff this is NULL, then stamps it), replacing the former
  -- inbound_replies 'notified' state.
  acceptance_notified_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_signers_envelope ON envelope_signers (envelope_id);
CREATE INDEX IF NOT EXISTS idx_signers_token ON envelope_signers (signing_token);
CREATE INDEX IF NOT EXISTS idx_signers_status ON envelope_signers (envelope_id, status);
CREATE INDEX IF NOT EXISTS idx_envelope_signers_completion_email_provider_msg_id
  ON envelope_signers (completion_email_provider_msg_id)
  WHERE completion_email_provider_msg_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security (creator-by-email + signer-by-token). Service role bypasses
-- RLS via the PostgreSQL role, not a policy.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE envelope_signers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sender_read_envelopes ON envelopes;
CREATE POLICY sender_read_envelopes ON envelopes
  FOR SELECT
  USING (sender_email IS NOT NULL AND sender_email = current_setting('app.sender_email', true));

DROP POLICY IF EXISTS sender_update_envelopes ON envelopes;
CREATE POLICY sender_update_envelopes ON envelopes
  FOR UPDATE
  USING (sender_email IS NOT NULL AND sender_email = current_setting('app.sender_email', true));

DROP POLICY IF EXISTS signer_read_own ON envelope_signers;
CREATE POLICY signer_read_own ON envelope_signers
  FOR SELECT
  USING (signing_token = current_setting('app.signer_token', true));

DROP POLICY IF EXISTS sender_read_signers ON envelope_signers;
CREATE POLICY sender_read_signers ON envelope_signers
  FOR SELECT
  USING (
    envelope_id IN (
      SELECT id FROM envelopes
      WHERE sender_email IS NOT NULL AND sender_email = current_setting('app.sender_email', true)
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- allowed_senders — default-deny creator allowlist (spec F2.8). Identity is an
-- email or an email_domain (no wallet identities).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS allowed_senders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_type   TEXT NOT NULL CHECK (identity_type IN ('email', 'email_domain')),
  identity        TEXT NOT NULL,        -- normalized lowercase
  quota_per_month INTEGER,              -- NULL = unlimited
  added_by        TEXT NOT NULL,        -- operator who added this entry
  note            TEXT,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT allowed_senders_identity_unique UNIQUE (identity_type, identity)
);

CREATE INDEX IF NOT EXISTS idx_allowed_senders_identity
  ON allowed_senders (identity_type, identity);

-- Per-month usage counter (period = "YYYY-MM" UTC).
CREATE TABLE IF NOT EXISTS allowed_sender_usage (
  identity_type TEXT NOT NULL CHECK (identity_type IN ('email', 'email_domain')),
  identity      TEXT NOT NULL,
  period        TEXT NOT NULL,           -- "YYYY-MM" UTC
  count         INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (identity_type, identity, period)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- user_credits + credit_ledger — per-email credit balance + append-only audit
-- ledger (spec F9.8).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_credits (
  email                  TEXT PRIMARY KEY,                       -- normalized lowercase
  balance_usd_micros     BIGINT NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT user_credits_balance_nonneg CHECK (balance_usd_micros >= 0)
);

CREATE INDEX IF NOT EXISTS idx_user_credits_updated_at
  ON user_credits (updated_at DESC);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                  TEXT NOT NULL,                          -- normalized lowercase
  delta_usd_micros       BIGINT NOT NULL,                        -- positive = credit, negative = debit
  source                 TEXT NOT NULL CHECK (source <> ''),     -- payment-agnostic: first-party (envelope, admin_*, refund, signup_grant) OR a provider top-up source (proprietary [service])
  external_ref           TEXT NOT NULL,                          -- provider payment ref, envelope_id, normalized signup email (signup_grant), etc.
  description            TEXT,                                   -- human-readable note
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT credit_ledger_idempotency UNIQUE (source, external_ref)
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_email_created
  ON credit_ledger (email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_source_created
  ON credit_ledger (source, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- pdf_blobs — base64-encoded canonical PDF bytes, served over a signer-token-
-- authed HTTP endpoint. Keyed by storage_key (so one PDF is stored once).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pdf_blobs (
  storage_key   TEXT PRIMARY KEY,
  bytes_b64     TEXT NOT NULL,
  byte_count    INTEGER NOT NULL,        -- DECODED length (raw bytes)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pdf_blobs_created_at
  ON pdf_blobs (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- auth_sessions — server-side session store (F2.1.7 / DD-72). The SPA holds an
-- opaque session_id in an HttpOnly cookie; the run402 tokens never leave here.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_sessions (
  session_id              UUID PRIMARY KEY,
  email                   TEXT NOT NULL,
  run402_access_token     TEXT NOT NULL,
  run402_refresh_token    TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  session_expires_at      TIMESTAMPTZ NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_email
  ON auth_sessions(email);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at
  ON auth_sessions(session_expires_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- creator_profiles — the envelope creator's own saved display name (F1.11/DD-97).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS creator_profiles (
  account_email          TEXT PRIMARY KEY,                       -- normalized lowercase login email
  display_name           TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creator_profiles_updated_at
  ON creator_profiles (updated_at DESC);

-- inbound_replies (removed in migration 005): inbound email is now a run402
-- EMAIL-TRIGGER durable run (F-29.6). run402 creates the run on the email event and
-- owns the durable inbound record + idempotency + retry/redrive, so the app-owned
-- queue/state-machine is gone. See src/api/signing/inboundEmail.ts.

-- ─────────────────────────────────────────────────────────────────────────────
-- signature_artifacts — F-6.5/F-6.6/F-6.7 durable evidence record, one row per
-- signed signer, assembled at receipt. The bundle (Phase 9) reads this to embed
-- the proof. Idempotent: one artifact per (envelope, signer).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signature_artifacts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id      UUID NOT NULL REFERENCES envelopes(id),
  signer_email     TEXT NOT NULL,
  -- the inbound forward's stable id; the raw .eml lives in run402's inbound store.
  message_id       TEXT,
  -- lowercase hex SHA-256 of the raw .eml — exactly what was timestamped.
  sha256_eml       TEXT NOT NULL,

  -- receipt-time sender-auth verdicts (AC-62; receipt-time signals, not offline proof).
  spf_verdict      TEXT,
  dkim_verdict     TEXT,
  dmarc_verdict    TEXT,

  -- accepted DKIM signature + observed key (F-6.7).
  dkim_domain      TEXT,
  dkim_selector    TEXT,
  dkim_key         TEXT,
  dkim_observed_at TIMESTAMPTZ,

  -- dual timestamps over sha256_eml (F-6.6) + the key-observation timestamp (F-6.7),
  -- stored as the timestamp-module's opaque proof envelopes (JSON).
  ots_proof        JSONB,
  tsa_token        JSONB,
  key_obs_proof    JSONB,

  -- archive.prove.email contribution outcome (AC-60).
  archive_status   TEXT,

  -- OTS proof lifecycle: pending until Bitcoin confirms, then complete.
  ts_status        TEXT NOT NULL DEFAULT 'pending'
                   CHECK (ts_status IN ('pending', 'complete')),

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT signature_artifacts_envelope_signer_unique UNIQUE (envelope_id, signer_email)
);

CREATE INDEX IF NOT EXISTS idx_signature_artifacts_ts_status
  ON signature_artifacts (ts_status);

CREATE INDEX IF NOT EXISTS idx_signature_artifacts_envelope
  ON signature_artifacts (envelope_id);

-- ── Creator API keys (F-30.1 / AC-131, AC-132) ──────────────────────────────
-- Bearer keys for the /v1 auth gate's second mode. Stores ONLY sha256(raw);
-- the raw ksk_… value appears exactly once in the mint response. revoked_at
-- is a tombstone — the auth lookup filters `revoked_at IS NULL`.
-- (Incremental parity for pre-Phase-44 databases: 006_api_keys.sql.)

CREATE TABLE IF NOT EXISTS api_keys (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_email  TEXT NOT NULL,
  key_hash       TEXT NOT NULL UNIQUE,
  label          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_keys_creator_email_idx ON api_keys (creator_email);

-- ── Create-endpoint idempotency keys (F-30.3 / AC-136) ──────────────────────
-- (creator, Idempotency-Key) → request hash + stored 201 response for replay.
-- NULL response_status = in-flight reservation; failures delete their row.
-- (Incremental parity for pre-Phase-44 databases: 007_idempotency_keys.sql.)

CREATE TABLE IF NOT EXISTS idempotency_keys (
  creator_email    TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  response_status  INTEGER,
  response_body    JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (creator_email, idempotency_key)
);

-- ── Creator completion webhooks (F-30.3 / AC-138) ───────────────────────────
-- callback_url + delivery-signing secret per envelope; raw secret returned
-- once at create. Dies with its envelope (CASCADE), consistent with F-9.
-- (Incremental parity for pre-Phase-44 databases: 008_envelope_webhooks.sql.)

CREATE TABLE IF NOT EXISTS envelope_webhooks (
  envelope_id  UUID PRIMARY KEY REFERENCES envelopes(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  secret       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
