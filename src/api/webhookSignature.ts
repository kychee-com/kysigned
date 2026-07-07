/**
 * webhookSignature — signed callback_url deliveries (spec F-30.3 / AC-138).
 *
 * Scheme (the documented receiver recipe, Stripe-style):
 *   X-Kysigned-Signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, "<t>.<rawBody>")>
 *
 * The receiver recomputes the HMAC over `t + "." + rawBody` with the
 * envelope's `callback_secret` (returned once, in the create response),
 * compares constant-time, and rejects timestamps outside its tolerance
 * window (replay defense). The signature covers the timestamp AND the exact
 * raw bytes — any payload tampering or replay re-dating breaks it.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** Webhook-secret prefix (kysigned webhook secret) — greppable when leaked. */
export const WEBHOOK_SECRET_PREFIX = 'whs_';

const DEFAULT_TOLERANCE_SECONDS = 300;

/** 32 random bytes hex under the whs_ prefix — minted per envelope at create. */
export function mintWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + randomBytes(32).toString('hex');
}

/** hex hmac-sha256(secret, `${timestamp}.${body}`) — the v1 signature value. */
export function signWebhookPayload(secret: string, timestamp: number, body: string): string {
  return bytesToHex(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(`${timestamp}.${body}`)));
}

/** The full header value: `t=<ts>,v1=<sig>`. */
export function buildSignatureHeader(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${signWebhookPayload(secret, timestamp, body)}`;
}

export interface VerifyOptions {
  /** Receiver clock, unix seconds (defaults to Date.now()/1000). */
  nowSeconds?: number;
  /** Max |now - t| in seconds before the delivery is considered a replay. */
  toleranceSeconds?: number;
}

/**
 * The receiver recipe — also used by our own tests to prove every delivery
 * verifies. Returns false (never throws) on any malformed input.
 */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  opts: VerifyOptions = {},
): boolean {
  try {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header.trim());
    if (!m) return false;
    const t = Number(m[1]);
    const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
    const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    if (Math.abs(now - t) > tolerance) return false;
    const expected = signWebhookPayload(secret, t, body);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(m[2]!, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
