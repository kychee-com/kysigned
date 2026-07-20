/**
 * inboundEmail — F-6 / F-7 / F-9.8 inbound signing via run402 EMAIL TRIGGERS (F-29.6).
 *
 * run402 creates a durable function run on each signing-mailbox email event and
 * invokes kysigned with the canonical event under `payload.event`. These two
 * handlers ARE the inbound path — there is NO webhook route, NO received-queue,
 * NO reconciler/notifier sweep. run402 owns email delivery + idempotency +
 * retry/redrive + observability:
 *
 *   • handleReplyReceived — a signer forwarded the document back. Fetch the raw
 *     MIME, run `processForward` (membership → sender-auth → DKIM → intent →
 *     attachment → mark signed, idempotent), assemble the signature artifact +
 *     start its OTS-upgrade chain, send the acceptance ack (exactly-once via the
 *     per-signer marker) or the corrective bounce, and enqueue the completion run
 *     when the last signer signs. A transient failure throws `RetryableRunError`
 *     → run402 retries/redrives the run (the recovery the reconciler used to give).
 *
 *   • handleBounce — a signing-request hard-bounced (F-9.8): mark the signer
 *     undeliverable in every active envelope + notify the creator.
 *
 * The signing crypto/validation core (`processForward` + its gates) and the email
 * templates are unchanged; only the trigger + the durable-record layer moved to run402.
 */
import type { DbPool } from '../../db/pool.js';
import type { EmailProvider } from '../../email/types.js';
import {
  getEnvelope,
  getEnvelopeSigners,
  checkAllSigned,
  markSignerAcceptanceNotified,
  getActiveEnvelopesWithPendingSigner,
} from '../../db/envelopes.js';
import { templates, type RejectionReason } from '../../email/templates.js';
import { processForward, type ForwardOutcome } from './processForward.js';
import { assembleSignatureArtifact, type ArtifactAssemblyDeps } from './artifactAssembly.js';
import { scheduleTimestampUpgrade } from './timestampSchedule.js';
import { handleUndeliverableSigningRequest } from '../envelope.js';
import type { ReceiptVerdicts } from './senderAuthGate.js';
import type { DkimResolver } from './dkimVerify.js';
import { RetryableRunError, PermanentRunError, type CreateRun } from '../../functions/runs.js';
import type { EmitAppEvent } from '../../integrations/appEvents.js';
import type { InternalSubjectGate } from '../../integrations/internalSubject.js';

export interface InboundEmailCtx {
  pool: DbPool;
  emailProvider: EmailProvider;
  operatorDomain: string;
  baseUrl: string;
  /** run402 raw-MIME fetch by message id (scoped to the signing mailbox). */
  fetchRawMime: (messageId: string) => Promise<string | null>;
  /** SES receipt verdicts for a message (F-6.2a). Omit → no verdicts. */
  fetchVerdicts?: (messageId: string) => Promise<ReceiptVerdicts | undefined>;
  /** F-6.2a — enforce the SPF/DMARC rejection on a hard FAIL (default off = record-only). */
  enforceSenderAuth?: boolean;
  /** DKIM DNS resolver — omit in prod (live DNS); inject in tests. */
  dkimResolver?: DkimResolver;
  /** Assemble + persist the signature artifact on a signed outcome (prod sets it). */
  artifact?: ArtifactAssemblyDeps;
  /** F-29 — create follow-up durable runs (completion, timestamp upgrade). */
  createRun?: CreateRun;
  /** Our signing mailbox id — belt-and-suspenders event scoping. Optional. */
  signingMailboxId?: string;
  /** F-36 — emit a business fact into the project event feed (the DD-43 seam:
   *  never throws). Optional in this narrow ctx; prod (config.ts) always wires it. */
  emitAppEvent?: EmitAppEvent;
  /** F-36.6 — the DD-49 internal-subject gate: signatures/declines on an internal
   *  envelope are processed normally but never emit (logged suppression). */
  internalGate?: InternalSubjectGate;
  /** Test seam: the validation core, defaulting to the real `processForward`. Prod
   *  never sets it; a unit test injects a fake outcome to drive the orchestration
   *  without the DKIM fixture rig (`processForward` is covered by its own tests). */
  runProcessForward?: typeof processForward;
}

/** Event fields kysigned reads, from `payload.event` (canonical) or the payload root. */
interface EmailEventFields {
  messageId?: string;
  mailboxId?: string;
  toAddress?: string;
  bounceType?: string;
}
function readEvent(payload: Record<string, unknown>): EmailEventFields {
  const ev = (payload.event ?? payload) as Record<string, unknown>;
  const data = (ev.data ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = ev[k] ?? data[k];
      if (typeof v === 'string' && v) return v;
    }
    return undefined;
  };
  return {
    messageId: pick('message_id', 'messageId'),
    mailboxId: pick('mailbox_id', 'mailboxId'),
    toAddress: pick('to_address', 'toAddress'),
    bounceType: pick('bounce_type', 'bounceType'),
  };
}

