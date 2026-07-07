import type { TimestampProof } from '../timestamp/contract.js';

export interface Envelope {
  id: string;
  /** The envelope creator (Sender). Always set — the creator identity is email-only. */
  sender_email: string;
  document_name: string;
  document_hash: string;
  /**
   * SHA-256 of the envelope creator's pre-assembly source bytes (v0.19.x+).
   * Distinct from `document_hash` (= SHA-256 of canonical envelope PDF
   * with cover, per F22.9). Used for dashboard grouping + F16.10 same-
   * document detection so two envelopes from the same source upload
   * group together even though their canonical docHashes differ.
   * NULL for legacy rows created pre-v0.19.0 — queries `COALESCE` to
   * fall back to `document_hash` for legacy grouping.
   */
  source_hash: string | null;
  /** Lifecycle (F-24): active(=open) → awaiting_seal → completed(=sealed); expired/voided. */
  status: 'active' | 'awaiting_seal' | 'completed' | 'expired' | 'voided';
  /** F-24 — auto-close (default true) vs manual "Seal & send". */
  auto_close: boolean;
  created_at: Date;
  completed_at: Date | null;
  pdf_storage_key: string | null;
  expiry_at: Date | null;
  pdf_deleted_at: Date | null;
  consent_language_version: string;
  /**
   * 2F.CD.3/CD.4 (F7.5) — timestamp the all-party completion distribution
   * finished (creator email sent last). NULL until distributed. Its presence is
   * the exactly-once gate for `handleCompletionIfReady`: signers dedup via
   * `envelope_signers.completion_email_provider_msg_id`, the creator (which has
   * no signer row) deduplicates via this marker. A crash mid-distribution leaves
   * it NULL so the cron backstop (CD.5) resumes.
   */
  completion_distributed_at: Date | null;
  /**
   * F-3.7 — internal-test envelope (no credit deducted, excluded from
   * revenue/usage metrics, marked in the dashboard). Set via
   * markEnvelopeInternalTest after creation. Default false.
   */
  internal_test: boolean;
}

export interface EnvelopeSigner {
  id: string;
  envelope_id: string;
  email: string;
  name: string;
  /**
   * F-22.2 — the organisation this signer declared signing on behalf of, when
   * the creator enabled "signing on behalf of" for them. NULL = an individual
   * signature (no on-behalf-of declaration). Surfaced in the signing-request
   * email body (F-22.2) and the bundle signature page (F-8.1).
   */
  on_behalf_of: string | null;
  /**
   * Family B (F-3.3 / DD-9) — SHA-256 hex of this signer's canonical PDF
   * `P_i = cover_i ++ D`; the per-signer return-what-we-sent target (F-6.4).
   * NULL only for legacy/pre-Family-B rows. `P_i` is regenerated deterministically
   * from the signer fields + the shared document D (never stored).
   */
  sent_pdf_hash: string | null;
  verification_level: 1 | 2 | 5;
  // reply-to-sign (email DKIM) is the only signing method (F3.4 / F4.D).
  signing_method: 'email' | null;
  status: 'pending' | 'signed' | 'superseded' | 'declined';
  signing_token: string;
  token_expires_at: Date;
  signed_at: Date | null;
  reminder_count: number;
  last_reminder_at: Date | null;
  completion_email_delivered_at: Date | null;
  completion_email_bounced_at: Date | null;
  completion_email_provider_msg_id: string | null;
  /** F-9.8/AC-50 — set when the signing-request email hard-bounced (undeliverable). */
  undeliverable_at: Date | null;
  /** F-7.3 / F-29.6 — exactly-once acceptance-ack marker (set when the ack was sent). */
  acceptance_notified_at: Date | null;
}

