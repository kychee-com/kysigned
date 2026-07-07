/**
 * F8.12 — Creator canonical-PDF download.
 *
 * Session-authed, owner-checked fetch of the **canonical envelope PDF**
 * (cover page + content — byte-identical to what signers receive) for the
 * envelope creator (Sender). Distinct from the signer's token-authed path
 * (`handleGetEnvelopePdf`): the creator never receives the canonical PDF by
 * email (only signers do), so this gives them a way to fetch it. The canonical PDF
 * is a sign-request (cover ++ document), so a creator can confirm it on the
 * `/hashcheck` tool (F-25) against their original document.
 *
 * Pure + dependency-injected so the owner-check + retention logic is unit-
 * testable without a DB. Returns the SAME result shape as the signer PDF
 * handler so the router's 410-context handling is identical for both.
 *
 * Owner check (F8.12.1): the authenticated session email MUST equal the
 * envelope's `sender_email` — and it runs BEFORE the blob fetch, so a
 * non-owner never learns retention state. Retention (F8.12.2 / F8.6): a
 * deleted blob returns 410 Gone with the envelope-state context.
 */
import { documentBlobKey } from '../pdf/documentKey.js';

export interface EnvelopeRowForOwnerPdf {
  id: string;
  /** Envelope creator (Sender) email — the owner. */
  sender_email: string | null;
  document_name: string | null;
  document_hash: string;
  status: string;
  pdf_storage_key?: string | null;
  pdf_deleted_at?: string | null;
  completed_at?: string | null;
}

export interface OwnerPdfDeps {
  getEnvelope: (envelopeId: string) => Promise<EnvelopeRowForOwnerPdf | null>;
  getPdfBlob: (storageKey: string) => Promise<Uint8Array | null>;
}

export type OwnerPdfResult =
  | { ok: true; bytes: Uint8Array; filename: string }
  | { ok: false; status: number; code: string; error: string; context?: Record<string, unknown> };

export async function handleGetEnvelopePdfForOwner(
  deps: OwnerPdfDeps,
  envelopeId: string,
  authenticatedEmail: string | null | undefined,
): Promise<OwnerPdfResult> {
  if (!authenticatedEmail) {
    return { ok: false, status: 401, error: 'Authentication required', code: 'auth_required' };
  }

  const envelope = await deps.getEnvelope(envelopeId);
  if (!envelope) {
    return { ok: false, status: 404, error: 'Envelope not found', code: 'not_found' };
  }

  // F8.12.1 owner check — only the envelope creator may download, BEFORE any
  // blob fetch so a non-owner can't even probe retention state.
  if (
    !envelope.sender_email ||
    envelope.sender_email.toLowerCase() !== authenticatedEmail.toLowerCase()
  ) {
    return { ok: false, status: 403, error: 'Not authorized for this envelope', code: 'auth_forbidden' };
  }

  // The document is stored at create under documentBlobKey(H_D) =
  // `envelopes/<hash>/document.pdf`; pdf_storage_key is a normally-NULL override.
  // Use the shared helper — a hardcoded `original.pdf` 404s the owner download
  // (GH#25: the store moved to document.pdf, this reader was left stale).
  const storageKey =
    envelope.pdf_storage_key ?? documentBlobKey(envelope.document_hash);
  const bytes = await deps.getPdfBlob(storageKey);
  if (!bytes) {
    // F8.12.2 / F8.6 ephemeral retention: blob deleted (voided, expired, or
    // completed-and-delivered). Return 410 Gone with the same structured
    // envelope-state context as the signer path so the SPA renders a
    // meaningful "no longer stored" state.
    return {
      ok: false,
      status: 410,
      error: 'pdf_deleted',
      code: 'state_document_purged',
      context: {
        envelope_id: envelope.id,
        envelope_status: envelope.status,
        pdf_deleted_at: envelope.pdf_deleted_at,
        document_name: envelope.document_name,
        document_hash: envelope.document_hash,
        completed_at: envelope.completed_at,
      },
    };
  }

  const safeName = (envelope.document_name || 'document').replace(/[^a-zA-Z0-9._-]+/g, '_');
  return { ok: true, bytes, filename: `${safeName}.pdf` };
}