/**
 * F-6.2a / AC-62 — the SES receipt verdicts run402 attaches to the `reply_received`
 * event (run402-private #542). `sender_trust` carries snake_case `<check>_verdict`
 * status strings (PASS | FAIL | GRAY | PROCESSING_FAILED); map the three kysigned
 * records + gates on. Absent (older gateway / non-reply event) → empty verdicts.
 */
export function readReceiptVerdicts(payload: Record<string, unknown>): ReceiptVerdicts {
  const ev = (payload.event ?? payload) as Record<string, unknown>;
  const data = (ev.data ?? {}) as Record<string, unknown>;
  const st = (ev.sender_trust ?? data.sender_trust) as Record<string, unknown> | undefined;
  if (!st || typeof st !== 'object') return {};
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return { spf: str(st.spf_verdict), dkim: str(st.dkim_verdict), dmarc: str(st.dmarc_verdict) };
}

/**
 * F-6.9 / F-29.6 — the `reply_received` email-trigger handler. Idempotent + fail-proof:
 * run402 delivers each message once (message-id idempotency) and retries/redrives the
 * run on a thrown `RetryableRunError`.
 */
export async function handleReplyReceived(
  ctx: InboundEmailCtx,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { messageId, mailboxId } = readEvent(payload);
  if (!messageId) throw new PermanentRunError('reply_received: missing message_id');
  // Belt-and-suspenders: the trigger is mailbox-scoped, but drop a mismatched event.
  if (ctx.signingMailboxId && mailboxId && mailboxId !== ctx.signingMailboxId) {
    return { messageId, action: 'ignored_mailbox' };
  }

  const raw = await ctx.fetchRawMime(messageId);
  if (raw == null) throw new RetryableRunError(`raw MIME not yet available for ${messageId}`);

  // F-6.2a / AC-62 — the SES receipt verdicts ride the reply_received event now
  // (run402-private #542); the fetchVerdicts seam is a legacy/test-only fallback.
  const payloadVerdicts = readReceiptVerdicts(payload);
  const verdicts =
    payloadVerdicts.spf || payloadVerdicts.dkim || payloadVerdicts.dmarc
      ? payloadVerdicts
      : (await ctx.fetchVerdicts?.(messageId)) ?? {};
  const runForward = ctx.runProcessForward ?? processForward;
  let outcome: ForwardOutcome;
  try {
    outcome = await runForward(raw, { pool: ctx.pool, verdicts, dkimResolver: ctx.dkimResolver, enforceSenderAuth: ctx.enforceSenderAuth });
  } catch (err) {
    // Transient (e.g. a DNS temperror surfaced as a throw) — retry the run.
    throw new RetryableRunError(`processForward error for ${messageId}: ${(err as Error).message}`);
  }

  switch (outcome.outcome) {
    case 'signed': {
      // F-6.5/6.6 — assemble the artifact + start its OTS-upgrade chain. Best-effort:
      // the signature is already durable; a failed assembly never blocks the ack.
      if (ctx.artifact) {
        try {
          const artifact = await assembleSignatureArtifact(
            ctx.pool,
            {
              envelopeId: outcome.envelopeId,
              signerEmail: outcome.signerEmail,
              messageId,
              rawEml: raw,
              signingDomain: outcome.signingDomain,
              selector: outcome.selector,
              verdicts: outcome.verdicts,
            },
            ctx.artifact,
          );
          if (artifact.ts_status === 'pending') await scheduleTimestampUpgrade(ctx.createRun, artifact.id, 1);
        } catch {
          /* best-effort — signature durable; artifact backfilled later */
        }
      }
      await sendAcceptanceAck(ctx, outcome.envelopeId, outcome.signerEmail);
      // F-36 — signature_completed, keyed (envelope, message): a run retry for the
      // same message re-enters as 'already_signed' (no emit), and a genuine re-sign
      // arrives under a NEW message id → its own event. Ids only, never addresses.
      // F-36.6 — an internal envelope's signature records normally but never emits.
      if (ctx.internalGate && (await ctx.internalGate.envelope(outcome.envelopeId))) {
        ctx.internalGate.logSuppressed('signature_completed', [outcome.envelopeId, messageId]);
      } else {
        await ctx.emitAppEvent?.('signature_completed', [outcome.envelopeId, messageId], {
          envelope_id: outcome.envelopeId,
          message_id: messageId,
        });
      }
      await enqueueCompletionIfAllSigned(ctx, outcome.envelopeId); // may throw retryable → run retries
      return { messageId, action: 'signed', envelopeId: outcome.envelopeId };
    }

    case 'already_signed':
      // Duplicate forward / run retry: the ack marker guards a re-send, and the
      // completion enqueue is re-fired (idempotency-keyed, so it dedups) to recover
      // a completion run lost when the original run crashed after recording.
      await sendAcceptanceAck(ctx, outcome.envelopeId, outcome.signerEmail);
      await enqueueCompletionIfAllSigned(ctx, outcome.envelopeId);
      return { messageId, action: 'already_signed', envelopeId: outcome.envelopeId };

    case 'rejected':
      await sendCorrectiveBounce(ctx, outcome);
      // F-36 — signer_declined with the rejection-code enum. Keyed (envelope,
      // message) so a redelivered event dedupes; a fresh rejected forward is a
      // new message id → its own event.
      // F-36.6 — an internal envelope's decline processes normally but never emits.
      if (ctx.internalGate && (await ctx.internalGate.envelope(outcome.envelopeId))) {
        ctx.internalGate.logSuppressed('signer_declined', [outcome.envelopeId, messageId]);
      } else {
        await ctx.emitAppEvent?.('signer_declined', [outcome.envelopeId, messageId], {
          envelope_id: outcome.envelopeId,
          message_id: messageId,
          code: outcome.code,
        });
      }
      return { messageId, action: 'rejected', code: outcome.code };

    case 'dropped':
      return { messageId, action: 'dropped', reason: outcome.reason }; // silent (AC-16)
  }
}

