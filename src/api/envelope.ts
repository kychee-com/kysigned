import type { DbPool } from '../db/pool.js';
import type { CreateEnvelopeInput, Envelope, EnvelopeSigner } from '../db/types.js';
import type { EmailProvider } from '../email/types.js';
import { templates } from '../email/templates.js';
import {
  createEnvelope,
  getEnvelope,
  getEnvelopeSigners,
  getSignerByEnvelopeAndEmail,
  addSignerToEnvelope,
  updateSignerForEdit,
  deleteSigner,
  voidEnvelope,
  getOutstandingSigners,
  reactivateAwaitingSeal,
  updateSignerReminder,
  getEnvelopesBySender,
  getDocumentsByOwner,
  getIncompleteSigners,
  markEnvelopeInternalTest,
  markSignerUndeliverable,
  markEnvelopePdfDeleted,
  setEnvelopeAutoClose,
} from '../db/envelopes.js';
import { computePdfHash, decodePdfBase64, fetchPdfFromUrl, PdfUrlError } from '../pdf/hash.js';
import { isPdfParseable } from '../pdf/validate.js';
import { validatePublicHttpsUrl } from '../net/urlGuard.js';
import { buildSignerCanonicalPdf } from '../pdf/perSignerCanonical.js';
import { documentBlobKey } from '../pdf/documentKey.js';
import { purgeEnvelopeBlobs } from '../pdf/blobPurge.js';
import { listEnvelopeSignatureArtifacts } from '../db/signatureArtifacts.js';
import { evaluateCreateGate, DEFAULT_ENVELOPE_COST_USD_MICROS, X402_CREATE_ROUTE } from './createGate.js';
import { estimateBundleSize, sizeRejectionMessage } from './sizeGuard.js';
import { isUploadTooLarge, uploadTooLargeMessage } from './uploadGuard.js';
import { checkSignerAddresses } from './signerInboxGuard.js';
import { firstUnsupportedNameChar } from '../pdf/nameFont.js';
import { upsertCreatorName } from '../db/creatorProfiles.js';
import { scheduleSignerReminders } from './reminderSchedule.js';
import { scheduleEnvelopeExpiry } from './expirySchedule.js';
import { scheduleDeliveryBackstop } from './deliveryBackstop.js';
import { validateCallbackUrl } from './webhookDeliver.js';
import { mintWebhookSecret } from './webhookSignature.js';
import { setEnvelopeWebhook } from '../db/envelopeWebhooks.js';
import type { CreateRun } from '../functions/runs.js';
import { randomUUID, randomBytes } from 'node:crypto';

export interface CreateEnvelopeRequest {
  pdf_base64?: string;
  pdf_url?: string;
  document_name: string;
  signers: Array<{
    email: string;
    /** F-3.2 — display name; blank falls back to the email address. */
    name?: string;
    /** F-22.2 — optional "signing on behalf of" organisation for this signer. */
    on_behalf_of?: string;
    verification_level?: 1 | 2 | 5;
  }>;
  expiry_days?: number;
  message?: string;
  /** F-30.3 / AC-138 — creator-supplied completion-webhook URL (https only). The
   *  create response returns `callback_secret` (once) for signature verification. */
  callback_url?: string;
  /** F-3.7 — flag this as an internal-test envelope (no credit, excluded from metrics). */
  internal_test?: boolean;
  /**
   * F-24.1 — auto-close (default true). When false the envelope enters
   * `awaiting_seal` on all-signed and waits for the creator's manual "Seal & send"
   * instead of distributing automatically.
   */
  auto_close?: boolean;
}

/**
 * v0.4.0 credit seam (F-13). The handler reads/debits envelope credit through
 * these injected callbacks; the local credit store + provider top-ups land in Phase 13.
 * Flat per-envelope price (F-13.1: $0.25) — no per-signer surcharge. The 401/403
 * gate logic lives in `createGate.ts` (`evaluateCreateGate`).
 */
export interface SenderGateConfig {
  /** Current envelope-credit balance (USD micros) for the creator. */
  getCreditBalance?: (senderIdentity: string) => Promise<number>;
  /** Debit one flat envelope credit after a successful create. */
  deductCredit?: (
    senderIdentity: string,
    amountUsdMicros: number,
    envelopeId: string
  ) => Promise<{ ok: boolean; error?: string }>;
  /** F-9.7/AC-49 — refund one envelope credit when a fully-unsigned envelope is voided. */
  refundCredit?: (
    senderIdentity: string,
    amountUsdMicros: number,
    envelopeId: string
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Flat per-envelope cost override (USD micros). Default 250_000 = $0.25 (F-13.1). */
  costUsdMicros?: number;
}

export interface ApiContext {
  pool: DbPool;
  /** F-29 — schedule each new signer's automated reminders as deferred durable runs. */
  createRun?: CreateRun;
  /**
   * F-9.9 / AC-124 — the bounded delivery-confirmation window for the undeliverable
   * backstop, as a run `delay` string (operator-config `KYSIGNED_DELIVERY_BACKSTOP_HOURS`,
   * e.g. `"24h"`). Unset → `deliveryBackstop.ts` default (24h).
   */
  deliveryBackstop?: string;
  emailProvider: EmailProvider;
  baseUrl: string;
  /**
   * F-PDF: separate URL origin for the API (PDF download) when the SPA and
   * Lambda live on different hostnames per DD-66. Defaults to `baseUrl`
   * when unset (single-domain forker default).
   */
  pdfApiBaseUrl?: string;
  /** The envelope creator (Sender). Email-only — `senderIdentity` IS the email. */
  senderIdentity: string;
  storePdf?: (key: string, data: Uint8Array) => Promise<void>;
  /** F8.6: called by void/expire flows to immediately drop the original PDF. */
  deletePdf?: (key: string) => Promise<void>;
  /**
   * F-16.7 — server-side `pdf_url` fetch seam (SSRF-guarded). Defaults to the
   * real `fetchPdfFromUrl`; injectable so tests exercise the fetched-bytes path
   * (e.g. F-017: a successful fetch of a non-PDF resource) without real network.
   */
  fetchPdf?: (url: string) => Promise<Uint8Array>;
  senderGate?: SenderGateConfig;
  /**
   * F-30.2 — operator x402 discovery: when set, the credit-gate 402 names the
   * always-priced create route + its price (machine-readable pointer fields)
   * so an unfunded agent learns where to pay. Absent (forker default) → the
   * 402 body is unchanged.
   */
  x402Discovery?: { priceUsdMicros: number };
  /**
   * F-3.6 — optional operator allowlist of creator identities (forker
   * org-restriction). Empty/absent = any authenticated, funded creator.
   */
  allowedCreators?: string[];
  /** F-3.5 — operator override for the bundle-size ceiling (bytes). Default 15 MiB. */
  bundleSizeCeilingBytes?: number;
  /**
   * F-3.7 — operator-config login-email domains allowed to create internal-test
   * envelopes (kysigned: `kychee.com`). A non-internal account requesting an
   * internal-test envelope is rejected 403.
   */
  internalTestDomains?: string[];
  /** Operator domain for reply-to-sign (e.g., 'kysigned.com') */
  operatorDomain?: string;
  /** Exact signing mailbox address shown in signer instructions and Reply-To. */
  signingEmail?: string;
  /**
   * F-19 / AC-39 (forkability) — the `List-Unsubscribe` contact on outbound mail.
   * Operator-configured via `KYSIGNED_UNSUBSCRIBE_MAILTO`: kysigned.com pins
   * `legal@kychee.com`; an operator that sets nothing defaults to
   * `legal@<operatorDomain>` — so no Kychee address is baked into a forker's email.
   */
  unsubscribeMailto?: string;
  /**
   * SPA host for the /verify link printed on the cover page and proof
   * blocks (e.g., 'app.example.com'). Per DD-66, this is split
   * from `operatorDomain` when an operator hosts the marketing site and
   * the SPA on different hostnames. Single-host forkers can omit this — it
   * defaults to `new URL(baseUrl).hostname` (which is the SPA host since
   * `baseUrl` is the SPA origin per DD-66).
   */
  spaDomain?: string;
}

/**
 * Hard cap on signers per envelope. The flat $0.25 price covers the whole
 * envelope regardless of how many people sign; this also keeps the evidence
 * bundle bounded so it stays deliverable (one embedded `.eml` per signer).
 */
export const MAX_SIGNERS_PER_ENVELOPE = 20;

/**
 * Classify an outbound-send failure (2026-06-21 crash fix). A deliverability
 * rejection — the recipient is suppressed / invalid / a known hard bounce — is
 * PERMANENT and recipient-specific: the signer is marked undeliverable (F-9.8)
 * and the create proceeds. Anything else (5xx, throttle, network) is TRANSIENT
 * and recoverable, so the signer is left pending for a later reminder/resend.
 * Classified conservatively: only a CLEAR deliverability signal counts as
 * permanent, so a transient blip never wrongly strands a real signer.
 */
export function isUndeliverableRecipientError(err: unknown): boolean {
  // 35.5 / AC-124 hardening — PREFER a typed permanence signal over string-matching
  // the provider's error text (which can silently drift). run402's `EmailProvider.send`
  // exposes no typed signal today, so the regex below stays the live path; but when an
  // error carries a structured permanence classification we trust it, and a
  // misclassification is caught by the F-9.9 delivery backstop (deliveryBackstop.ts)
  // regardless. Precedence: explicit boolean → SES bounceType → numeric mail status → regex.
  const typed = typedPermanenceSignal(err);
  if (typed !== undefined) return typed;

  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /suppress|bounce|not\s+verified|unverified|invalid\s+(recipient|destination|address|email)|recipient.*reject|reject.*recipient|mailbox\s+(unavailable|not\s+found)|does\s+not\s+exist|no\s+such\s+(user|address)/.test(
    msg,
  );
}

/**
 * Read a STRUCTURED permanence classification off a send error, if it carries one.
 * Returns `true` (permanent → undeliverable), `false` (transient → recoverable), or
 * `undefined` (no typed signal — the caller falls back to text-matching). Only clear,
 * structured fields are consulted (never parsed out of the free-text message): an
 * explicit `permanent` boolean, an SES `bounceType` enum, or a numeric SMTP/mail
 * status code (5xx / `5.x.x` permanent, 4xx / `4.x.x` transient). A bare HTTP status
 * is deliberately NOT inferred from the message string — that stays the regex's job.
 */
function typedPermanenceSignal(err: unknown): boolean | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;

