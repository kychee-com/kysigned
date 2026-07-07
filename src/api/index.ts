export {
  handleCreateEnvelope,
  handleGetEnvelope,
  handleVoidEnvelope,
  handleRemind,
  handleListEnvelopes,
  handleAddSigner,
  handleEditSigner,
  handleDeleteSigner,
} from './envelope.js';
export type {
  CreateEnvelopeRequest,
  ApiContext,
  SenderGateConfig,
  ExpirationStorage,
  SignerEditCtx,
} from './envelope.js';

export { handleHealth } from './health.js';
export type { HealthResult } from './health.js';

export { checkSenderAllowed } from './senderGate.js';
export type { EnforcementStrategy, SenderGateInput, SenderGateResult } from './senderGate.js';

export { handleListDocuments, handleResendToMissing } from './envelope.js';

// F8.12 — Creator canonical-PDF download (session-authed, owner-checked).
export { handleGetEnvelopePdfForOwner } from './ownerPdf.js';
export type { OwnerPdfDeps, OwnerPdfResult, EnvelopeRowForOwnerPdf } from './ownerPdf.js';

// The payment-provider webhook handler is PROPRIETARY and lives in the operator's private
// billing function (F-13 `[service]`); the public template ships no payment-provider code.

export {
  handleAddAllowedSender,
  handleRemoveAllowedSender,
  handleListAllowedSenders,
} from './admin.js';
export type { AdminContext, AddAllowedSenderRequest } from './admin.js';

export {
  markCompletionEmailDelivered,
  markCompletionEmailBounced,
} from './emailWebhook.js';

// Completion distribution (Phase 10 — F-9.1): assemble + email the evidence bundle
// to every party, role-scoped (creator dashboard link, signers none), deduped,
// idempotent + fail-proof. Retention (F-9.3) is the pre-existing pdf/retention layer.
export { distributeEnvelopeBundle } from './distributeBundle.js';
export type {
  DistributeBundleDeps,
  DistributeResult,
  DistributeAction,
  PreparedBundle,
} from './distributeBundle.js';

// F-24 — auto-close vs manual seal: the creator "Seal & send" handler +
// the completion-backstop manual-seal notifier (parks awaiting_seal).
export { handleSealEnvelope, notifyEnvelopeAwaitingSeal } from './sealEnvelope.js';
export type { SealNotifyDeps, AwaitingSealAction } from './sealEnvelope.js';

export { deleteAccount, verifyDeletion } from './accountDeletion.js';
export type {
  DeletionStorage,
  DeletionReport,
  DeletionVerification,
} from './accountDeletion.js';

// ── Forward-processing pipeline (Phase 6 — the signing event, F-6) ─────────
// The evidence-bundle signing event: an inbound forward is validated by
// processForward (membership → sender-auth → classical DKIM → intent line →
// attachment byte-equality → record).
export { processForward } from './signing/processForward.js';
export type {
  ProcessForwardContext,
  ForwardOutcome,
  ForwardRejectionCode,
} from './signing/processForward.js';
// F-6.6 timestamp wiring — kysigned applies BOTH timestamps (OpenTimestamps Bitcoin
// anchor + RFC 3161 freeTSA) over sha256(.eml) on a signed artifact.
export { assembleSignatureArtifact } from './signing/artifactAssembly.js';
export type { ArtifactAssemblyDeps, AssembleArtifactInput } from './signing/artifactAssembly.js';
// F-29 — the OTS timestamp upgrade is a self-rescheduling durable run; the per-
// artifact advance + the reschedule helper live in timestampSchedule.
export { upgradeOneArtifact, scheduleTimestampUpgrade } from './signing/timestampSchedule.js';
export type { UpgradeAction } from './signing/timestampSchedule.js';
export { createDefaultTimestampAssemblyDeps } from './signing/timestampProviders.js';
export type { DefaultTimestampOptions } from './signing/timestampProviders.js';
export { extractFirstTextPlain, extractFirstTextHtml, extractSigningText, extractPdfAttachments } from './signing/mimeExtract.js';
export type { TextPlainPart, SigningTextPart, PdfAttachment } from './signing/mimeExtract.js';
export { validateSigningIntent, CANONICAL_INTENT } from './signing/signingIntent.js';
export { checkForwardedAttachment, sha256Hex } from './signing/attachmentCheck.js';
export { verifyDkim } from './signing/dkimVerify.js';
export { evaluateDkimPolicy } from './signing/dkimPolicy.js';
export { evaluateSenderAuth } from './signing/senderAuthGate.js';
export { checkReplyMembership } from './signing/checkReplyMembership.js';
export { buildEnvelopeToken, parseEnvelopeToken } from './subjectToken.js';

// Signer read-only endpoints (no account; per-signer token).
export { handleSignerInfo, handleSignerPdf } from './signerApi.js';
export type { SigningInfo, SignerApiCtx, SignerInfoResult, SignerPdfResult } from './signerApi.js';
// F-29.6 — inbound signing via run402 email triggers (reply_received / bounced).
export { handleReplyReceived, handleBounce, rejectionReasonForCode } from './signing/inboundEmail.js';
export type { InboundEmailCtx } from './signing/inboundEmail.js';

// ── Automated reminders (Phase 5 — F-5.5 / AC-46) ──────────────────────────
// A cron tick reminds still-pending signers on the 3/7-day schedule, stopping on
// signed / void / expiry, capped at intervals.length. Pure due decision +
// orchestrator over injected seams; createReminderSweepDeps wires the real
// candidate DAO + the shared remindSigner send path for prod (cron = Phase 19).
// F-29 — automated reminders are deferred durable runs scheduled at send time.
export { scheduleSignerReminders, REMINDER_INTERVALS_DAYS } from './reminderSchedule.js';
export { remindSigner } from './envelope.js';
export type { ReminderSendCtx } from './envelope.js';

export * from './auth/index.js';