/**
 * F-9.8 / F-29.6 — the `bounced` email-trigger handler. A permanent bounce marks the
 * signer undeliverable in every active envelope where they're still pending + notifies
 * the creator; a transient bounce may still deliver on a later SES retry, so it no-ops.
 */
export async function handleBounce(
  ctx: InboundEmailCtx,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { toAddress, bounceType } = readEvent(payload);
  if (!toAddress) throw new PermanentRunError('bounced: missing to_address');
  if (bounceType && bounceType !== 'Permanent') return { toAddress, action: 'ignored_transient', bounceType };

  const envelopeIds = await getActiveEnvelopesWithPendingSigner(ctx.pool, toAddress);
  let marked = 0;
  for (const envelopeId of envelopeIds) {
    const res = await handleUndeliverableSigningRequest(
      {
        pool: ctx.pool,
        emailProvider: ctx.emailProvider,
        baseUrl: ctx.baseUrl,
        operatorDomain: ctx.operatorDomain,
        ...(ctx.emitAppEvent ? { emitAppEvent: ctx.emitAppEvent } : {}), // F-36
      },
      envelopeId,
      toAddress,
    );
    if (res.body.marked) marked++;
  }
  return { toAddress, action: 'bounced', marked };
}

// ── inline notify helpers (formerly forwardNotifier + inboundWebhook) ──────────

/**
 * F-7.3 — the acceptance acknowledgment, EXACTLY once. Claim the per-signer marker
 * (atomic set-if-null); only the claiming run sends the ack, so a duplicate forward
 * or a run retry never re-acks. The send itself is best-effort (the signature is
 * durable + the completion bundle follows), and the F-5.7 creator progress notice
 * rides along.
 */
async function sendAcceptanceAck(ctx: InboundEmailCtx, envelopeId: string, signerEmail: string): Promise<void> {
  const claimed = await markSignerAcceptanceNotified(ctx.pool, envelopeId, signerEmail);
  if (!claimed) return; // already acked (duplicate / retry)
  const c = await resolveContext(ctx.pool, envelopeId, signerEmail);
  const t = templates.acceptanceAck({
    signerName: c?.signerName ?? signerEmail,
    documentName: c?.documentName ?? '',
    operatorDomain: ctx.operatorDomain,
  });
  try {
    await ctx.emailProvider.send({ to: signerEmail, subject: t.subject, html: t.html, text: t.text, from: t.from, replyTo: t.replyTo });
  } catch (err) {
    console.error(`acceptance-ack send failed for ${signerEmail}:`, err);
  }
  if (c) await sendCreatorProgress(ctx, envelopeId, c);
}

/** F-7.1 — the class-specific corrective bounce for a rejected forward (AC-20). */
async function sendCorrectiveBounce(
  ctx: InboundEmailCtx,
  outcome: Extract<ForwardOutcome, { outcome: 'rejected' }>,
): Promise<void> {
  const c = await resolveContext(ctx.pool, outcome.envelopeId, outcome.signerEmail);
  const d = ctx.operatorDomain;
  const t = templates.rejectionBounce({
    signerName: c?.signerName ?? outcome.signerEmail,
    documentName: c?.documentName ?? '',
    operatorDomain: d,
    reason: rejectionReasonForCode(outcome.code),
    howItWorksLink: `https://${d}/how-it-works`,
    faqHowToSignLink: `https://${d}/faq#how-to-sign`,
    faqWrongEmailLink: `https://${d}/faq#wrong-email`,
  });
  try {
    await ctx.emailProvider.send({ to: outcome.signerEmail, subject: t.subject, html: t.html, text: t.text, from: t.from, replyTo: t.replyTo });
  } catch (err) {
    console.error(`corrective bounce send failed for ${outcome.signerEmail}:`, err);
  }
}

