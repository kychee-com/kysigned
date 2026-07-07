/**
 * Auto-close vs manual seal (F-24 / AC-74, AC-75).
 *
 * Auto-close (default true, F-24.1) distributes automatically on the last
 * signature — the existing completion backstop, now gated to `auto_close = true`
 * (`getEnvelopesNeedingCompletion`). Manual (F-24.2) instead:
 *   - `notifyEnvelopeAwaitingSeal` — emails the creator "all signed — review &
 *     seal" and parks the envelope in `awaiting_seal` (driven by the completion
 *     backstop cron over `getEnvelopesAwaitingSeal`);
 *   - `handleSealEnvelope` — the creator's "Seal & send" action: assemble +
 *     distribute the bundle EXACTLY ONCE (reusing `distributeEnvelopeBundle`'s
 *     `completion_distributed_at` gate) and freeze the envelope.
 *
 * Seal is the single irreversible close that freezes the envelope (F-23.5 /
 * F-24.3); after it, the recipient-editing handlers (F-23) reject with 409.
 */
import type { DbPool } from '../db/pool.js';
import { getEnvelope, getEnvelopeSigners, transitionToAwaitingSeal } from '../db/envelopes.js';
import { distributeEnvelopeBundle, type DistributeBundleDeps, type DistributeResult } from './distributeBundle.js';
import { templates } from '../email/templates.js';
import type { EmailProvider } from '../email/types.js';

/** The seam `notifyEnvelopeAwaitingSeal` needs — a structural subset of
 *  `DistributeBundleDeps`, so the cron can pass its `distributeDeps()` directly. */
export interface SealNotifyDeps {
  emailProvider: EmailProvider;
  operatorDomain: string;
  /** Dashboard apex (e.g. `https://kysigned.com`) — the "review & seal" deep link. */
  dashboardBaseUrl: string;
}

export type AwaitingSealAction =
  | 'notified' // creator emailed + envelope parked in awaiting_seal
  | 'skipped' // not an active, fully-signed manual envelope (already parked / not ready)
  | 'deferred'; // the notice send failed — left active for the next tick to retry

/**
 * F-24.2 — notify the creator a manual envelope is ready to seal, then park it in
 * `awaiting_seal`. Send-first / park-after = at-least-once: a send failure leaves
 * the envelope `active` for the next tick (a rare duplicate notice on retry is
 * acceptable). Idempotent: acts only on an `active`, fully-signed envelope, so a
 * re-run on an already-parked one sends nothing.
 */
export async function notifyEnvelopeAwaitingSeal(
  pool: DbPool,
  envelopeId: string,
  deps: SealNotifyDeps,
): Promise<{ envelopeId: string; action: AwaitingSealAction }> {
  const envelope = await getEnvelope(pool, envelopeId);
  if (!envelope || envelope.status !== 'active') return { envelopeId, action: 'skipped' };
  const signers = await getEnvelopeSigners(pool, envelopeId);
  if (signers.length === 0 || !signers.every((s) => s.status === 'signed')) {
    return { envelopeId, action: 'skipped' };
  }

  const t = templates.reviewAndSeal({
    recipientName: envelope.sender_email,
    documentName: envelope.document_name,
    signerCount: signers.length,
    dashboardLink: `${deps.dashboardBaseUrl.replace(/\/+$/, '')}/dashboard/envelope/${envelopeId}`,
    operatorDomain: deps.operatorDomain,
  });
  try {
    await deps.emailProvider.send({
      to: envelope.sender_email,
      subject: t.subject,
      html: t.html,
      text: t.text,
      from: t.from,
      replyTo: t.replyTo,
    });
  } catch {
    return { envelopeId, action: 'deferred' }; // stays active → retry next tick
  }
  await transitionToAwaitingSeal(pool, envelopeId);
  return { envelopeId, action: 'notified' };
}

/**
 * F-24.2 — the creator's "Seal & send signed envelope" action: assemble +
 * distribute the evidence bundle exactly once and freeze the envelope. Allowed
 * once every signer has signed (active-just-completed or `awaiting_seal`);
 * idempotent (an already-distributed envelope reports `already_sealed`).
 * Creator-scoped: 404 unknown, 403 non-owner.
 */
export async function handleSealEnvelope(
  pool: DbPool,
  envelopeId: string,
  senderIdentity: string,
  deps: DistributeBundleDeps,
): Promise<{ status: number; body: any }> {
  const envelope = await getEnvelope(pool, envelopeId);
  if (!envelope) return { status: 404, body: { error: 'Envelope not found', code: 'not_found' } };
  if (envelope.sender_email !== senderIdentity) return { status: 403, body: { error: 'Not the envelope sender', code: 'auth_forbidden' } };
  if (envelope.completion_distributed_at) {
    return { status: 200, body: { already_sealed: true, status: envelope.status } };
  }
  if (envelope.status === 'voided' || envelope.status === 'expired') {
    return { status: 409, body: { error: `Envelope is ${envelope.status} — it cannot be sealed`, code: 'state_not_active' } };
  }
  const signers = await getEnvelopeSigners(pool, envelopeId);
  if (signers.length === 0 || !signers.every((s) => s.status === 'signed')) {
    return { status: 409, body: { error: 'Not all signers have signed yet — the envelope cannot be sealed', code: 'state_not_all_signed' } };
  }

  const result: DistributeResult = await distributeEnvelopeBundle(pool, envelopeId, deps);
  return {
    status: 200,
    body: { sealed: true, action: result.action, recipients: result.recipients, sent: result.sent },
  };
}