  // 1) Explicit permanence boolean (the cleanest signal a provider can give).
  if (typeof e.permanent === 'boolean') return e.permanent;

  // 2) SES/SNS bounce classification. 'Permanent' → undeliverable; 'Transient' →
  //    recoverable; 'Undetermined' (or anything else) → no decision, fall through.
  if (typeof e.bounceType === 'string') {
    const bt = e.bounceType.toLowerCase();
    if (bt === 'permanent') return true;
    if (bt === 'transient') return false;
    return undefined;
  }

  // 3) A numeric mail status code on a dedicated field (SMTP reply or enhanced status).
  //    5xx / 5.x.x = permanent; 4xx / 4.x.x = transient. Only a real numeric-ish code
  //    field counts — this never scrapes a "(HTTP 400)" out of the free-text message.
  for (const key of ['statusCode', 'responseCode', 'smtpCode', 'code']) {
    const cls = classifyMailStatusCode(e[key]);
    if (cls !== undefined) return cls;
  }
  return undefined;
}

/** 5xx / `5.x.x` → true (permanent); 4xx / `4.x.x` → false (transient); else undefined. */
function classifyMailStatusCode(raw: unknown): boolean | undefined {
  let lead: string | undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    lead = String(Math.trunc(raw))[0];
  } else if (typeof raw === 'string') {
    const m = /^\s*([45])[.\d]{2,}\s*$/.exec(raw); // "550" or "5.1.1" (not a bare "5")
    lead = m?.[1];
  }
  if (lead === '5') return true;
  if (lead === '4') return false;
  return undefined;
}

/**
 * F-19 / AC-39 — the operator-configurable `List-Unsubscribe` header for outbound
 * mail. kysigned.com pins `legal@kychee.com` via `KYSIGNED_UNSUBSCRIBE_MAILTO`; an
 * operator that sets nothing falls back to `legal@<operatorDomain>`, so a forker's
 * email never carries a Kychee address.
 */
export function unsubscribeHeader(ctx: { unsubscribeMailto?: string; operatorDomain?: string }): Record<string, string> {
  const mailto = ctx.unsubscribeMailto ?? `legal@${ctx.operatorDomain ?? 'kysigned.com'}`;
  return { 'List-Unsubscribe': `<mailto:${mailto}>` };
}

/**
 * F-12.3 / AC-125 — the machine-readable per-signer DELIVERY state, distinct from the
 * signing `status` enum (which has no 'undeliverable' value). Derived, not stored:
 * `undeliverable` when the invite hard-bounced or the delivery backstop fired
 * (`undeliverable_at`); `delivered` once the signer has signed (delivery is proven by
 * the signature); otherwise `pending` (invite in flight). An API/MCP consumer polls
 * this to tell a bounced invite from a normal pending one without reading the dashboard.
 */
export function deliveryStatus(
  s: Pick<EnvelopeSigner, 'undeliverable_at' | 'signed_at' | 'status'>,
): 'pending' | 'delivered' | 'undeliverable' {
  if (s.undeliverable_at) return 'undeliverable';
  if (s.signed_at || s.status === 'signed') return 'delivered';
  return 'pending';
}

