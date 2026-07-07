/**
 * webhookDeliver — completion-webhook enqueue + delivery (spec F-30.3 / AC-138).
 *
 * Delivery is a run402 durable run (`webhook_deliver`, enqueued next to the
 * retention run when the bundle distributes), so retries are platform-owned
 * at-least-once: a 5xx / network failure throws RetryableRunError and run402
 * re-fires per the run's policy; a 4xx means the receiver actively rejected
 * the delivery — retrying cannot help, so it is terminal. Every POST carries
 * the X-Kysigned-Signature header (webhookSignature.ts recipe).
 *
 * `validateCallbackUrl` guards the creator-supplied URL at CREATE time:
 * https only, and literal loopback/private/link-local hosts are rejected (the
 * server POSTs this URL — a plain-IP SSRF hole otherwise). DNS-rebinding
 * defense is documented out of scope for v1 (the URL's hostname is resolved
 * by fetch at delivery time).
 */
import type { DbPool } from '../db/pool.js';
import type { CreateRun } from '../functions/runs.js';
import { RetryableRunError, PermanentRunError } from '../functions/runs.js';
import { getEnvelopeWebhook } from '../db/envelopeWebhooks.js';
import { getEnvelope, getEnvelopeSigners } from '../db/envelopes.js';
import { buildSignatureHeader } from './webhookSignature.js';
import { validatePublicHttpsUrl } from '../net/urlGuard.js';

const DELIVERY_TIMEOUT_MS = 6_000; // F-6.9 hang-proofing convention

export type UrlVerdict = { ok: true } | { ok: false; reason: string };

/** callback_url guard — the shared F-16.7 literal-host + https check, phrased
 *  for the webhook field. (The pdf_url path additionally resolves the host;
 *  a webhook is delivered later so the same DNS check would be stale.) */
export function validateCallbackUrl(url: string): UrlVerdict {
  const v = validatePublicHttpsUrl(url);
  if (v.ok) return v;
  return { ok: false, reason: `callback_url ${v.reason}` };
}

/**
 * Enqueue the completion delivery as a durable run — called where the bundle
 * distribution succeeds (distributeBundle.ts, next to the retention run).
 * Best-effort: a scheduling failure must never fail the distribution itself.
 * Idempotency key is namespaced per the createRun rule.
 */
export async function scheduleCompletionWebhook(
  pool: DbPool,
  createRun: CreateRun,
  envelopeId: string,
): Promise<void> {
  try {
    const hook = await getEnvelopeWebhook(pool, envelopeId);
    if (!hook) return;
    await createRun({
      eventType: 'webhook_deliver',
      idempotencyKey: `webhook-completed:${envelopeId}`,
      payload: { envelopeId },
      retry: { preset: 'standard' },
    });
  } catch {
    /* best-effort — the daily sweep story does not cover webhooks; a missed
       enqueue simply means no delivery, never a broken distribution */
  }
}

export interface DeliverOptions {
  fetchImpl?: typeof fetch;
  nowSeconds?: number;
  timeoutMs?: number;
}

/**
 * The `webhook_deliver` run body: build the envelope.completed payload, sign
 * it, POST it. Return = terminal; RetryableRunError = run402 retries.
 */
export async function deliverEnvelopeWebhook(
  pool: DbPool,
  envelopeId: string,
  opts: DeliverOptions = {},
): Promise<Record<string, unknown>> {
  const hook = await getEnvelopeWebhook(pool, envelopeId);
  if (!hook) return { action: 'no_webhook' };

  const envelope = await getEnvelope(pool, envelopeId);
  if (!envelope) return { action: 'gone' };
  const signers = await getEnvelopeSigners(pool, envelopeId);

  const body = JSON.stringify({
    type: 'envelope.completed',
    envelope_id: envelope.id,
    document_name: envelope.document_name,
    status: envelope.status,
    completed_at: envelope.completed_at,
    signers: signers.map((s) => ({
      email: s.email,
      name: s.name,
      status: s.status,
      signed_at: s.signed_at,
    })),
  });

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kysigned-Signature': buildSignatureHeader(hook.secret, body, now),
      },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DELIVERY_TIMEOUT_MS),
    });
  } catch (err) {
    // Network failure / timeout — transient; run402 retries (at-least-once).
    throw new RetryableRunError(
      `webhook_deliver ${envelopeId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status >= 200 && res.status < 300) {
    return { action: 'delivered', status: res.status };
  }
  if (res.status >= 500) {
    throw new RetryableRunError(`webhook_deliver ${envelopeId}: receiver ${res.status}`);
  }
  // 3xx/4xx — the receiver actively declined; retrying the same delivery cannot help.
  throw new PermanentRunError(`webhook_deliver ${envelopeId}: receiver rejected with ${res.status}`);
}
