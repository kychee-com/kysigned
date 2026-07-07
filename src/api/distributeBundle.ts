/**
 * distributeEnvelopeBundle — F-9.1 / AC-4 / AC-24 (Phase 10, spec v0.4.0).
 *
 * When an envelope's last signer reaches `signed`, assemble the evidence bundle
 * (Phase 9) and email it — as an attachment — to EVERY party with a role-scoped
 * body: the creator gets a dashboard link, signers get none (AC-24). If the creator
 * is also a signer, they receive ONE email (the creator variant), deduped by email.
 *
 * **Idempotent + fail-proof + at-least-once.** Order is complete → assemble → send
 * → mark-distributed:
 *   - `completeEnvelopeForBundle` stamps a STABLE completed_at (re-runs don't move
 *     it, so the bundle + retention clock are stable).
 *   - each signer's send is guarded by `completion_email_provider_msg_id` (a
 *     re-run skips an already-emailed signer — no duplicate), and the msg id lets
 *     the SES webhook mark delivered/bounced (feeding F-9.3 retention).
 *   - `markCompletionDistributed` is stamped ONLY when every recipient was emailed;
 *     a partial failure leaves it NULL so the completion backstop
 *     (getEnvelopesNeedingCompletion) retries — never losing the bundle (a rare
 *     duplicate to the unguarded creator on retry is acceptable).
 *
 * The bundle bytes are produced by an injected `prepareBundle` seam (gather inputs
 * + assembleBundle); resolving the canonical PDF + raw `.eml`s from the blob /
 * run402 stores is Phase 14. Returning null = inputs not ready → deferred (retry).
 */
import type { DbPool } from '../db/pool.js';
import type { Envelope, EnvelopeSigner } from '../db/types.js';
import {
  getEnvelope,
  getEnvelopeSigners,
  completeEnvelopeForBundle,
  markCompletionEmailSent,
  markCompletionDistributed,
} from '../db/envelopes.js';
import { templates } from '../email/templates.js';
import type { EmailMessage, EmailProvider } from '../email/types.js';
import type { CreateRun } from '../functions/runs.js';
import { scheduleCompletionRetention, RETENTION_INITIAL_DELAY } from './retentionSchedule.js';

export interface PreparedBundle {
  bytes: Uint8Array;
  /** The F-8.2 fingerprint, printed in the completion email. */
  fingerprint: string;
}

export interface DistributeBundleDeps {
  emailProvider: EmailProvider;
  operatorDomain: string;
  /** Verifier apex (e.g. `https://kysigned.com`) — the email's verify URL. */
  verifierBaseUrl: string;
  /** Dashboard apex (e.g. `https://kysigned.com`) — the creator's dashboard link. */
  dashboardBaseUrl: string;
  /** Gather inputs + assemble the bundle. Null → inputs not ready (defer/retry). */
  prepareBundle: (envelope: Envelope, signers: EnvelopeSigner[]) => Promise<PreparedBundle | null>;
  /** F-9.3 / F-013 — schedule the ephemeral-retention run when distribution
   *  completes (deletes the stored document + covers once everyone has their copy,
   *  or at the 30-day cap). Optional — a fork without run402 leaves it unwired and
   *  relies on the daily retention_sweep backstop. */
  createRun?: CreateRun;
}

export type DistributeAction =
  | 'distributed' // every party emailed + marked distributed
  | 'already_distributed' // completion_distributed_at was already set
  | 'not_ready' // missing / not all signed yet
  | 'deferred' // bundle inputs not ready — retry next tick
  | 'partial'; // some sends failed — left undistributed for retry

export interface DistributeResult {
  envelopeId: string;
  action: DistributeAction;
  recipients: number;
  sent: number;
}

interface Recipient {
  email: string;
  name: string;
  role: 'creator' | 'signee';
  signerId?: string;
  /** Already emailed (provider msg id present) — skip on a retry. */
  alreadySent?: boolean;
}

