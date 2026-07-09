/**
 * createPreflight — #129: validate a create body deterministically WITHOUT
 * charging or creating.
 *
 * On run402's tenant-x402 model the gateway settles the payment BEFORE our
 * function runs, so a paid `POST /v1/x402/envelope` that then fails app
 * validation (plus-alias signer, bad email, missing/oversize PDF) still
 * consumes the on-chain charge (it is banked as a recoverable credit, but the
 * agent paid). This endpoint lets a wallet agent check the same deterministic
 * validations for FREE first, and pay only once they pass. It reuses the exact
 * guards the create runs, so a preflight PASS means those checks will not
 * reject the paid create. (It does not run credit/gate/assembly — a create can
 * still fail on non-deterministic grounds, but not on these input checks.)
 */
import { checkSignerAddresses } from './signerInboxGuard.js';
import { isUploadTooLarge, uploadTooLargeMessage } from './uploadGuard.js';
import { decodePdfBase64 } from '../pdf/hash.js';
import { isPdfParseable } from '../pdf/validate.js';
import type { DbPool } from '../db/pool.js';

export interface PreflightResult {
  status: number;
  body: Record<string, unknown>;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function handleCreatePreflight(body: Record<string, unknown>, pool?: DbPool): Promise<PreflightResult> {
  // creator_email is OPTIONAL here (a keyed/session create supplies none); when
  // present it must be deliverable — same shape the x402 create requires.
  const rawEmail = body['creator_email'];
  let normalizedEmail = '';
  if (rawEmail !== undefined) {
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) {
      return { status: 400, body: { code: 'validation_creator_email', error: 'creator_email must be a deliverable address.' } };
    }
    normalizedEmail = email;
  }

  // AC-144 spending-intent replay lookup: the x402 rail is ALWAYS-priced at the
  // platform (settle-pre-invoke), so a client that simply re-sends a paid
  // create pays a SECOND time before the server can replay the stored envelope.
  // Given creator_email + the caller's intent key, a stored 201 under
  // `x402:idem:<key>` means this intent already produced an envelope — report
  // it (replay-first, mirroring withCreateIdempotency: even a now-different or
  // now-invalid retry payload must not trigger a new charge; the paid path
  // would 409 it, after taking the money).
  const rawIntent = body['idempotency_key'];
  const intentKey = typeof rawIntent === 'string' ? rawIntent.trim() : '';
  if (pool && intentKey && normalizedEmail) {
    const existing = await pool.query(
      `SELECT response_status, response_body
         FROM idempotency_keys
        WHERE creator_email = $1 AND idempotency_key = $2`,
      [normalizedEmail, `x402:idem:${intentKey}`],
    );
    const row = existing.rows[0] as { response_status: number | null; response_body: unknown } | undefined;
    if (row && row.response_status === 201) {
      // jsonb arrives as an object OR a serialized string (prod HttpDbPool
      // wire shape) — tolerate both, same as the replay in idempotentCreate.
      const envelope =
        typeof row.response_body === 'string' ? (JSON.parse(row.response_body) as unknown) : row.response_body;
      return { status: 200, body: { ok: true, already_created: true, envelope: envelope as Record<string, unknown> } };
    }
  }

  if (!body['pdf_base64'] && !body['pdf_url']) {
    return { status: 400, body: { code: 'validation_pdf', error: 'Provide pdf_base64 or pdf_url' } };
  }
  if (typeof body['document_name'] !== 'string' || body['document_name'].trim() === '') {
    return { status: 400, body: { code: 'validation_document_name', error: 'document_name is required (a non-empty string).' } };
  }
  const signers = body['signers'];
  if (!Array.isArray(signers) || signers.length === 0) {
    return { status: 400, body: { code: 'validation_signers', error: 'At least one signer required' } };
  }

  // The exact plus-alias / duplicate-inbox guard the create uses (the reported #129 case).
  const signerIssue = checkSignerAddresses(signers as Array<{ email: string; name?: string }>);
  if (signerIssue) {
    return { status: 400, body: { code: signerIssue.code, error: signerIssue.message } };
  }

  // For an inline PDF, run the same size + parseability guards (cheap, deterministic).
  // pdf_url is fetched server-side by the real create (SSRF-guarded) — not validated here.
  if (typeof body['pdf_base64'] === 'string' && body['pdf_base64']) {
    let bytes: Uint8Array;
    try {
      bytes = decodePdfBase64(body['pdf_base64']);
    } catch {
      return { status: 400, body: { code: 'validation_pdf', error: 'pdf_base64 is not valid base64.' } };
    }
    if (isUploadTooLarge(bytes.length)) {
      return { status: 400, body: { code: 'rate_size_pdf', error: uploadTooLargeMessage(bytes.length) } };
    }
    if (!(await isPdfParseable(bytes))) {
      return { status: 400, body: { code: 'validation_pdf', error: 'pdf_base64 is not a parseable PDF.' } };
    }
  }

  // With an intent key, say explicitly that no envelope exists for it yet —
  // the caller uses this to decide "safe to pay".
  return { status: 200, body: { ok: true, ...(intentKey ? { already_created: false } : {}) } };
}
