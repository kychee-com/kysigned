/**
 * signerApi — the signer's read-only endpoints (no account; per-signer token).
 *
 *   GET /v1/sign/:id/:token/info       → SigningInfo for the review page (F-5.3)
 *   GET /v1/envelope/:id/:token/pdf    → the canonical PDF, token-authed (F-PDF)
 *
 * The signer SIGNS by forwarding the email (F-6); these endpoints only let them
 * read the document + see status. The `:token` is the per-signer signing_token —
 * the only credential (no session). The PDF 410s once it's been retention-deleted
 * (F-9.3) — the durable copy is the evidence bundle in the inbox.
 */
import type { DbPool } from '../db/pool.js';
import { getSignerByToken, getEnvelope } from '../db/envelopes.js';
import { getPdfBlob } from '../db/pdfBlobs.js';
import { documentBlobKey } from '../pdf/documentKey.js';
import { assembleCanonicalPdf } from '../pdf/assembleCanonicalPdf.js';

/** Shape consumed by the SPA review page (frontend `SigningInfo`). */
export interface SigningInfo {
  envelope_id: string;
  document_name: string;
  document_hash: string;
  signer_name: string;
  signer_email: string;
  sender_email: string | null;
  verification_level: number;
  already_signed: boolean;
  status: string;
  pdf_deleted_at: string | null;
  completed_at: string | null;
  signing_email?: string;
}

export interface SignerApiCtx {
  pool: DbPool;
  /** Optional PDF fetch override (prod = blob store); defaults to getPdfBlob. */
  getPdf?: (key: string) => Promise<Uint8Array | null>;
  /** Exact mailbox address the signer should forward the signing email to. */
  signingEmail?: string;
}

export interface SignerInfoResult {
  status: number;
  body: SigningInfo | { error: string };
}

export async function handleSignerInfo(
  ctx: SignerApiCtx,
  envelopeId: string,
  token: string,
): Promise<SignerInfoResult> {
  const signer = await getSignerByToken(ctx.pool, token);
  if (!signer || signer.envelope_id !== envelopeId) {
    return { status: 404, body: { error: 'Signing request not found' } };
  }
  const envelope = await getEnvelope(ctx.pool, envelopeId);
  if (!envelope) return { status: 404, body: { error: 'Signing request not found' } };
  return {
    status: 200,
    body: {
      envelope_id: envelope.id,
      document_name: envelope.document_name,
      document_hash: envelope.document_hash,
      signer_name: signer.name,
      signer_email: signer.email,
      sender_email: envelope.sender_email,
      verification_level: signer.verification_level,
      already_signed: signer.status === 'signed',
      status: envelope.status,
      pdf_deleted_at: envelope.pdf_deleted_at ? envelope.pdf_deleted_at.toISOString() : null,
      completed_at: envelope.completed_at ? envelope.completed_at.toISOString() : null,
      ...(ctx.signingEmail ? { signing_email: ctx.signingEmail } : {}),
    },
  };
}

export interface SignerPdfResult {
  status: number;
  /** Present on 200 — the PDF bytes (the entry returns them as application/pdf). */
  bytes?: Uint8Array;
  contentType?: string;
  body?: { error: string };
}

export async function handleSignerPdf(
  ctx: SignerApiCtx,
  envelopeId: string,
  token: string,
): Promise<SignerPdfResult> {
  const signer = await getSignerByToken(ctx.pool, token);
  if (!signer || signer.envelope_id !== envelopeId) {
    return { status: 404, body: { error: 'Signing request not found' } };
  }
  const envelope = await getEnvelope(ctx.pool, envelopeId);
  if (!envelope) {
    return { status: 404, body: { error: 'Document not available' } };
  }
  if (envelope.pdf_deleted_at) {
    // F-9.3 ephemeral retention — the durable copy is the bundle in the inbox.
    return { status: 410, body: { error: 'This document is no longer stored on our servers.' } };
  }
  const fetchPdf = ctx.getPdf ?? ((k: string) => getPdfBlob(ctx.pool, k));
  // The shared document D is stored ONCE at create under documentBlobKey(H_D) =
  // `envelopes/<hash>/document.pdf`; `pdf_storage_key` is a normally-NULL override.
  const document = await fetchPdf(envelope.pdf_storage_key ?? documentBlobKey(envelope.document_hash));
  if (!document) return { status: 404, body: { error: 'Document not available' } };
  // F-3.2 / F-5.1 — the signer reviews EXACTLY what they sign: their per-signer
  // canonical P_i = cover_i ++ D, re-assembled from the STORED cover so it is
  // byte-identical to the bytes the signing-request email attached (the forward's
  // attachment IS the signature). Page 1 = their cover (their name + the legal
  // affirmations + the as-is clause); pages 2..N = the document. (GH#25 follow-up:
  // the review was showing the bare document, omitting the cover they actually sign.)
  const cover = await fetchPdf(`envelopes/${envelope.document_hash}/cover-${token}.pdf`);
  const bytes = cover ? await assembleCanonicalPdf(cover, document) : document;
  return { status: 200, bytes, contentType: 'application/pdf' };
}
