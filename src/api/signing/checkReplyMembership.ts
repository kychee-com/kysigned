/**
 * checkReplyMembership — F-6.1 inbound membership gate (evidence-bundle model).
 *
 * Answers, for one raw inbound forward, whether it belongs to an outstanding
 * signing request:
 *   - MEMBER: a real envelope (resolved by the `[ksgn-<id>]` subject token,
 *     F-5.2) exists AND the `From` is an invited signer on it. Non-members and
 *     unknown/foreign tokens are dropped SILENTLY after raw storage — no
 *     backscatter (F-6.1 / AC-16); only members ever receive an outbound email.
 *   - For members it also reports `envelopeOpen` (active or awaiting_seal),
 *     `alreadySigned` (one-signature-per-signer idempotency, F-6.8 / AC-18), and
 *     the envelope's canonical `documentHash` (the return-what-we-sent target for
 *     the attachment gate, F-6.4).
 *
 * This is the routing/identity layer; the cryptographic authority is the classical
 * DKIM verification (F-6.2) + the intent line (F-6.3) + attachment byte-equality
 * (F-6.4) that the forward-processing orchestrator runs once membership passes.
 */
import type { DbPool } from '../../db/pool.js';
import { getEnvelope, getSignerByEnvelopeAndEmail } from '../../db/envelopes.js';
import { parseEnvelopeToken } from '../subjectToken.js';
import { extractFrom, extractSubject } from './mimeHeaders.js';

export type ReplyMembership =
  | {
      member: false;
      /** Why identity failed — recorded on the silently-dropped row for observability (F3.3.9.3). */
      reason: 'no_subject_tokens' | 'envelope_not_found' | 'not_a_signer';
      /** Parsed envelopeId if the subject had tokens (else undefined). */
      envelopeId?: string;
      /** The From address (lowercased), or '' if unparseable. */
      signerEmail: string;
    }
  | {
      member: true;
      envelopeId: string;
      /** The From address (lowercased) = the invited signer's email. */
      signerEmail: string;
      /** Raw envelope status (for the terminal-note + diagnostics). */
      envelopeStatus: string;
      /** True iff the envelope is OPEN — `active` OR `awaiting_seal` (all-signed but
       *  not yet sealed). An open envelope can still record a signature (incl. a
       *  superseded signer RE-signing). A CLOSED envelope (completed / voided /
       *  expired) gets a terminal note, not a signature. */
      envelopeOpen: boolean;
      /** True iff this signer already signed (F-6.8 / AC-18 — duplicate forward is an idempotent no-op). */
      alreadySigned: boolean;
      /** Family B (F-3.3): SHA-256 of the shared document D = the envelope `docHash` (H_D). */
      documentHash: string;
      /**
       * Family B (F-6.4): SHA-256 of THIS signer's canonical PDF `P_i = cover_i ++ D`
       * — the per-signer byte-equality target for the attachment gate. NULL for
       * legacy/pre-Family-B rows (a forward then cannot verify → rejected).
       */
      sentPdfHash: string | null;
    };

export async function checkReplyMembership(
  pool: DbPool,
  rawMime: string,
): Promise<ReplyMembership> {
  const signerEmail = extractFrom(rawMime);

  // (a) Subject token — the `[ksgn-<id>]` envelope routing token (F-5.2), tolerant
  //     of forward prefixes (Fwd:/Fw:/localized) since the regex is unanchored.
  const envelopeId = parseEnvelopeToken(extractSubject(rawMime));
  if (!envelopeId) {
    return { member: false, reason: 'no_subject_tokens', signerEmail };
  }

  // (b) Envelope must exist (identity); status is reported below.
  const envelope = await getEnvelope(pool, envelopeId);
  if (!envelope) {
    return { member: false, reason: 'envelope_not_found', envelopeId, signerEmail };
  }

  // (c) From must be an invited signer on that envelope (identity).
  const signer = await getSignerByEnvelopeAndEmail(pool, envelopeId, signerEmail);
  if (!signer) {
    return { member: false, reason: 'not_a_signer', envelopeId, signerEmail };
  }

  return {
    member: true,
    envelopeId,
    signerEmail,
    envelopeStatus: envelope.status,
    // Open = accepts signatures: a manual-seal envelope sits in `awaiting_seal`
    // (all-signed, not yet sealed) and MUST still accept a re-signing superseded
    // signer (Barry QA — a re-sign bounced "no longer active"); only a CLOSED
    // envelope (completed / voided / expired) refuses.
    envelopeOpen: envelope.status === 'active' || envelope.status === 'awaiting_seal',
    alreadySigned: signer.status === 'signed',
    documentHash: envelope.document_hash,
    sentPdfHash: signer.sent_pdf_hash ?? null,
  };
}
