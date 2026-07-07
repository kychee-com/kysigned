/**
 * Email completion-webhook handlers — F8.6 / F-9.3 / F-013.
 *
 * run402 delivers each OUTBOUND completion-email `delivery` / `bounced` event on
 * the notifications mailbox as a durable function run (an EMAIL TRIGGER, see
 * deploy.ts). `handleCompletionDelivered` / `handleCompletionBounced` are those
 * run handlers: they read the event, resolve which completed envelope's signer it
 * belongs to, and flip the per-signer delivery / bounce timestamp that drives the
 * retention rules (shouldDeletePdf). Before F-013 these markers had NO live route
 * at all, so the "delete once everyone got their copy" happy path never fired.
 *
 * `markCompletionEmailDelivered` / `...Bounced` are the low-level column writes
 * (by envelope_id + lowercased email); `resolveCompletionSigner` maps a raw email
 * event back to (envelope_id, email). The blob-deletion GUARANTEE never depends on
 * these firing — the deferred completion_retention run + the daily retention_sweep
 * enforce the 30-day hard cap regardless — but they make the common case fast.
 */
import type { DbPool } from '../db/pool.js';

export async function markCompletionEmailDelivered(
  pool: DbPool,
  envelope_id: string,
  recipient_email: string,
  at: Date = new Date()
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE envelope_signers
     SET completion_email_delivered_at = $3
     WHERE envelope_id = $1 AND lower(email) = $2
     RETURNING id`,
    [envelope_id, recipient_email.trim().toLowerCase(), at]
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

export async function markCompletionEmailBounced(
  pool: DbPool,
  envelope_id: string,
  recipient_email: string,
  at: Date = new Date()
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE envelope_signers
     SET completion_email_bounced_at = $3
     WHERE envelope_id = $1 AND lower(email) = $2
     RETURNING id`,
    [envelope_id, recipient_email.trim().toLowerCase(), at]
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/** The fields kysigned reads from a run402 outbound-email event (`payload.event`
 *  canonical, or the payload root), tolerating snake_case + camelCase. */
interface CompletionEmailEvent {
  messageId?: string;
  toAddress?: string;
  bounceType?: string;
}
export function readCompletionEmailEvent(payload: Record<string, unknown>): CompletionEmailEvent {
  const ev = (payload.event ?? payload) as Record<string, unknown>;
  const data = (ev.data ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const val = ev[k] ?? data[k];
      if (typeof val === 'string' && val) return val;
    }
    return undefined;
  };
  const out: CompletionEmailEvent = {};
  const messageId = pick('message_id', 'messageId');
  const toAddress = pick('to_address', 'toAddress');
  const bounceType = pick('bounce_type', 'bounceType');
  if (messageId) out.messageId = messageId;
  if (toAddress) out.toAddress = toAddress;
  if (bounceType) out.bounceType = bounceType;
  return out;
}

/**
 * Map an outbound completion-email event to the (envelope_id, email) of the
 * signer it belongs to. Correlates by the run402 provider message id first (exact
 * — matched against the id we stored via markCompletionEmailSent), falling back to
 * the recipient address among still-unconfirmed completed envelopes (so it works
 * even if run402 reports a different id namespace). Scoped to `completed`
 * envelopes with a completion email actually sent + neither delivered nor bounced
 * yet, so a status email that ISN'T a completion notice (a reminder, an ack) never
 * false-matches. Returns null when nothing matches (a no-op, not an error).
 */
export async function resolveCompletionSigner(
  pool: DbPool,
  ev: { providerMsgId?: string; toAddress?: string },
): Promise<{ envelope_id: string; email: string } | null> {
  const msgId = ev.providerMsgId ?? '';
  const to = (ev.toAddress ?? '').trim().toLowerCase();
  if (!msgId && !to) return null;
  const result = await pool.query(
    `SELECT es.envelope_id, es.email
       FROM envelope_signers es
       JOIN envelopes e ON e.id = es.envelope_id
      WHERE e.status = 'completed'
        AND es.completion_email_provider_msg_id IS NOT NULL
        AND es.completion_email_delivered_at IS NULL
        AND es.completion_email_bounced_at IS NULL
        AND (es.completion_email_provider_msg_id = $1 OR lower(es.email) = $2)
      ORDER BY (es.completion_email_provider_msg_id = $1) DESC, e.completed_at ASC
      LIMIT 1`,
    [msgId, to],
  );
  const row = result.rows[0] as { envelope_id: string; email: string } | undefined;
  return row ?? null;
}

/**
 * F-9.3 / F-013 — the `completion_delivery` email-trigger run: a completion email
 * was delivered, so stamp that signer's completion_email_delivered_at (feeds the
 * "everyone got their copy → delete the blob" happy path). No-op if the event is
 * for a non-completion message.
 */
export async function handleCompletionDelivered(
  pool: DbPool,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { messageId, toAddress } = readCompletionEmailEvent(payload);
  const target = await resolveCompletionSigner(pool, { providerMsgId: messageId, toAddress });
  if (!target) return { action: 'no_match', ...(toAddress ? { toAddress } : {}) };
  const ok = await markCompletionEmailDelivered(pool, target.envelope_id, target.email);
  return { action: ok ? 'delivered' : 'noop', envelopeId: target.envelope_id };
}

/**
 * F-9.3 / F-013 — the `completion_bounced` email-trigger run: a completion email
 * PERMANENTLY bounced, so stamp completion_email_bounced_at (arms the 7-day bounce
 * fallback in shouldDeletePdf). A transient bounce may still deliver on an SES
 * retry, so it is ignored.
 */
export async function handleCompletionBounced(
  pool: DbPool,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { messageId, toAddress, bounceType } = readCompletionEmailEvent(payload);
  if (bounceType && bounceType !== 'Permanent') return { action: 'ignored_transient', bounceType };
  const target = await resolveCompletionSigner(pool, { providerMsgId: messageId, toAddress });
  if (!target) return { action: 'no_match', ...(toAddress ? { toAddress } : {}) };
  const ok = await markCompletionEmailBounced(pool, target.envelope_id, target.email);
  return { action: ok ? 'bounced' : 'noop', envelopeId: target.envelope_id };
}