export async function handleCreateEnvelope(ctx: ApiContext, req: CreateEnvelopeRequest) {
  // Validate PDF input
  if (!req.pdf_base64 && !req.pdf_url) {
    return { status: 400, body: { error: 'Provide pdf_base64 or pdf_url', code: 'validation_pdf' } };
  }
  // F-005: `document_name` is REQUIRED and must be a non-empty string. A raw
  // API/agent client (bypassing the typed SPA) that omits it previously crashed
  // the cover-page renderer (`wrapToWidth(undefined).split` → 500) instead of a
  // clean 400. Validate malformed input up front. (Also guard `signers` being
  // absent — `.length` on undefined would likewise throw before this fix.)
  if (typeof req.document_name !== 'string' || req.document_name.trim() === '') {
    return { status: 400, body: { error: 'document_name is required (a non-empty string).', code: 'validation_document_name' } };
  }
  // #110 — the document name is drawn on the cover in an embedded Unicode font
  // (Latin/Greek/Cyrillic/Hebrew/Arabic). A character that font can't render (CJK,
  // etc.) would tofu / throw deep in assembly, so reject it up front with a clean,
  // named 400 pointing at the supported-languages FAQ (same shape as the F-005 / #96
  // guards). Hebrew/Greek/Cyrillic/Arabic names now PASS (were rejected pre-#110).
  const docNameBad = firstUnsupportedNameChar(req.document_name);
  if (docNameBad) {
    return {
      status: 400,
      body: {
        error:
          `The document name contains a character we can't put on the signed document ` +
          `(${docNameBad.char} ${docNameBad.label}). We support Latin, Greek, Cyrillic, ` +
          `Hebrew, and Arabic names; Chinese, Japanese, and Korean aren't supported yet. ` +
          `See our FAQ on supported languages, or rename the document.`,
        code: 'validation_document_name',
      },
    };
  }
  if (!Array.isArray(req.signers) || req.signers.length === 0) {
    return { status: 400, body: { error: 'At least one signer required', code: 'validation_signers' } };
  }
  // F-30.3 / AC-138 — validate the completion-webhook URL up front (https only,
  // no literal loopback/private hosts — the server POSTs it at completion).
  if (req.callback_url !== undefined) {
    if (typeof req.callback_url !== 'string') {
      return { status: 400, body: { error: 'callback_url must be a string', code: 'validation_callback_url' } };
    }
    const verdict = validateCallbackUrl(req.callback_url);
    if (!verdict.ok) {
      return { status: 400, body: { error: verdict.reason, code: 'validation_callback_url' } };
    }
  }
  // F-16.7 / AC-140 — SSRF guard the pdf_url the SERVER fetches: fail fast on a
  // non-https or literal private/loopback/metadata host before the credit gate
  // (the DNS-resolved-host + timeout + size checks run in fetchPdfFromUrl below).
  if (req.pdf_url !== undefined) {
    if (typeof req.pdf_url !== 'string') {
      return { status: 400, body: { error: 'pdf_url must be a string', code: 'validation_pdf_url' } };
    }
    const urlVerdict = validatePublicHttpsUrl(req.pdf_url);
    if (!urlVerdict.ok) {
      return { status: 400, body: { error: `pdf_url ${urlVerdict.reason}`, code: 'validation_pdf_url' } };
    }
  }
  if (req.signers.length > MAX_SIGNERS_PER_ENVELOPE) {
    return {
      status: 400,
      body: { error: `An envelope can have at most ${MAX_SIGNERS_PER_ENVELOPE} signers.`, code: 'validation_signers' },
    };
  }
  // F-3.2a / AC-88 / AC-89 (#96): reject plus-alias or same-inbox signer sets up
  // front. Two signers on one inbox (or a plus-alias, which delivers to / replies
  // from the primary mailbox) are indistinguishable under the per-signer DKIM
  // identity model (F-3.4 / F-6.4), so the signature can't be bound to one signer.
  const signerIssue = checkSignerAddresses(req.signers);
  if (signerIssue) {
    // The guard's `code` is a taxonomy `validation_*` code (F-30.3) — pass it through.
    return { status: 400, body: { code: signerIssue.code, error: signerIssue.message } };
  }

  // F-3.5a / AC-7 (F-004): app-level upload-size guard — run it EARLY, before the
  // credit/auth gate and before any PDF parsing/assembly. An oversize `pdf_base64`
  // is a malformed-input 400 regardless of credit/allowlist state; checking it here
  // means a funded OR unfunded creator gets the clean, sized 400 (not a parse-crash
  // 502 for a request that slips past the gateway's 6 MiB invoke wall). API/agent
  // clients bypass the frontend guard, so this server-side check is the real
  // enforcement. (`pdf_url` is the documented large-doc escape — server-side fetch,
  // bypasses the invoke cap — so it is NOT capped here; F-3.5a.) Decoded once here
  // and reused below.
  let sourceBytes: Uint8Array | undefined;
  if (req.pdf_base64) {
    sourceBytes = decodePdfBase64(req.pdf_base64);
    if (isUploadTooLarge(sourceBytes.length)) {
      return { status: 400, body: { error: uploadTooLargeMessage(sourceBytes.length), code: 'rate_size_pdf' } };
    }
  }

  // F-3.7 — internal-test authorization. A creator whose login-email domain is
  // in internalTestDomains may flag the envelope internal-test (no credit, no
  // metrics); any other account requesting it is rejected 403.
  let isInternalTest = false;
  if (req.internal_test) {
    const domain = (ctx.senderIdentity ?? '').split('@')[1]?.trim().toLowerCase() ?? '';
    isInternalTest = (ctx.internalTestDomains ?? []).some((d) => d.trim().toLowerCase() === domain);
    if (!isInternalTest) {
      return {
        status: 403,
        body: { error: 'Internal-test envelopes are restricted to internal accounts (F-3.7)', code: 'auth_forbidden' },
      };
    }
  }

  // v0.4.0 create gate (F-3.1/F-3.6/F-13, AC-5): 401 (no creator) / 403
  // (allowlist miss) / 402 (insufficient credit) BEFORE any PDF assembly or DB
  // write. Internal-test envelopes skip the credit check (F-3.7).
  const gate = await evaluateCreateGate({
    senderIdentity: ctx.senderIdentity,
    allowedCreators: ctx.allowedCreators,
    getCreditBalance: isInternalTest ? undefined : ctx.senderGate?.getCreditBalance,
    envelopeCostUsdMicros: ctx.senderGate?.costUsdMicros,
    signerCount: req.signers.length,
  });
  if (!gate.ok) {
    // The gate verdict carries its own taxonomy code (auth_required / auth_forbidden /
    // payment_required — F-30.3), matching its 401/403/402 status. With operator
    // x402 config, the 402 (and ONLY the 402) additionally names the paid route
    // + price (F-30.2 discovery) — still plain JSON, never an x402 challenge.
    const gateBody: Record<string, unknown> = { code: gate.code!, error: gate.error };
    if (gate.status === 402 && ctx.x402Discovery) {
      gateBody['x402_route'] = X402_CREATE_ROUTE;
      gateBody['x402_price_usd_micros'] = ctx.x402Discovery.priceUsdMicros;
    }
    return { status: gate.status!, body: gateBody };
  }

  // Get source PDF bytes: `pdf_base64` was decoded + size-guarded above; the
  // `pdf_url` path fetches server-side here (the documented large-doc escape),
  // under the F-16.7 SSRF guard (resolved-host + no-redirect + time + size). A
  // blocked/failed fetch is a clean named 400, never a 500 or an internal echo.
  if (!sourceBytes) {
    try {
      sourceBytes = await (ctx.fetchPdf ?? fetchPdfFromUrl)(req.pdf_url!);
    } catch (e) {
      if (e instanceof PdfUrlError) {
        return { status: 400, body: { error: e.message, code: 'validation_pdf_url' } };
      }
      throw e;
    }
  }

  // F-3.5 / AC-7 — size guard: reject an oversize envelope at creation (with the
  // math) BEFORE any assembly/DB work. The estimator is config-driven; the
  // Phase-2 spike tunes its constants.
  const sizeEst = estimateBundleSize(
    sourceBytes.length,
    req.signers.length,
    ctx.bundleSizeCeilingBytes ? { ceilingBytes: ctx.bundleSizeCeilingBytes } : {},
  );
  if (!sizeEst.ok) {
    return {
      status: 413,
      body: {
        error: sizeRejectionMessage(sizeEst),
        code: 'rate_size_bundle',
        document_bytes: sizeEst.documentBytes,
        signer_count: sizeEst.signerCount,
        estimated_bundle_bytes: sizeEst.estimatedBundleBytes,
        ceiling_bytes: sizeEst.ceilingBytes,
      },
    };
  }

  // F-017 / AC-140 / AC-137 — a fetched/decoded blob that is NOT a parseable PDF
  // (a `pdf_url` pointing at a README, or a non-PDF `pdf_base64`) must be a clean,
  // taxonomy-coded 400, never the uncoded 500 that `PDFDocument.load` throws deep
  // in per-signer assembly. Both input paths converge on `sourceBytes` here — after
  // the cheap size guard, before any assembly / DB write. NOT an SSRF concern (the
  // F-16.7 guard already refused private/loopback/redirecting hosts above).
  if (!(await isPdfParseable(sourceBytes))) {
    return req.pdf_base64
      ? { status: 400, body: { error: 'pdf_base64 did not contain a valid PDF.', code: 'validation_pdf' } }
      : { status: 400, body: { error: 'pdf_url did not return a valid PDF.', code: 'validation_pdf_url' } };
  }

  // F-3.3 / F-4 — assemble the canonical envelope PDF: page 1 = kysigned cover
  // page (ESIGN/UETA/eIDAS consent + the underlying-document SHA-256); pages
  // 2..N = the creator's source. The envelope `docHash` is SHA-256 of the
  // canonical PDF — NOT of the raw source. The pre-assembly source is consumed
  // in assembly and NOT separately stored; the creator retains their own copy.
  //
  // Pre-generate envelopeId so it can be baked into the cover. The canonical
  // PDF is ONE-per-envelope (signer identity lives in the email body only, not
  // on the cover) — no per-signer assembly here (F-3.4).
  const envelopeId = randomUUID();
  const generatedAt = new Date();
  const operatorDomain = ctx.operatorDomain ?? 'kysigned.com';
  const spaDomain = ctx.spaDomain ?? new URL(ctx.baseUrl).hostname;
  const senderEmail = ctx.senderIdentity;

  // Family B (DD-9): the envelope's docHash is H_D = SHA-256 of the SHARED
  // uploaded document D — there is no single canonical PDF any more. D is stored
  // ONCE; each signer's per-signer canonical PDF P_i = cover_i ++ D is
  // regenerated deterministically (never stored), so the cover the signer signs
  // names them while the underlying document stays one shared, hashable object.
  const documentHash = computePdfHash(sourceBytes); // H_D

  const pdfKey = documentBlobKey(documentHash); // shared document D — read back via resolveDocumentKey at completion
  if (ctx.storePdf) {
    await ctx.storePdf(pdfKey, sourceBytes);
  }

  // Build each signer's own P_i = cover_i ++ D with its own sentPdfHash (the
  // per-signer return-what-we-sent target, F-6.4). Every cover cites the same
  // H_D so the verifier can prove all signers signed the same document (F-10.3).
  const perSigner = await Promise.all(
    req.signers.map(async (s) => {
      const { pdf, sentPdfHash, cover } = await buildSignerCanonicalPdf(
        {
          documentName: req.document_name,
          senderEmail,
          envelopeId,
          generatedAt,
          operatorDomain,
          spaDomain,
          sourceDocHash: documentHash, // H_D, cited on every cover
          signerName: s.name?.trim() || s.email,
          signerEmail: s.email,
          onBehalfOf: s.on_behalf_of?.trim() || undefined,
        },
        sourceBytes,
      );
      return { pdf, sentPdfHash, cover };
    }),
  );

  const expiryAt = req.expiry_days
    ? new Date(Date.now() + req.expiry_days * 24 * 60 * 60 * 1000)
    : undefined;

  const input: CreateEnvelopeInput = {
    // The creator identity is email-only (always sender_email).
    sender_email: ctx.senderIdentity,
    document_name: req.document_name,
    document_hash: documentHash, // H_D (shared document fingerprint)
    source_hash: documentHash, // == H_D — the shared document D's hash
    envelope_id: envelopeId, // pre-generated — same value baked into every cover.
    expiry_at: expiryAt,
    signers: req.signers.map((s, i) => ({ ...s, sent_pdf_hash: perSigner[i].sentPdfHash })),
  };

  const result = await createEnvelope(ctx.pool, input, ctx.baseUrl);

  // F-30.3 / AC-138 — arm the completion webhook: mint the signing secret and
  // store it with the URL. The RAW secret appears exactly once — in this create
  // response — as `callback_secret`; deliveries are signed with it.
  let callbackSecret: string | undefined;
  if (typeof req.callback_url === 'string') {
    callbackSecret = mintWebhookSecret();
    await setEnvelopeWebhook(ctx.pool, {
      envelopeId: result.envelope.id,
      url: req.callback_url,
      secret: callbackSecret,
    });
  }

  // F-3.7 — mark internal-test (set after create; no credit was/will be charged).
  if (isInternalTest) {
    await markEnvelopeInternalTest(ctx.pool, result.envelope.id);
  }

  // F-24.3 — persist the auto-close choice. The schema default is true, so only an
  // explicit opt-out into manual seal needs a write (keeps the create-INSERT layout
  // untouched).
  if (req.auto_close === false) {
    await setEnvelopeAutoClose(ctx.pool, result.envelope.id, false);
  }

  // Family B (F-8.1): persist each signer's cover so the completion bundle can
  // embed cover-<n>.pdf and the verifier can reconstruct P_i = cover_n ++ D
  // (F-10.3). Keyed by signing_token (stable, unique); result.signers is in
  // input order, so it index-matches perSigner.
  if (ctx.storePdf) {
    await Promise.all(
      result.signers.map((s, i) =>
        ctx.storePdf!(`envelopes/${documentHash}/cover-${s.signing_token}.pdf`, perSigner[i]!.cover),
      ),
    );
  }

  // Send signing request emails — every envelope is parallel: notify all signers.
  //
  // PER-SIGNER best-effort (2026-06-21 crash + ordering fix): a deliverability
  // rejection (suppressed/invalid recipient) marks that signer undeliverable
  // (F-9.8 synchronous path) and notifies the creator; a transient failure
  // leaves them pending (recoverable via reminder). A send problem NEVER aborts
  // a create that has already persisted the envelope — previously an uncaught
  // throw surfaced as an opaque "Internal function error" (500) AFTER the
  // envelope was written and a credit debited.
  const signersToNotify = result.signers;
  const delivered: string[] = [];
  const undeliverable: string[] = [];
  const failed: string[] = [];

  // F-PDF: PDF download link in the email points at the API origin (the
  // marketing project's Lambda) — not the SPA origin (app.example.com).
  // Under DD-66 ctx.baseUrl is the SPA origin where the signer's review page
  // lives; the API origin is the parent domain (kysigned.com). When pdfApiBaseUrl
  // is unset (forker default), fall back to ctx.baseUrl which works in the
  // single-domain deployment shape.
  const pdfApiBaseUrl = ctx.pdfApiBaseUrl ?? ctx.baseUrl;
  for (let i = 0; i < signersToNotify.length; i++) {
    const signer = signersToNotify[i]!;
    // Family B: this signer receives THEIR OWN P_i (cover_i ++ D) — index-matched
    // to perSigner (createEnvelope returns signers in input order).
    const signerPdf = perSigner[i]!.pdf;
    const email = templates.signingRequest({
      signerName: signer.name,
      signerEmail: signer.email,
      onBehalfOf: signer.on_behalf_of ?? undefined,
      senderName: ctx.senderIdentity,
      documentName: req.document_name,
      envelopeId: result.envelope.id,
      docHash: documentHash,
      reviewLink: `${ctx.baseUrl}/review/${result.envelope.id}/${signer.signing_token}`,
      pdfDownloadLink: `${pdfApiBaseUrl}/v1/envelope/${result.envelope.id}/${signer.signing_token}/pdf`,
      howItWorksLink: `${ctx.baseUrl}/how-it-works`,
      operatorDomain: ctx.operatorDomain ?? 'kysigned.com',
      signingEmail: ctx.signingEmail,
      // F22.8.1 — surfaces in the mismatch instruction's mailto link.
      senderEmail: ctx.senderIdentity,
      message: req.message,
    });
    try {
      await ctx.emailProvider.send({
        to: signer.email,
        ...email,
        // F-5.1 / AC-10 — the signer receives the canonical PDF attached so they
        // can forward it back; the forward's attachment IS what they sign.
        attachments: [{
          filename: `${req.document_name.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'document'}.pdf`,
          content: signerPdf,
          contentType: 'application/pdf',
        }],
        headers: unsubscribeHeader(ctx),
      });
      delivered.push(signer.email);
    } catch (err) {
      if (isUndeliverableRecipientError(err)) {
        // F-9.8 synchronous path: the address is suppressed/invalid → mark the
        // signer undeliverable + notify the creator, exactly as the async bounce
        // webhook would. Best-effort: the notice itself must never abort create.
        undeliverable.push(signer.email);
        try {
          await handleUndeliverableSigningRequest(
            {
              pool: ctx.pool,
              emailProvider: ctx.emailProvider,
              baseUrl: ctx.baseUrl,
              ...(ctx.operatorDomain ? { operatorDomain: ctx.operatorDomain } : {}),
            },
            result.envelope.id,
            signer.email,
          );
        } catch (notifyErr) {
          console.error(
            `F-9.8 undeliverable notice failed for ${signer.email} on ${result.envelope.id}: ${(notifyErr as Error).message}`,
          );
        }
      } else {
        // Transient/unknown (5xx, throttle, network): leave the signer PENDING so
        // a reminder/resend recovers it; surface it as a delivery warning.
        failed.push(signer.email);
        console.error(
          `Signing-request send failed (transient) for ${signer.email} on ${result.envelope.id}: ${(err as Error).message}`,
        );
        // F-9.9 / AC-124 — this ambiguous failure could be a MISCLASSIFIED permanent one
        // (the send was never accepted, so no `bounced` event will ever confirm it). Schedule
        // a deferred delivery backstop: if the window (default 24h) closes with the signer
        // still pending, the run marks it undeliverable + notifies the creator, so a
        // misclassified send can never leave a signer silently stuck. Best-effort.
        await scheduleDeliveryBackstop(ctx.createRun, result.envelope.id, signer.id, ctx.deliveryBackstop);
      }
    }
  }

  // F-29 / F-5.5 — schedule each still-pending signer's automated reminders (+3d/+7d)
  // as deferred durable runs (replaces the reminder-sweep cron). Skip the ones marked
  // undeliverable above (no inbox to nudge); the run re-checks live state at fire time,
  // so a later signature / void self-cancels. Best-effort inside scheduleSignerReminders.
  {
    const undeliverableSet = new Set(undeliverable.map((e) => e.toLowerCase()));
    for (const signer of signersToNotify) {
      if (undeliverableSet.has(signer.email.toLowerCase())) continue;
      await scheduleSignerReminders(ctx.createRun, result.envelope.id, signer);
    }
  }

  // F-29 / DD-16 — schedule the deferred expiry run at the envelope's deadline
  // (idempotency = envelope id). No deadline → no run. Best-effort (see helper).
  await scheduleEnvelopeExpiry(ctx.createRun, result.envelope.id, result.envelope.expiry_at);

  // F7.8 / Issue 10 / DD-96: send the CREATOR a creation-confirmation email with the
  // canonical PDF attached (their own copy from the start — kysigned doesn't retain it
  // long-term). The creator identity is email-only, so they always have an inbox.
  {
    const createdEmail = templates.envelopeCreated({
      documentName: req.document_name,
      envelopeId: result.envelope.id,
      signers: result.signers.map((s) => ({ name: s.name, email: s.email, status: 'pending' })),
      dashboardLink: `${ctx.baseUrl}/dashboard/envelope/${result.envelope.id}`,
      operatorDomain,
    });
    const safeName = req.document_name.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'document';
    // Best-effort: the envelope already exists, so a confirmation-send failure
    // must never fail the create (was an uncaught throw → opaque 500).
    try {
      await ctx.emailProvider.send({
        to: ctx.senderIdentity,
        ...createdEmail,
        // Family B: the creator's confirmation carries the shared document D (their
        // own copy for their records) — there is no single canonical PDF.
        attachments: [{ filename: `${safeName}.pdf`, content: sourceBytes, contentType: 'application/pdf' }],
        headers: unsubscribeHeader(ctx),
      });
    } catch (err) {
      console.error(
        `Creator-confirmation send failed for ${ctx.senderIdentity} on ${result.envelope.id}: ${(err as Error).message}`,
      );
    }
  }

  // F-13 — debit one FLAT envelope credit (F-13.1: $0.25, any signer count),
  // SKIPPED for internal-test envelopes (F-3.7). ORDERING FIX (2026-06-21):
  // charged LAST, after delivery has been ATTEMPTED — so a charge corresponds to
  // a fully-processed create, never a half-created/500'd one. The envelope
  // already exists, so a debit failure is logged for manual reconciliation and
  // never fails the request.
  if (!isInternalTest && ctx.senderGate?.deductCredit) {
    const deduction = await ctx.senderGate.deductCredit(
      ctx.senderIdentity,
      gate.cost,
      result.envelope.id,
    );
    if (!deduction.ok) {
      console.error(`Credit deduction failed for ${ctx.senderIdentity}: ${deduction.error}`);
    }
  }

  // SS.2 / DD-97 / F1.11: remember the CREATOR's OWN name (our customer's),
  // keyed by their login email, when they added themselves as a signer ("Will
  // you also sign?"). Saves only the creator's own name — never signer/recipient
  // data. Best-effort: a storage failure must NOT fail envelope creation, and
  // the live input is what gets saved (whatever the creator's row held at send).
  {
    const loginEmail = ctx.senderIdentity.trim().toLowerCase();
    const selfSigner = result.signers.find((s) => s.email && s.email.trim().toLowerCase() === loginEmail);
    if (selfSigner?.name) {
      try {
        await upsertCreatorName(ctx.pool, ctx.senderIdentity, selfSigner.name);
      } catch (err) {
        console.error(`Saving creator name failed for ${ctx.senderIdentity}: ${(err as Error).message}`);
      }
    }
  }

  // F16.10: auto-detect if this SOURCE upload already has envelopes.
  //
  // Family B (DD-9): document_hash is now H_D = SHA-256 of the shared document D
  // (== source_hash), identical for every envelope from the same upload, so
  // duplicate-detection/grouping matches on it directly.
  let suggestion: { has_existing_signatures: boolean; signed_count: number; total_count: number; missing_signers: Array<{ email: string; name: string }> } | undefined;
  const documents = await getDocumentsByOwner(ctx.pool, ctx.senderIdentity);
  const existingDoc = documents.find(d => d.documentHash === documentHash);
  if (existingDoc && existingDoc.envelopes.length > 1) {
    // This source upload already had previous envelopes — check for incomplete signers
    const incomplete = await getIncompleteSigners(ctx.pool, documentHash, ctx.senderIdentity);
    suggestion = {
      has_existing_signatures: existingDoc.signedCount > 0,
      signed_count: existingDoc.signedCount,
      total_count: existingDoc.totalSigners,
      missing_signers: incomplete,
    };
  }

  return {
    status: 201,
    body: {
      envelope_id: result.envelope.id,
      status: result.envelope.status,
      document_hash: documentHash,
      status_url: `${ctx.baseUrl}/v1/envelope/${result.envelope.id}`,
      verify_url: `${ctx.baseUrl}/verify/${result.envelope.id}`,
      // Per-signer links. `link` is the programmatic signer-token API base (agent-native:
      // GET /v1/sign/:id/:token/info + the POST-to-sign call) and 404s in a browser by design.
      // `review_link` (F-011) is the human, browser-openable page — the SAME URL the invite
      // email embeds — so a creator who copies a link out-of-band gives the signer a working URL.
      signing_links: result.signers.map((s) => ({
        email: s.email,
        name: s.name,
        link: s.signing_link,
        review_link: `${ctx.baseUrl}/review/${result.envelope.id}/${s.signing_token}`,
      })),
      spam_notice: 'If signers do not receive the email, ask them to check their spam folder.',
      // Per-signer send outcome (2026-06-21). `undeliverable`/`failed` let the UI
      // warn the creator instead of a misleading all-green "sent" banner.
      delivery: { delivered: delivered.length, undeliverable, failed },
      // F-30.3 — the webhook signing secret, shown EXACTLY ONCE (AC-138).
      ...(callbackSecret ? { callback_secret: callbackSecret } : {}),
      ...(suggestion ? { suggestion } : {}),
    },
  };
}

