/**
 * processForward — the signing event (F-6, spec v0.4.0, evidence-bundle model).
 *
 * The heart of the product. Given one raw inbound forward, decide whether it is a
 * valid signature and, if so, record it. Composes the Phase-6 gates in spec order:
 *
 *   1. Membership (F-6.1)      — resolve envelope by `[ksgn-<id>]` token; From must
 *                                be an invited signer. Non-members / unknown tokens
 *                                DROP silently (no backscatter, AC-16).
 *   2. Idempotency (F-6.8)     — an already-signed signer's duplicate forward is a
 *                                no-op (AC-18).
 *   3. Envelope active         — a forward to a voided/expired/completed envelope
 *                                gets a terminal note, not a signature.
 *   4. Sender-auth (F-6.2a)    — record the SES verdicts (AC-62); OPT-IN reject on a
 *                                hard SPF/DMARC FAIL (default off). DKIM stays primary.
 *   5. Classical DKIM (F-6.2)  — the trust anchor: signature + body hash verify
 *                                against live DNS, From-aligned, no l= (AC-17).
 *   6. Intent line (F-6.3)     — first non-empty line == "i sign this document"
 *                                (AC-15).
 *   7. Return-what-we-sent     — a PDF attachment byte-identical (SHA-256) to the
 *      (F-6.4)                   envelope's canonical PDF (AC-14).
 *   8. Record (F-6.5/6.6)      — mark the signer signed (AC-13). Idempotent.
 *
 * A `dropped` outcome means silent (routing-level); a `rejected` outcome earns the
 * signer a corrective bounce (the EMAIL is rendered in Phase 8 — this returns the
 * structured code + reason). `signed` / `already_signed` are the success paths.
 */
import type { DbPool } from '../../db/pool.js';
import { markSignerSignedByEmail } from '../../db/envelopes.js';
import { checkReplyMembership } from './checkReplyMembership.js';
import { evaluateSenderAuth, type ReceiptVerdicts } from './senderAuthGate.js';
import { verifyDkim, type DkimResolver } from './dkimVerify.js';
import { evaluateDkimPolicy, type DkimPolicyReason } from './dkimPolicy.js';
import { extractSigningText } from './mimeExtract.js';
import { validateSigningIntent } from './signingIntent.js';
import { checkForwardedAttachment } from './attachmentCheck.js';

export interface ProcessForwardContext {
  pool: DbPool;
  /** SES receipt verdicts surfaced by run402's inbound receipt (F-6.2a). */
  verdicts?: ReceiptVerdicts;
  /**
   * F-6.2a — enforce the SPF/DMARC anti-spoof REJECTION on an explicit hard FAIL.
   * Default OFF (record-only): the verdicts are ALWAYS recorded as receipt metadata
   * (AC-62), but a FAIL only BLOCKS signing when the operator opts in
   * (`KYSIGNED_ENFORCE_SENDER_AUTH`). DKIM (step 5) stays the primary gate either way,
   * so record-only lets an operator watch real verdicts before turning on rejection.
   */
  enforceSenderAuth?: boolean;
  /** DKIM DNS resolver — omit in prod (live DNS, F-6.2); inject in tests. */
  dkimResolver?: DkimResolver;
}

export type ForwardRejectionCode =
  | 'envelope_inactive'
  | 'spf_fail'
  | 'dmarc_fail'
  | DkimPolicyReason // no_signature | body_length_tag | misaligned | weak_algorithm | missing_key | invalid_signature
  | 'wrong_phrase'
  | 'no_intent_line'
  | 'attachment_missing'
  | 'attachment_modified';

export type ForwardOutcome =
  | {
      outcome: 'signed';
      envelopeId: string;
      signerEmail: string;
      /** d= of the accepted DKIM signature (the signer's provider domain). */
      signingDomain: string;
      /** s= selector of the accepted DKIM signature — the observed-key lookup key (F-6.7). */
      selector: string;
      /** Receipt verdicts to persist as receipt-time metadata on the artifact (AC-62). */
      verdicts: ReceiptVerdicts;
    }
  | { outcome: 'already_signed'; envelopeId: string; signerEmail: string }
  | {
      outcome: 'rejected';
      code: ForwardRejectionCode;
      reason: string;
      envelopeId: string;
      signerEmail: string;
      /** The offending intent line / attachment state, for the F-7 corrective bounce. */
      detail?: string;
    }
  | {
      outcome: 'dropped';
      reason: 'no_subject_tokens' | 'envelope_not_found' | 'not_a_signer';
      signerEmail: string;
    };