export interface CreateEnvelopeInput {
  /** The envelope creator (Sender). Required — the creator identity is email-only. */
  sender_email: string;
  document_name: string;
  document_hash: string;
  /**
   * SHA-256 of the envelope creator's pre-assembly source bytes (the PDF
   * they uploaded BEFORE kysigned added the cover page). Different from
   * `document_hash` (SHA-256 of canonical envelope PDF with cover, per
   * F22.9). Used for dashboard grouping (F16.5/F16.7) and F16.10 same-
   * document detection so two envelopes from the same source upload
   * group together even though their canonical docHashes differ.
   */
  source_hash?: string;
  /**
   * Optional pre-generated envelope ID. When set, `createEnvelope` uses
   * this value instead of generating a fresh UUID. Used by F22.1 cover-page
   * assembly: the envelope creator generates the ID upfront, bakes it into
   * the cover, hashes the canonical PDF, then persists. Both source of the
   * docHash (= SHA-256 of canonical PDF) and the persisted envelope row
   * agree on the same envelope ID. UUID v4 format required.
   */
  envelope_id?: string;
  expiry_at?: Date;
  signers: CreateSignerInput[];
}

export interface CreateSignerInput {
  email: string;
  /**
   * Display name the creator gave this signer (F-3.2). Optional — a blank name
   * falls back to the email address as the identifier (applied in
   * `createEnvelope`), so the NOT NULL `name` column always gets a value.
   */
  name?: string;
  /** F-22.2 — optional "signing on behalf of" organisation for this signer. */
  on_behalf_of?: string;
  /**
   * Family B (F-3.3 / DD-9) — SHA-256 of this signer's canonical PDF
   * `P_i = cover_i ++ D`, computed by the create handler (via
   * `buildSignerCanonicalPdf`) before persisting. The per-signer F-6.4 target.
   */
  sent_pdf_hash?: string;
  verification_level?: 1 | 2 | 5;
}

/**
 * F-6.5/6.6/6.7 — the durable evidence record assembled at receipt, one row per
 * signed signer (migration 020). Carries the receipt-time evidence that is NOT in
 * the raw `.eml` itself: SES verdicts, the observed DKIM key, the dual timestamps
 * over `sha256(raw .eml)`, and the archive-contribution outcome. The bundle (Phase
 * 9) reads this to embed the proof.
 */
export interface SignatureArtifact {
  id: string;
  envelope_id: string;
  signer_email: string;
  /** The inbound forward's stable id; the raw `.eml` lives in run402's inbound store. */
  message_id: string | null;
  /** Lowercase hex SHA-256 of the raw `.eml` — exactly what was timestamped. */
  sha256_eml: string;
  /** SES receipt verdicts (AC-62; receipt-time signals, NOT part of the offline proof). */
  spf_verdict: string | null;
  dkim_verdict: string | null;
  dmarc_verdict: string | null;
  /** Accepted DKIM signature + the key we observed in DNS (F-6.7). */
  dkim_domain: string | null;
  dkim_selector: string | null;
  dkim_key: string | null;
  dkim_observed_at: Date | null;
  /** Dual timestamps over sha256_eml (F-6.6) + the key-observation timestamp (F-6.7). */
  ots_proof: TimestampProof | null;
  tsa_token: TimestampProof | null;
  key_obs_proof: TimestampProof | null;
  /** archive.prove.email contribution outcome (AC-60). */
  archive_status: string | null;
  /** OTS lifecycle: `pending` until Bitcoin confirms, then `complete`. */
  ts_status: 'pending' | 'complete';
  created_at: Date;
  updated_at: Date;
}

export interface CreateSignatureArtifactInput {
  envelope_id: string;
  signer_email: string;
  message_id?: string | null;
  sha256_eml: string;
  spf_verdict?: string | null;
  dkim_verdict?: string | null;
  dmarc_verdict?: string | null;
  dkim_domain?: string | null;
  dkim_selector?: string | null;
  dkim_key?: string | null;
  dkim_observed_at?: Date | null;
  ots_proof?: TimestampProof | null;
  tsa_token?: TimestampProof | null;
  key_obs_proof?: TimestampProof | null;
  archive_status?: string | null;
  ts_status?: 'pending' | 'complete';
}