export async function handleGetEnvelope(
  ctx: { pool: DbPool; baseUrl: string },
  envelopeId: string,
  senderIdentity: string
) {
  const envelope = await getEnvelope(ctx.pool, envelopeId);
  // Creator-scoped: only the envelope's own creator may read its status + signer
  // list (the signer roster is PII). 404 (not 403) so the endpoint never confirms
  // an envelope exists to a non-owner who guesses an id.
  if (!envelope || envelope.sender_email !== senderIdentity) {
    return { status: 404, body: { error: 'Envelope not found', code: 'not_found' } };
  }

  const signers = await getEnvelopeSigners(ctx.pool, envelopeId);
  // F-11 — per-signer evidence join: surface the bundle signature-page facts
  // (provider domain+selector + the .eml hash) on the dashboard once a signer is
  // signed. One artifact row per signed signer, keyed by signer_email.
  const artifacts = await listEnvelopeSignatureArtifacts(ctx.pool, envelopeId);
  const evidenceByEmail = new Map(artifacts.map((a) => [a.signer_email.toLowerCase(), a]));

  return {
    status: 200,
    body: {
      id: envelope.id,
      document_name: envelope.document_name,
      document_hash: envelope.document_hash,
      status: envelope.status,
      // F-24 — the manual-seal toggle, so the dashboard knows whether the "Seal &
      // send" action applies (and can show/edit the choice while open).
      auto_close: envelope.auto_close,
      created_at: envelope.created_at,
      completed_at: envelope.completed_at,
      // F-9.1 — when the evidence bundle was distributed to every party (AC-51).
      completion_distributed_at: envelope.completion_distributed_at ?? null,
      expiry_at: envelope.expiry_at ?? null,
      pdf_deleted_at: envelope.pdf_deleted_at ?? null,
      signers: signers.map((s) => {
        const art = evidenceByEmail.get(s.email.toLowerCase());
        return {
          email: s.email,
          name: s.name,
          // F-22.2 — surfaced so the dashboard edit form can prefill the org.
          on_behalf_of: s.on_behalf_of,
          status: s.status,
          signing_method: s.signing_method,
          signed_at: s.signed_at,
          // F-9.8 / F-11.2 — non-null when the signing-request email hard-bounced
          // (the "undeliverable" signer badge).
          undeliverable_at: s.undeliverable_at ?? null,
          // F-12.3 / AC-125 — the machine-readable delivery state (pending/delivered/
          // undeliverable), distinct from the signing `status`. Surfaced verbatim by the
          // MCP status tool so an agent can tell a bounced invite from a normal pending.
          delivery_status: deliveryStatus(s),
          completion_email_provider_msg_id: s.completion_email_provider_msg_id ?? null,
          // F-11 — per-signer evidence (mirrors the bundle signature page); null
          // until the signer has signed and the artifact exists.
          signing_domain: art?.dkim_domain ?? null,
          signing_selector: art?.dkim_selector ?? null,
          eml_sha256: art?.sha256_eml ?? null,
        };
      }),
    },
  };
}