/** Deduped party list: every signer + the creator, creator==signer merged (AC-24). */
function buildRecipients(envelope: Envelope, signers: EnvelopeSigner[]): Recipient[] {
  const byEmail = new Map<string, Recipient>();
  for (const s of signers) {
    byEmail.set(s.email.toLowerCase(), {
      email: s.email,
      name: s.name || s.email,
      role: 'signee',
      signerId: s.id,
      alreadySent: s.completion_email_provider_msg_id != null,
    });
  }
  const creatorEmail = envelope.sender_email;
  if (creatorEmail) {
    const key = creatorEmail.toLowerCase();
    const existing = byEmail.get(key);
    if (existing) {
      existing.role = 'creator'; // creator==signer → one email, creator variant + dashboard link
    } else {
      byEmail.set(key, { email: creatorEmail, name: creatorEmail, role: 'creator' });
    }
  }
  return [...byEmail.values()];
}

function bundleFilename(documentName: string): string {
  const base = documentName.replace(/[^A-Za-z0-9._ -]/g, '').replace(/\s+/g, '-').slice(0, 80) || 'document';
  return `${base}-evidence-bundle.pdf`;
}

export async function distributeEnvelopeBundle(
  pool: DbPool,
  envelopeId: string,
  deps: DistributeBundleDeps,
): Promise<DistributeResult> {
  const envelope = await getEnvelope(pool, envelopeId);
  if (!envelope) return { envelopeId, action: 'not_ready', recipients: 0, sent: 0 };
  if (envelope.completion_distributed_at) {
    return { envelopeId, action: 'already_distributed', recipients: 0, sent: 0 };
  }

  const signers = await getEnvelopeSigners(pool, envelopeId);
  if (signers.length === 0 || !signers.every((s) => s.status === 'signed')) {
    return { envelopeId, action: 'not_ready', recipients: 0, sent: 0 };
  }

  // Stamp a stable completion time first, then assemble against that envelope.
  const completed = await completeEnvelopeForBundle(pool, envelopeId);

  let prepared: PreparedBundle | null;
  try {
    prepared = await deps.prepareBundle(completed, signers);
  } catch {
    prepared = null;
  }
  if (!prepared) return { envelopeId, action: 'deferred', recipients: 0, sent: 0 };

  const recipients = buildRecipients(completed, signers);
  const verifyUrl = `${deps.verifierBaseUrl.replace(/\/+$/, '')}/verify`;
  const attachment: NonNullable<EmailMessage['attachments']>[number] = {
    filename: bundleFilename(completed.document_name),
    content: prepared.bytes,
    contentType: 'application/pdf',
  };

  let sent = 0;
  let allOk = true;
  for (const r of recipients) {
    if (r.alreadySent) {
      sent += 1; // counted as delivered on a prior pass — don't re-send
      continue;
    }
    const t = templates.completion({
      recipientName: r.name,
      documentName: completed.document_name,
      signerCount: signers.length,
      role: r.role,
      bundleFingerprint: prepared.fingerprint,
      verifyUrl,
      dashboardLink:
        r.role === 'creator'
          ? `${deps.dashboardBaseUrl.replace(/\/+$/, '')}/dashboard/envelope/${envelopeId}`
          : undefined,
      operatorDomain: deps.operatorDomain,
    });
    const message: EmailMessage = {
      to: r.email,
      subject: t.subject,
      html: t.html,
      text: t.text,
      from: t.from,
      replyTo: t.replyTo,
      attachments: [attachment],
    };
    try {
      const { messageId } = await deps.emailProvider.send(message);
      if (r.signerId) await markCompletionEmailSent(pool, r.signerId, messageId);
      sent += 1;
    } catch {
      allOk = false; // leave undistributed → backstop retries this recipient
    }
  }

  if (allOk) {
    await markCompletionDistributed(pool, envelopeId);
    // F-9.3 / F-013 — the bundle is now in every party's inbox; start the
    // ephemeral-retention chain so the stored document + covers are deleted once
    // delivery is confirmed (or at the 30-day cap). Best-effort — the daily
    // retention_sweep is the backstop if this scheduling misses.
    await scheduleCompletionRetention(deps.createRun, envelopeId, 1, RETENTION_INITIAL_DELAY);
    return { envelopeId, action: 'distributed', recipients: recipients.length, sent };
  }
  return { envelopeId, action: 'partial', recipients: recipients.length, sent };
}