export async function processForward(
  rawMime: string,
  ctx: ProcessForwardContext,
): Promise<ForwardOutcome> {
  // 1. Membership (F-6.1) — non-members / unknown tokens drop silently (AC-16).
  const membership = await checkReplyMembership(ctx.pool, rawMime);
  if (!membership.member) {
    return { outcome: 'dropped', reason: membership.reason, signerEmail: membership.signerEmail };
  }
  const { envelopeId, signerEmail, sentPdfHash } = membership;

  // 2. Idempotency (F-6.8 / AC-18) — duplicate forward from an already-signed signer.
  if (membership.alreadySigned) {
    return { outcome: 'already_signed', envelopeId, signerEmail };
  }

  // 3. Envelope must be OPEN (active or awaiting_seal) to accept a signature — a
  //    superseded signer re-signs onto an awaiting_seal envelope (Barry QA: a
  //    re-sign was bounced "no longer active"). Only a CLOSED envelope (completed /
  //    voided / expired) gets the terminal note.
  if (!membership.envelopeOpen) {
    return {
      outcome: 'rejected',
      // NOT a /v1 HTTP taxonomy code (F-30.3 / AC-137) — this is the internal F-7
      // bounce-note key (ForwardRejectionCode → templates.ts). The key is quoted so
      // the errorCodes meta-test's `code: '…'` scan doesn't mistake it for one.
      'code': 'envelope_inactive',
      reason: `Envelope is ${membership.envelopeStatus}, no longer open for signing.`,
      envelopeId,
      signerEmail,
    };
  }

  // 4. Sender-authentication gate (F-6.2a) — OPT-IN (default record-only). The SES
  //    verdicts are always recorded on the artifact (step 8 / AC-62); a hard
  //    SPF/DMARC FAIL only REJECTS when the operator enables enforcement. DKIM
  //    (step 5) remains the primary gate either way.
  if (ctx.enforceSenderAuth) {
    const senderAuth = evaluateSenderAuth(ctx.verdicts ?? {});
    if (!senderAuth.ok) {
      return {
        outcome: 'rejected',
        code: senderAuth.reason,
        reason: `Receipt ${senderAuth.failed.toUpperCase()} verdict is ${senderAuth.verdict}.`,
        envelopeId,
        signerEmail,
      };
    }
  }

  // 5. Classical DKIM verification (F-6.2 / AC-17) — the trust anchor.
  const dkimOutcome = await verifyDkim(rawMime, { resolver: ctx.dkimResolver });
  const dkimVerdict = evaluateDkimPolicy(dkimOutcome);
  if (!dkimVerdict.ok) {
    return {
      outcome: 'rejected',
      code: dkimVerdict.reason,
      reason: `DKIM verification failed: ${dkimVerdict.reason}.`,
      envelopeId,
      signerEmail,
    };
  }

  // 6. Intent gate (F-6.3 / AC-15) — first non-empty line == "i sign this document".
  //    extractSigningText falls back to the text/html part for HTML-only forwards
  //    (iPhone / Apple Mail), so the typed line is still seen (validateSigningIntent
  //    reduces the HTML to text via isHtml).
  const part = extractSigningText(rawMime);
  const intent = validateSigningIntent(part?.content ?? '', part?.cte, part?.isHtml ?? false);
  if (!intent.valid) {
    return {
      outcome: 'rejected',
      code: intent.reason ?? 'wrong_phrase',
      reason:
        intent.reason === 'no_intent_line'
          ? 'No signing-intent line was found above the forwarded message.'
          : 'The first line was not the exact signing phrase.',
      envelopeId,
      signerEmail,
      detail: intent.detectedLine,
    };
  }

  // 7. Return-what-we-sent (F-6.4 / AC-14, Family B) — THIS signer's own P_i,
  //    byte-identical. The expected hash is the signer's sentPdfHash (null for a
  //    legacy/non-Family-B row → empty target → no attachment can match → rejected).
  const attachment = checkForwardedAttachment(rawMime, sentPdfHash ?? '');
  if (!attachment.ok) {
    return {
      outcome: 'rejected',
      code: attachment.reason === 'missing' ? 'attachment_missing' : 'attachment_modified',
      reason:
        attachment.reason === 'missing'
          ? 'The forward did not include the document attachment.'
          : 'The attached document does not match the original (it was modified).',
      envelopeId,
      signerEmail,
    };
  }

  // 8. Record the signature (F-6.5/6.6 / AC-13). Idempotent: only flips a still-
  //    pending signer, so a worker that raced us resolves to already_signed.
  const flipped = await markSignerSignedByEmail(ctx.pool, envelopeId, signerEmail);
  if (!flipped) {
    return { outcome: 'already_signed', envelopeId, signerEmail };
  }

  return {
    outcome: 'signed',
    envelopeId,
    signerEmail,
    signingDomain: dkimVerdict.signingDomain,
    selector: dkimVerdict.selector,
    verdicts: ctx.verdicts ?? {},
  };
}