export async function handleVoidEnvelope(
  ctx: {
    pool: DbPool;
    emailProvider: EmailProvider;
    deletePdf?: (key: string) => Promise<void>;
    /** F3.3.8: operator domain for `notifications@<operatorDomain>` send-from. */
    operatorDomain?: string;
    /** F-9.7/AC-49 — credit seam; refundCredit is called when voiding unsigned. */
    senderGate?: SenderGateConfig;
  },
  envelopeId: string,
  senderIdentity: string
) {
  const envelope = await getEnvelope(ctx.pool, envelopeId);
  if (!envelope) return { status: 404, body: { error: 'Envelope not found', code: 'not_found' } };
  if (envelope.sender_email !== senderIdentity) {
    return { status: 403, body: { error: 'Not the envelope sender', code: 'auth_forbidden' } };
  }

  // F-015 / AC-137 — a void is only valid on an OPEN, still-active envelope.
  // Voiding an already-terminal envelope (voided / expired / completed) — or a
  // manual-seal all-signed `awaiting_seal` — must be a clean, taxonomy-coded 409,
  // NOT the uncoded 500 that `voidEnvelope`'s `WHERE status='active'` 0-row throw
  // (db/envelopes.ts) used to surface. Mirrors the signer-edit sibling's 409.
  // (Refusing an all-signed envelope is also consistent with the auto-close
  // all-signed refusal below — the signatures are collected either way.)
  if (envelope.status !== 'active') {
    return {
      status: 409,
      body: {
        error: `Envelope is ${envelope.status} and can no longer be voided.`,
        code: 'state_not_active',
      },
    };
  }

  // F-24.1 — an AUTO-close envelope that is all-signed WILL auto-distribute (the
  // completed bundle is on its way); cancelling would discard delivered signatures.
  // The dashboard greys the button; this guards the API for the brief window before
  // the completion cron flips the status. Manual-seal envelopes can still be voided.
  if (envelope.auto_close && envelope.status === 'active') {
    const sgnrs = await getEnvelopeSigners(ctx.pool, envelopeId);
    if (sgnrs.length > 0 && sgnrs.every((s) => s.status === 'signed')) {
      return {
        status: 409,
        body: { error: 'Everyone has signed — the completed bundle is on its way, so this envelope can no longer be cancelled.', code: 'state_completed' },
      };
    }
  }

  const voided = await voidEnvelope(ctx.pool, envelopeId);
  const pending = await getOutstandingSigners(ctx.pool, envelopeId);

  // F-9.7 / AC-49 — "Void & start a corrected copy": refund the envelope credit
  // when voided while FULLY unsigned (no value delivered yet). If any signer
  // already signed, no refund. The corrected copy is an independent new create.
  let refunded = false;
  if (ctx.senderGate?.refundCredit) {
    const signers = await getEnvelopeSigners(ctx.pool, envelopeId);
    const anySigned = signers.some((s) => s.status === 'signed');
    if (!anySigned) {
      const cost = ctx.senderGate.costUsdMicros ?? DEFAULT_ENVELOPE_COST_USD_MICROS;
      const r = await ctx.senderGate.refundCredit(senderIdentity, cost, envelopeId);
      refunded = r.ok;
    }
  }

  // F8.6 / F-013: drop the stored blobs immediately — no party will sign or
  // receive a completion email for a voided envelope, so there is no reason to
  // keep the document + covers on disk. We ALWAYS stamp `pdf_deleted_at` on void
  // (even with no storage adapter wired) — F8.6 is about the terminal-state
  // retention marker, not just calling delete(). Then we best-effort purge the
  // envelope's REAL blob keys (document D + every per-signer cover), derived from
  // document_hash + signing_token — NOT the always-null `pdf_storage_key` column
  // whose nullness silently no-oped this delete and leaked blobs forever (F-013).
  if (!envelope.pdf_deleted_at) {
    await markEnvelopePdfDeleted(ctx.pool, envelopeId, new Date());
    if (ctx.deletePdf) {
      const signers = await getEnvelopeSigners(ctx.pool, envelopeId);
      await purgeEnvelopeBlobs(ctx.pool, { deletePdf: ctx.deletePdf }, envelope, signers);
    }
  }

  const operatorDomain = ctx.operatorDomain ?? 'kysigned.com';
  for (const signer of pending) {
    // F-004: skip signers already known-undeliverable (no inbox to notify — mirrors
    // the create path's undeliverable handling) and make each send best-effort. A
    // suppressed / hard-bounced outstanding signer must NEVER turn a void into a 500:
    // the envelope is already voided + the credit refunded above, so a failed
    // courtesy notice is a warning, not an error.
    if (signer.undeliverable_at) continue;
    const email = templates.voidNotification({
      signerName: signer.name,
      senderName: senderIdentity,
      documentName: envelope.document_name,
      operatorDomain,
    });
    try {
      await ctx.emailProvider.send({ to: signer.email, ...email });
    } catch (err) {
      console.error(
        `Void notification send failed for ${signer.email} on ${envelopeId}: ${(err as Error).message}`,
      );
    }
  }

  return { status: 200, body: { id: voided.id, status: voided.status, refunded } };
}

/** Context for sending a reminder — shared by the manual remind (handleRemind) and
 *  the automated sweep (F-5.5). A reminder is a NUDGE with no attachment (it points
 *  the signer at the ORIGINAL request), so there is no PDF seam here. */
export interface ReminderSendCtx {
  pool: DbPool;
  emailProvider: EmailProvider;
  baseUrl: string;
  operatorDomain?: string;
  signingEmail?: string;
  /** F-19 / AC-39 — operator-configured List-Unsubscribe contact (see unsubscribeHeader). */
  unsubscribeMailto?: string;
}

/**
 * F-5.5 — build + send ONE reminder to a pending signer and bump its reminder
 * counters. Shared by the manual remind (handleRemind, sender = the authed caller)
 * and the automated sweep (runReminderSweep, sender = the envelope creator). Sends
 * BEFORE bumping the counter so a crash in between leaves the signer due (at-least-
 * once), never falsely marked as reminded.
 */