/** F-5.7 / AC-54 — a short "‹signer› signed ‹doc›" progress notice to the creator on a
 *  non-creator signature; the completing signature adds the auto-close-aware line. */
async function sendCreatorProgress(ctx: InboundEmailCtx, envelopeId: string, c: NotifyContext): Promise<void> {
  if (!c.creatorEmail || c.signerIsCreator) return;
  try {
    const t = templates.creatorProgress({
      signerName: c.signerName,
      documentName: c.documentName,
      signedCount: c.signedCount,
      totalCount: c.totalCount,
      statusPageLink: `https://${ctx.operatorDomain}/dashboard/envelope/${envelopeId}`,
      operatorDomain: ctx.operatorDomain,
      autoClose: c.autoClose,
    });
    await ctx.emailProvider.send({ to: c.creatorEmail, subject: t.subject, html: t.html, text: t.text, from: t.from, replyTo: t.replyTo });
  } catch {
    /* best-effort — the creator can always see progress on the dashboard */
  }
}

/** F-29 — enqueue the completion run when the last signer signs (idempotency =
 *  envelope id, so run402 dedups). A create failure is retryable so the run re-fires. */
async function enqueueCompletionIfAllSigned(ctx: InboundEmailCtx, envelopeId: string): Promise<void> {
  if (!ctx.createRun) return;
  if (!(await checkAllSigned(ctx.pool, envelopeId))) return;
  try {
    // `:completion`-namespaced (gh-566 layer 2): run402 idempotency keys are scoped
    // per function across ALL event types; the bare envelopeId was already claimed
    // by the send-time envelope_expire run, so this create 409'd
    // ("idempotency_key already belongs to a different function run") and
    // completion_distribute was NEVER created. Re-fired reply_received runs still
    // dedup against each other via this stable per-envelope key.
    await ctx.createRun({ eventType: 'completion_distribute', idempotencyKey: `${envelopeId}:completion`, payload: { envelopeId } });
  } catch (err) {
    // Log before throwing: the RetryableRunError message travels back only as the
    // run's HTTP status, so without this line the underlying createRun failure is
    // invisible in CloudWatch (bit us in the gh-566 lease-expiry saga).
    console.error(`completion enqueue failed for ${envelopeId}:`, err);
    throw new RetryableRunError(`completion enqueue failed for ${envelopeId}: ${(err as Error).message}`);
  }
}

interface NotifyContext {
  signerName: string;
  documentName: string;
  creatorEmail?: string;
  signerIsCreator: boolean;
  signedCount: number;
  totalCount: number;
  autoClose: boolean;
}

/** Read the document/signer names + creator-progress inputs for an (envelope, signer). */
async function resolveContext(pool: DbPool, envelopeId: string, signerEmail: string): Promise<NotifyContext | null> {
  const envelope = await getEnvelope(pool, envelopeId);
  if (!envelope) return null;
  const signers = await getEnvelopeSigners(pool, envelopeId);
  const signer = signers.find((s) => s.email.toLowerCase() === signerEmail.toLowerCase());
  const creatorEmail = envelope.sender_email ?? undefined;
  return {
    signerName: signer?.name || signerEmail,
    documentName: envelope.document_name,
    ...(creatorEmail ? { creatorEmail } : {}),
    signerIsCreator: !!creatorEmail && creatorEmail.toLowerCase() === signerEmail.toLowerCase(),
    signedCount: signers.filter((s) => s.status === 'signed').length,
    totalCount: signers.length,
    autoClose: envelope.auto_close,
  };
}

/** Fold a fine-grained rejection code into the user-facing bounce class (AC-20). */
export function rejectionReasonForCode(code: string | null): RejectionReason {
  switch (code) {
    case 'attachment_missing':
      return 'attachment_missing';
    case 'attachment_modified':
      return 'attachment_modified';
    case 'spf_fail':
    case 'dmarc_fail':
      return 'sender_auth';
    case 'envelope_inactive':
      return 'envelope_inactive';
    case 'no_signature':
    case 'body_length_tag':
    case 'misaligned':
    case 'weak_algorithm':
    case 'missing_key':
    case 'invalid_signature':
      return 'dkim_unverifiable';
    case 'wrong_phrase':
    case 'no_intent_line':
    default:
      return 'wrong_phrase';
  }
}
