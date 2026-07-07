/**
 * Smoke-test helpers for the closed-loop email path — P4B.31.
 *
 * This is the "real-mail" test mechanism, intentionally separated from the
 * regression suite in `test/e2e/`:
 *
 *   - `test/e2e/*`      → **regression**, no real SES calls (bypass query
 *                          param swaps in a no-op EmailProvider). Runs on
 *                          every commit. Zero spam risk.
 *   - `test/e2e-smoke/*` → **smoke**, real SES calls but ONLY to the AWS SES
 *                          mailbox simulator. Gated on `KYSIGNED_E2E_SMOKE=1`
 *                          so CI never runs it by accident. Still no spam
 *                          because the simulator never delivers anywhere.
 *
 * How "closed loop" is achieved without real inbound mail:
 *
 * run402 mailboxes are outbound-only — `GET /mailboxes/v1/:id/messages`
 * returns rows where `direction = 'outbound'` and the body_text column
 * contains the full plaintext email that was sent (including the signing
 * link). So the test flow is:
 *
 *   1. Create an envelope with signer address
 *      `success+<tag>@simulator.amazonses.com` (SES accepts + silently
 *      drops — no human inbox involved).
 *   2. The kysigned API sends a signing-request email via SES. The send
 *      succeeds (simulator), a row is written to internal.email_messages
 *      with body_text containing the signing link.
 *   3. The test polls `GET /mailboxes/v1/<sender_mbx_id>/messages` until
 *      the row for this signer appears, extracts the signing link from
 *      body_text, and POSTs to /v1/sign to complete the flow.
 *
 * This is effectively "the test runner reads the sent email the same way
 * a human recipient would" — except the human recipient is the test
 * itself, not a real inbox. The operator can look at the logged body_text
 * to see exactly what real signers would receive.
 */
import { randomBytes } from 'node:crypto';

// --- Env ---

export const BASE_URL = (process.env['BASE_URL'] ?? 'https://api.run402.com/functions/v1/kysigned-api').replace(/\/$/, '');
export const ANON_KEY = process.env['KYSIGNED_E2E_ANON_KEY'] ?? '';
export const SERVICE_KEY = process.env['KYSIGNED_E2E_SERVICE_KEY'] ?? '';
export const MAILBOX_ID = process.env['KYSIGNED_E2E_MAILBOX_ID'] ?? '';
/**
 * `KYSIGNED_E2E_SMOKE=1` must be set for the smoke suite to run. Without it
 * the tests self-skip so CI can never accidentally fire real SES calls.
 */
export const SMOKE_ENABLED = process.env['KYSIGNED_E2E_SMOKE'] === '1';

// --- Signer builder ---

export interface SmokeSigner {
  email: string;
  name: string;
  verification_level: 1 | 2 | 5;
}

/**
 * Build a signer pointed at the AWS SES mailbox simulator. The `success`
 * inbox silently accepts + drops (no delivery, no bounce), perfect for
 * closed-loop smoke tests. Each seed gets a plus-addressed tag so runs
 * stay unique in the mailbox's outbound log.
 *
 * See: https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html#send-email-simulator
 */
export function smokeSigner(seed: string, tag: string = shortId()): SmokeSigner {
  return {
    email: `success+${seed}-${tag}@simulator.amazonses.com`,
    name: `${seed} ${tag.slice(0, 4)}`,
    verification_level: 1,
  };
}

export function shortId(): string {
  return randomBytes(6).toString('hex');
}

// --- HTTP ---

/** Headers used for the user-facing `/v1/*` routes (anon key). */
function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...(extra ?? {}) };
  if (ANON_KEY) h['apikey'] = ANON_KEY;
  return h;
}

/** Headers used for admin read of the mailbox outbound log (service_key). */
function adminHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

export async function apiPost<T = unknown>(
  path: string,
  body?: unknown
): Promise<ApiResponse<T>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: apiHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return parseResponse<T>(res);
}

export async function apiGet<T = unknown>(path: string): Promise<ApiResponse<T>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: apiHeaders(),
  });
  return parseResponse<T>(res);
}

async function parseResponse<T>(res: Response): Promise<ApiResponse<T>> {
  const ct = res.headers.get('content-type') ?? '';
  let body: unknown;
  if (ct.includes('application/json')) {
    body = await res.json().catch(() => ({}));
  } else {
    body = await res.text();
  }
  return { status: res.status, body: body as T };
}

// --- Mailbox polling ---

export interface MailboxMessage {
  message_id: string;
  mailbox_id: string;
  direction: string;
  template: string | null;
  to_address: string | null;
  from_address: string | null;
  subject: string | null;
  body_text: string | null;
  status: string;
  created_at: string;
}

interface ListMessagesResponse {
  messages: MailboxMessage[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * Poll `https://api.run402.com/mailboxes/v1/<mbxId>/messages` until a
 * message with the given `to_address` appears. Used to capture the signing
 * request email the Lambda just sent.
 */
export async function waitForOutboundByRecipient(
  mailboxId: string,
  toAddress: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<MailboxMessage> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const start = Date.now();
  const mailboxApiBase = process.env['KYSIGNED_E2E_MAILBOX_API_BASE'] ?? 'https://api.run402.com';
  const url = `${mailboxApiBase}/mailboxes/v1/${mailboxId}/messages?limit=50`;

  while (Date.now() - start < timeoutMs) {
    const res = await fetch(url, { headers: adminHeaders() });
    if (res.ok) {
      const data = (await res.json()) as ListMessagesResponse;
      const match = data.messages.find((m) => m.to_address === toAddress);
      if (match) return match;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitForOutboundByRecipient timed out after ${timeoutMs}ms waiting for to_address=${toAddress}`
  );
}

/**
 * Extract the first kysigned signing link from an email body.
 * Matches `https://<host>/v1/sign/<envelope>/<token>` where token can
 * contain hex chars only (signing tokens are 64 hex chars).
 */
export function extractSigningLink(body: string): { fullUrl: string; envelopeId: string; token: string } {
  // The plaintext body line looks like:
  //   Sign here: https://kysigned.com/v1/sign/<uuid>/<hex-token>
  const re = /(https?:\/\/[^\s]+\/v1\/sign\/([0-9a-f-]{36})\/([0-9a-f]{40,}))/i;
  const m = body.match(re);
  if (!m) throw new Error(`no signing link found in email body:\n${body.slice(0, 500)}`);
  return { fullUrl: m[1]!, envelopeId: m[2]!, token: m[3]! };
}

// --- Smoke gate ---

/**
 * Guard every smoke test with this at the top of its body. If
 * `KYSIGNED_E2E_SMOKE=1` is not set, the test self-skips. Required env
 * vars for the smoke path are validated here too.
 */
export function requireSmokeEnv(t: { skip: (msg?: string) => void }): void {
  if (!SMOKE_ENABLED) {
    t.skip(
      'KYSIGNED_E2E_SMOKE not set — smoke tests only run when explicitly enabled (sporadic, uses real SES to simulator inbox)'
    );
    return;
  }
  const missing: string[] = [];
  if (!ANON_KEY) missing.push('KYSIGNED_E2E_ANON_KEY');
  if (!SERVICE_KEY) missing.push('KYSIGNED_E2E_SERVICE_KEY');
  if (!MAILBOX_ID) missing.push('KYSIGNED_E2E_MAILBOX_ID');
  if (missing.length > 0) {
    t.skip(`smoke env incomplete — missing: ${missing.join(', ')}`);
  }
}