export async function remindSigner(
  ctx: ReminderSendCtx,
  envelope: Envelope,
  signer: EnvelopeSigner,
  senderName: string,
): Promise<void> {
  const email = templates.reminder({
    signerName: signer.name,
    senderName,
    documentName: envelope.document_name,
    envelopeId: envelope.id,
    reviewLink: `${ctx.baseUrl}/review/${envelope.id}/${signer.signing_token}`,
    howItWorksLink: `${ctx.baseUrl}/how-it-works`,
    operatorDomain: ctx.operatorDomain ?? 'kysigned.com',
    signingEmail: ctx.signingEmail,
    reminderNumber: signer.reminder_count + 1,
  });
  await ctx.emailProvider.send({
    to: signer.email,
    ...email,
    headers: unsubscribeHeader(ctx),
  });
  await updateSignerReminder(ctx.pool, signer.id);
}

export async function handleRemind(
  ctx: ReminderSendCtx,
  envelopeId: string,
  senderIdentity: string
) {
  const envelope = await getEnvelope(ctx.pool, envelopeId);
  if (!envelope) return { status: 404, body: { error: 'Envelope not found', code: 'not_found' } };
  // Creator-scoped: only the envelope's creator may trigger reminders (else a
  // session-authed stranger could spam another envelope's signers by id).
  if (envelope.sender_email !== senderIdentity) {
    return { status: 403, body: { error: 'Not the envelope sender', code: 'auth_forbidden' } };
  }
  // Reminders apply while the envelope is OPEN (active OR awaiting_seal) — matches
  // the dashboard, which shows "Send reminders" whenever it's open + not all-signed
  // (e.g. a signed signer was superseded → must re-sign). Only a frozen envelope
  // (completed / voided / expired) has nobody to nudge. (Barry QA: reminding an
  // awaiting_seal envelope 400'd "Envelope is not active".)
  if (!isEnvelopeEditable(envelope.status)) {
    return { status: 400, body: { error: `Envelope is ${envelope.status} — reminders only apply while it's open`, code: 'validation_envelope_not_open' } };
  }

  const pending = await getOutstandingSigners(ctx.pool, envelopeId);
  let reminded = 0;
  for (const signer of pending) {
    await remindSigner(ctx, envelope, signer, senderIdentity);
    reminded++;
  }

  return { status: 200, body: { reminded, pending: pending.length } };
}

/**
 * F-9.8 / AC-50 — handle an undeliverable signing request (hard bounce). Marks
 * the signer `undeliverable` and notifies the creator so they can fix the
 * address via void-and-recreate. Called by the bounce-signal path (run402
 * webhook, wired in Phase 19). Idempotent: a re-fired bounce is a no-op.
 */
export async function handleUndeliverableSigningRequest(
  ctx: { pool: DbPool; emailProvider: EmailProvider; baseUrl: string; operatorDomain?: string },
  envelopeId: string,
  signerEmail: string,
): Promise<{ status: number; body: { marked: boolean } }> {
  const marked = await markSignerUndeliverable(ctx.pool, envelopeId, signerEmail);
  if (!marked) return { status: 200, body: { marked: false } };

  const envelope = await getEnvelope(ctx.pool, envelopeId);
  if (envelope?.sender_email) {
    const email = templates.signingRequestUndeliverable({
      senderName: envelope.sender_email,
      documentName: envelope.document_name,
      signerEmail,
      dashboardLink: `${ctx.baseUrl}/dashboard/envelope/${envelopeId}`,
      operatorDomain: ctx.operatorDomain ?? 'kysigned.com',
    });
    await ctx.emailProvider.send({ to: envelope.sender_email, ...email });
  }
  return { status: 200, body: { marked: true } };
}

export async function handleListEnvelopes(
  ctx: { pool: DbPool },
  senderIdentity: string
) {
  const envelopes = await getEnvelopesBySender(ctx.pool, senderIdentity);
  return {
    status: 200,
    body: envelopes.map((e) => ({
      id: e.id,
      document_name: e.document_name,
      status: e.status,
      created_at: e.created_at,
      completed_at: e.completed_at,
    })),
  };
}

/**
 * List documents grouped by hash with combined signer status (F16.7).
 * Backward-compatible: each document includes its constituent envelopes.
 */
export async function handleListDocuments(
  ctx: { pool: DbPool },
  senderIdentity: string
) {
  const documents = await getDocumentsByOwner(ctx.pool, senderIdentity);
  return {
    status: 200,
    body: documents.map((d) => ({
      documentHash: d.documentHash,
      documentName: d.documentName,
      totalSigners: d.totalSigners,
      signedCount: d.signedCount,
      envelopes: d.envelopes.map((e) => ({
        id: e.id,
        status: e.status,
        created_at: e.created_at,
        completed_at: e.completed_at,
      })),
    })),
  };
}

/**
 * DD-16: envelope expiration handler.
 *
 * Iterates every envelope that's past its `expiry_at`, transitions it to
 * `expired`, notifies the sender + all pending signers with a status
 * breakdown, and deletes the original PDF per F8.6 (same immediate-delete
 * rule as void). Designed to be invoked by the operator's private scheduled
 * Lambda on the same cron tick as `sweepRetention`.
 *
 * Positional args (not ApiContext) because this is a scheduled task with no
 * per-request sender identity — consistent with `sweepRetention`'s signature.
 *
 * Failures on individual envelopes are counted but do not abort the whole
 * sweep — the next run retries.
 */
export interface ExpirationStorage {
  deletePdf(key: string): Promise<void>;
}

/**
 * F-29 / DD-16 — notify all parties that an ALREADY-expired envelope lapsed, and
 * drop its original PDF (F8.6). The caller has already flipped the row to
 * `expired` — the hourly sweep via `getExpiredEnvelopes`, OR the deferred
 * `envelope_expire` run via `claimExpiredEnvelope`. Shared by both so the expiry
 * notice is byte-identical whichever path fired.
 */
export async function notifyEnvelopeExpired(
  pool: DbPool,
  envelope: Envelope,
  emailProvider: EmailProvider,
  storage?: ExpirationStorage,
  operatorDomain: string = 'kysigned.com',
): Promise<void> {
  const allSigners = await getEnvelopeSigners(pool, envelope.id);
  const signedSigners = allSigners.filter((s) => s.status === 'signed');
  const pendingSigners = allSigners.filter((s) => s.status === 'pending');

  const signedCount = signedSigners.length;
  const totalCount = allSigners.length;
  const signedNames = signedSigners.map((s) => s.name);
  const pendingNames = pendingSigners.map((s) => s.name);
  const senderName = envelope.sender_email ?? 'the sender';

  // Notify the sender via email.
  if (envelope.sender_email) {
    const senderMail = templates.envelopeExpired({
      recipientName: senderName,
      documentName: envelope.document_name,
      senderName,
      role: 'sender',
      signedCount,
      totalCount,
      signedNames,
      pendingNames,
      operatorDomain,
    });
    await emailProvider.send({ to: envelope.sender_email, ...senderMail });
  }

  // Notify every signer who didn't complete (already-signed signers got the
  // completion path when they signed, OR none since the envelope never completed).
  for (const signer of pendingSigners) {
    const signerMail = templates.envelopeExpired({
      recipientName: signer.name,
      documentName: envelope.document_name,
      senderName,
      role: 'signer',
      signedCount,
      totalCount,
      signedNames,
      pendingNames,
      operatorDomain,
    });
    await emailProvider.send({ to: signer.email, ...signerMail });
  }

  // F8.6 / F-013: drop the stored blobs immediately on expiration (same rule as
  // void — an expired envelope will never be signed). Stamp the retention marker
  // (idempotent) so the shared-document guard sees this envelope as purged, then
  // best-effort purge the REAL blob keys (document D + per-signer covers) derived
  // from document_hash + signing_token — NOT the always-null `pdf_storage_key`
  // whose nullness silently no-oped this delete and leaked blobs forever (F-013).
  await markEnvelopePdfDeleted(pool, envelope.id, new Date());
  if (storage) {
    await purgeEnvelopeBlobs(pool, storage, envelope, allSigners);
  }
}


/**
 * Resend to missing signers (F16.C) — creates a new envelope with the same
 * document hash and only the signers who haven't signed in any previous envelope.
 */
export async function handleResendToMissing(
  ctx: ApiContext,
  documentHash: string,
): Promise<{ status: number; body: any }> {
  const senderIdentity = ctx.senderIdentity;
  const incomplete = await getIncompleteSigners(ctx.pool, documentHash, senderIdentity);

  if (incomplete.length === 0) {
    return { status: 400, body: { error: 'No incomplete signers for this document', code: 'validation_no_incomplete_signers' } };
  }

  // Find document name from the first envelope with this hash
  const documents = await getDocumentsByOwner(ctx.pool, senderIdentity);
  // v0.19.x lookup tolerance — see handleGetDocumentPdf for context.
  const docGroup = documents.find(d =>
    d.documentHash === documentHash ||
    d.envelopes.some(e => e.document_hash === documentHash),
  );
  if (!docGroup) {
    return { status: 404, body: { error: 'Document not found', code: 'not_found' } };
  }

  // Create a new envelope with the same doc hash and only incomplete signers
  const input: CreateEnvelopeInput = {
    // The creator identity is email-only (always sender_email).
    sender_email: senderIdentity,
    document_name: docGroup.documentName,
    document_hash: documentHash,
    signers: incomplete.map(s => ({ email: s.email, name: s.name })),
  };

  const result = await createEnvelope(ctx.pool, input, ctx.baseUrl);

  // Send signing emails to the new signers
  const pdfApiBaseUrlResend = (ctx as { pdfApiBaseUrl?: string }).pdfApiBaseUrl ?? ctx.baseUrl;
  for (const signer of result.signers) {
    const signerEmail = templates.signingRequest({
      signerName: signer.name,
      signerEmail: signer.email,
      onBehalfOf: signer.on_behalf_of ?? undefined,
      senderName: senderIdentity,
      documentName: docGroup.documentName,
      docHash: documentHash,
      envelopeId: result.envelope.id,
      reviewLink: `${ctx.baseUrl}/review/${result.envelope.id}/${signer.signing_token}`,
      pdfDownloadLink: `${pdfApiBaseUrlResend}/v1/envelope/${result.envelope.id}/${signer.signing_token}/pdf`,
      howItWorksLink: `${ctx.baseUrl}/how-it-works`,
      operatorDomain: (ctx as { operatorDomain?: string }).operatorDomain ?? 'kysigned.com',
      signingEmail: (ctx as { signingEmail?: string }).signingEmail,
    });
    await ctx.emailProvider.send({ to: signer.email, ...signerEmail });
  }

  return {
    status: 201,
    body: {
      envelope_id: result.envelope.id,
      document_hash: documentHash,
      signers: result.signers.map(s => ({ email: s.email, name: s.name })),
    },
  };
}

// ── Recipient editing until seal (F-23 / DD-10) ─────────────────────────────
// While an envelope is OPEN (active or awaiting_seal), the creator edits the
// signer set in place: edit (regenerate P_i + resend), delete (cancellation +
// remove), add. Each signer is an independent package off the shared document D
// (DD-9), so editing one never disturbs another's binding. Changing an email is
// delete-old + add-new (F-23.4). Seal freezes the set (F-23.5 → 409). No credit
// is charged — the envelope was already paid for.

/**
 * Context for the recipient-editing handlers. Mirrors the seams
 * handleCreateEnvelope uses to build + store + email a per-signer P_i, minus the
 * credit gate. `getPdf` fetches the shared document D so an edited/added signer's
 * P_i = cover_i ++ D can be regenerated.
 */
export interface SignerEditCtx {
  pool: DbPool;
  /** F-29 — schedule an added signer's automated reminders as deferred durable runs. */
  createRun?: CreateRun;
  /** F-9.9 / AC-124 — the delivery-backstop window (run `delay`, e.g. `"24h"`); see ApiContext. */
  deliveryBackstop?: string;
  emailProvider: EmailProvider;
  baseUrl: string;
  pdfApiBaseUrl?: string;
  operatorDomain?: string;
  signingEmail?: string;
  /** F-19 / AC-39 — operator-configured List-Unsubscribe contact (see unsubscribeHeader). */
  unsubscribeMailto?: string;
  spaDomain?: string;
  storePdf?: (key: string, data: Uint8Array) => Promise<void>;
  deletePdf?: (key: string) => Promise<void>;
  getPdf?: (key: string) => Promise<Uint8Array | null>;
}

/**
 * F-23.5 — a signer set is editable only while the envelope is OPEN: `active`
 * (collecting signatures) or `awaiting_seal` (manual-mode review window, F-24.2).
 * Once sealed (`completed`) or terminal (`voided`/`expired`) the set is frozen.
 */
function isEnvelopeEditable(status: Envelope['status']): boolean {
  return status === 'active' || status === 'awaiting_seal';
}

interface SignerProvision {
  pdf: Uint8Array;
  sentPdfHash: string;
}

/**
 * Regenerate a signer's per-signer canonical PDF `P_i = cover_i ++ D` (DD-9) and
 * store its cover (keyed by signing_token, so the bundle can embed it and the
 * verifier can reconstruct P_i, F-10.3). Returns the P_i bytes (to attach) + its
 * SHA-256 (the F-6.4 return-what-we-sent target to persist).
 */
async function regenerateSignerPdf(
  ctx: SignerEditCtx,
  envelope: Envelope,
  s: { email: string; name: string; on_behalf_of: string | null; signing_token: string },
): Promise<SignerProvision> {
  if (!ctx.getPdf) throw new Error('regenerateSignerPdf: getPdf seam required to fetch the shared document D');
  const d = await ctx.getPdf(`envelopes/${envelope.document_hash}/document.pdf`);
  if (!d) throw new Error('regenerateSignerPdf: shared document D not found in storage');
  const operatorDomain = ctx.operatorDomain ?? 'kysigned.com';
  const spaDomain = ctx.spaDomain ?? new URL(ctx.baseUrl).hostname;
  const { pdf, sentPdfHash, cover } = await buildSignerCanonicalPdf(
    {
      documentName: envelope.document_name,
      senderEmail: envelope.sender_email,
      envelopeId: envelope.id,
      generatedAt: new Date(),
      operatorDomain,
      spaDomain,
      sourceDocHash: envelope.document_hash, // H_D, cited on every cover
      signerName: s.name?.trim() || s.email,
      signerEmail: s.email,
      onBehalfOf: s.on_behalf_of?.trim() || undefined,
    },
    d,
  );
  if (ctx.storePdf) {
    await ctx.storePdf(`envelopes/${envelope.document_hash}/cover-${s.signing_token}.pdf`, cover);
  }
  return { pdf, sentPdfHash };
}

/** Send a signing-request email carrying this signer's P_i as the attachment. */
async function sendSigningRequestEmail(
  ctx: SignerEditCtx,
  envelope: Envelope,
  s: { email: string; name: string; on_behalf_of: string | null; signing_token: string },
  pdf: Uint8Array,
  message?: string,
  /** Set on a RE-send after an edit → adds the "(updated …)" subject marker so it
   *  doesn't thread under the original request (F-23 / Barry QA). */
  revisedAt?: Date,
): Promise<void> {
  const pdfApiBaseUrl = ctx.pdfApiBaseUrl ?? ctx.baseUrl;
  const operatorDomain = ctx.operatorDomain ?? 'kysigned.com';
  const email = templates.signingRequest({
    signerName: s.name,
    signerEmail: s.email,
    onBehalfOf: s.on_behalf_of ?? undefined,
    senderName: envelope.sender_email,
    documentName: envelope.document_name,
    envelopeId: envelope.id,
    docHash: envelope.document_hash,
    reviewLink: `${ctx.baseUrl}/review/${envelope.id}/${s.signing_token}`,
    pdfDownloadLink: `${pdfApiBaseUrl}/v1/envelope/${envelope.id}/${s.signing_token}/pdf`,
    howItWorksLink: `${ctx.baseUrl}/how-it-works`,
    operatorDomain,
    signingEmail: ctx.signingEmail,
    senderEmail: envelope.sender_email,
    message,
    revisedAt,
  });
  const safeName = envelope.document_name.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'document';
  await ctx.emailProvider.send({
    to: s.email,
    ...email,
    attachments: [{ filename: `${safeName}.pdf`, content: pdf, contentType: 'application/pdf' }],
    headers: unsubscribeHeader(ctx),
  });
}

/** Shared add: pre-generate token → regenerate P_i + store cover → insert row →
 *  email the signing request. Used by handleAddSigner and the email-change path. */
async function addSignerCore(
  ctx: SignerEditCtx,
  envelope: Envelope,
  req: { email: string; name?: string; on_behalf_of?: string; verification_level?: 1 | 2 | 5; message?: string },
): Promise<EnvelopeSigner & { signing_link: string }> {
  const signing_token = randomBytes(32).toString('hex');
  const name = req.name?.trim() || req.email;
  const on_behalf_of = req.on_behalf_of?.trim() || null;
  const { pdf, sentPdfHash } = await regenerateSignerPdf(ctx, envelope, { email: req.email, name, on_behalf_of, signing_token });
  const row = await addSignerToEnvelope(
    ctx.pool,
    envelope.id,
    { email: req.email, name, on_behalf_of, verification_level: req.verification_level ?? 2, signing_token, sent_pdf_hash: sentPdfHash },
    ctx.baseUrl,
  );
  // Mirror the create-loop's send-failure resilience: the row is already inserted, so
  // a deliverability problem must NEVER fail the add/edit (previously an uncaught throw
  // → opaque 500 with a half-added signer). Permanent → mark undeliverable + notify the
  // creator (F-9.8); ambiguous/transient → schedule the delivery backstop so the signer
  // can't sit pending forever (F-9.9 / AC-124). Both best-effort.
  try {
    await sendSigningRequestEmail(ctx, envelope, row, pdf, req.message);
  } catch (err) {
    if (isUndeliverableRecipientError(err)) {
      try {
        await handleUndeliverableSigningRequest(
          {
            pool: ctx.pool,
            emailProvider: ctx.emailProvider,
            baseUrl: ctx.baseUrl,
            ...(ctx.operatorDomain ? { operatorDomain: ctx.operatorDomain } : {}),
          },
          envelope.id,
          row.email,
        );
      } catch (notifyErr) {
        console.error(
          `F-9.8 add-signer undeliverable notice failed for ${row.email} on ${envelope.id}: ${(notifyErr as Error).message}`,
        );
      }
    } else {
      console.error(
        `Add-signer send failed (transient) for ${row.email} on ${envelope.id}: ${(err as Error).message}`,
      );
      await scheduleDeliveryBackstop(ctx.createRun, envelope.id, row.id, ctx.deliveryBackstop);
    }
  }
  // F-29 — schedule the added signer's automated reminders (+3d/+7d) as deferred runs.
  await scheduleSignerReminders(ctx.createRun, envelope.id, row);
  return row;
}

/** Shared delete: drop the row → free the stored cover → (optionally) email the
 *  signer a cancellation. Used by handleDeleteSigner and the email-change path. */
async function deleteSignerCore(
  ctx: SignerEditCtx,
  envelope: Envelope,
  s: EnvelopeSigner,
  notify: boolean,
): Promise<void> {
  await deleteSigner(ctx.pool, s.id);
  if (ctx.deletePdf) {
    try {
      await ctx.deletePdf(`envelopes/${envelope.document_hash}/cover-${s.signing_token}.pdf`);
    } catch {
      // Fail-soft: the retention sweep frees orphaned covers on its next tick.
    }
  }
  if (notify) {
    const email = templates.signingRequestCancelled({
      signerName: s.name,
      senderName: envelope.sender_email,
      documentName: envelope.document_name,
      operatorDomain: ctx.operatorDomain ?? 'kysigned.com',
    });
    await ctx.emailProvider.send({ to: s.email, ...email });
  }
}

/** F-23.1 — add a signer to an open envelope (regenerate P_i + send). */
export async function handleAddSigner(
  ctx: SignerEditCtx,
  envelopeId: string,
  senderIdentity: string,
  req: { email: string; name?: string; on_behalf_of?: string; verification_level?: 1 | 2 | 5; message?: string },
): Promise<{ status: number; body: any }> {
  const envelope = await getEnvelope(ctx.pool, envelopeId);
  if (!envelope) return { status: 404, body: { error: 'Envelope not found', code: 'not_found' } };
  if (envelope.sender_email !== senderIdentity) return { status: 403, body: { error: 'Not the envelope sender', code: 'auth_forbidden' } };
  if (!isEnvelopeEditable(envelope.status)) {
    return { status: 409, body: { error: `Envelope is ${envelope.status} — the signer set is frozen (F-23.5)`, code: 'state_not_active' } };
  }
  if (!req.email || !req.email.includes('@')) {
    return { status: 400, body: { error: 'A valid signer email is required', code: 'validation_email' } };
  }

  const existing = await getEnvelopeSigners(ctx.pool, envelopeId);
  if (existing.some((s) => s.email.toLowerCase() === req.email.toLowerCase())) {
    return { status: 409, body: { error: 'That email is already a signer on this envelope', code: 'state_duplicate_signer' } };
  }
  if (existing.length >= MAX_SIGNERS_PER_ENVELOPE) {
    return { status: 400, body: { error: `An envelope can have at most ${MAX_SIGNERS_PER_ENVELOPE} signers.`, code: 'validation_signers' } };
  }
  // F-3.2a / AC-88 / AC-89 (#96) — the same signer-set validity rule that gates
  // creation runs wherever the set is submitted: the FULL resulting set (existing
  // signers + the added address) must carry no plus-alias and no two addresses on
  // one inbox. (The exact-dup case is already a 409 above; this also catches
  // aliases + gmail-dot / googlemail collisions the exact check misses.)
  const addIssue = checkSignerAddresses([
    ...existing.map((s) => ({ email: s.email, name: s.name, on_behalf_of: s.on_behalf_of ?? undefined })),
    { email: req.email, name: req.name, on_behalf_of: req.on_behalf_of },
  ]);
  if (addIssue) return { status: 400, body: { code: addIssue.code, error: addIssue.message } };

  // F-24.2 — adding a signer to an all-signed (`awaiting_seal`) envelope introduces a
  // new pending signer, so it's no longer "ready to seal" → revert it to active (Barry QA).
  if (envelope.status === 'awaiting_seal') {
    await reactivateAwaitingSeal(ctx.pool, envelopeId);
  }

  const row = await addSignerCore(ctx, envelope, req);
  return { status: 201, body: { email: row.email, name: row.name, status: row.status } };
}

/**
 * F-23.1 / F-23.2 / F-23.4 — edit a signer (name / on-behalf-of / personal
 * message): regenerate their P_i and resend. A previously-signed signer is
 * superseded (re-requested, prior signature dropped). A CHANGED email is
 * performed as delete-old (cancellation) + add-new (fresh request), never an
 * in-place rebind.
 */
export async function handleEditSigner(
  ctx: SignerEditCtx,
  envelopeId: string,
  senderIdentity: string,
  signerEmail: string,
  req: { name?: string; on_behalf_of?: string | null; message?: string; new_email?: string },
): Promise<{ status: number; body: any }> {
  const envelope = await getEnvelope(ctx.pool, envelopeId);
  if (!envelope) return { status: 404, body: { error: 'Envelope not found', code: 'not_found' } };
  if (envelope.sender_email !== senderIdentity) return { status: 403, body: { error: 'Not the envelope sender', code: 'auth_forbidden' } };
  if (!isEnvelopeEditable(envelope.status)) {
    return { status: 409, body: { error: `Envelope is ${envelope.status} — the signer set is frozen (F-23.5)`, code: 'state_not_active' } };
  }

  const current = await getSignerByEnvelopeAndEmail(ctx.pool, envelopeId, signerEmail);
  if (!current) return { status: 404, body: { error: 'Signer not found on this envelope', code: 'not_found' } };

  // F-24.2 — ANY edit de-completes an all-signed (`awaiting_seal`) envelope: a
  // signed signer is superseded, an email-change adds a pending signer. So it's no
  // longer "ready to seal" → revert it to `active` (the Seal button hides + "Send
  // reminders" returns until the re-requested signer signs and the cron re-parks it).
  // Without this the status badge wrongly stays "awaiting seal" at <all-signed (Barry QA).
  if (envelope.status === 'awaiting_seal') {
    await reactivateAwaitingSeal(ctx.pool, envelopeId);
  }

  // F-23.4 — changing an email is delete-old + add-new (an address is an
  // identity; it is never re-pointed under an existing package).
  const newEmail = req.new_email?.trim();
  if (newEmail && newEmail.toLowerCase() !== current.email.toLowerCase()) {
    const siblings = await getEnvelopeSigners(ctx.pool, envelopeId);
    if (siblings.some((s) => s.email.toLowerCase() === newEmail.toLowerCase())) {
      return { status: 409, body: { error: 'That email is already a signer on this envelope', code: 'state_duplicate_signer' } };
    }
    // F-3.2a (#96) — the new address must not be a plus-alias nor collapse to
    // another signer's inbox (excluding the one being replaced).
    const editIssue = checkSignerAddresses([
      ...siblings
        .filter((s) => s.email.toLowerCase() !== current.email.toLowerCase())
        .map((s) => ({ email: s.email, name: s.name, on_behalf_of: s.on_behalf_of ?? undefined })),
      {
        email: newEmail,
        name: req.name ?? current.name,
        on_behalf_of: (req.on_behalf_of === undefined ? current.on_behalf_of : req.on_behalf_of) ?? undefined,
      },
    ]);
    if (editIssue) return { status: 400, body: { code: editIssue.code, error: editIssue.message } };
    await deleteSignerCore(ctx, envelope, current, true); // cancellation to the old address
    const added = await addSignerCore(ctx, envelope, {
      email: newEmail,
      name: req.name ?? current.name,
      on_behalf_of: (req.on_behalf_of === undefined ? current.on_behalf_of : req.on_behalf_of) ?? undefined,
      message: req.message,
    });
    return { status: 200, body: { email: added.email, name: added.name, status: added.status, replaced: current.email } };
  }

  // In-place edit: regenerate P_i, resend. A previously-signed signer is
  // superseded (F-23.2); everyone else stays pending.
  const name = (req.name ?? current.name)?.trim() || current.email;
  const on_behalf_of =
    req.on_behalf_of === undefined ? current.on_behalf_of : (req.on_behalf_of?.trim() || null);
  const newStatus: 'pending' | 'superseded' = current.status === 'signed' ? 'superseded' : 'pending';
  // #101 — an in-place edit re-renders this signer's cover with the new name /
  // organisation; reject an unrenderable value up front (the email is unchanged,
  // already validated at creation). Same guard, checked at the submission point.
  const inPlaceIssue = checkSignerAddresses([
    { email: current.email, name, on_behalf_of: on_behalf_of ?? undefined },
  ]);
  if (inPlaceIssue) return { status: 400, body: { code: inPlaceIssue.code, error: inPlaceIssue.message } };
  const { pdf, sentPdfHash } = await regenerateSignerPdf(ctx, envelope, {
    email: current.email,
    name,
    on_behalf_of,
    signing_token: current.signing_token,
  });
  const updated = await updateSignerForEdit(ctx.pool, current.id, {
    name,
    on_behalf_of,
    sent_pdf_hash: sentPdfHash,
    status: newStatus,
  });
  await sendSigningRequestEmail(
    ctx,
    envelope,
    { email: updated.email, name: updated.name, on_behalf_of: updated.on_behalf_of, signing_token: updated.signing_token },
    pdf,
    req.message,
    new Date(), // re-send → "(updated …)" subject marker so it doesn't thread under the original
  );
  return { status: 200, body: { email: updated.email, name: updated.name, status: updated.status } };
}

/** F-23.3 — delete a signer from an open envelope + email them a cancellation. */
export async function handleDeleteSigner(
  ctx: SignerEditCtx,
  envelopeId: string,
  senderIdentity: string,
  signerEmail: string,
): Promise<{ status: number; body: any }> {
  const envelope = await getEnvelope(ctx.pool, envelopeId);
  if (!envelope) return { status: 404, body: { error: 'Envelope not found', code: 'not_found' } };
  if (envelope.sender_email !== senderIdentity) return { status: 403, body: { error: 'Not the envelope sender', code: 'auth_forbidden' } };
  if (!isEnvelopeEditable(envelope.status)) {
    return { status: 409, body: { error: `Envelope is ${envelope.status} — the signer set is frozen (F-23.5)`, code: 'state_not_active' } };
  }

  const current = await getSignerByEnvelopeAndEmail(ctx.pool, envelopeId, signerEmail);
  if (!current) return { status: 404, body: { error: 'Signer not found on this envelope', code: 'not_found' } };

  await deleteSignerCore(ctx, envelope, current, true);
  return { status: 200, body: { deleted: current.email } };
}
