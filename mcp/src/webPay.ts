/**
 * webPay — the web endpoint's paid create over the x402 MCP transport
 * (F-46.2, DD-74, DD-76).
 *
 * Unpaid call: the free preflight (the create's own deterministic validation,
 * AC-142) runs first, so an invalid request is never asked to pay; a spending
 * intent that already produced an envelope replays it; otherwise the tool
 * answers payment-required in the transport's shape, carrying exactly the
 * priced route's own challenge.
 *
 * Paid call (`_meta["x402/payment"]`): the preflight runs again, then the
 * caller's signed payload is relayed UNCHANGED to the existing always-priced
 * create route, where the platform verifies and settles it before the create
 * runs, exactly as for a direct x402 caller. kysigned never sees, holds or
 * signs with a key or a balance: this module contains no signing code.
 *
 * Retries never double-pay: the spending-intent key is the caller's
 * idempotency_key or one derived from the request (DD-76), so the unpaid call,
 * the paid retry and any identical repeat share one intent.
 */
import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, SettleResponse } from '@x402/core/types';
import { projectEnvelopeResult } from './envelopeResult.js';
import { fetchChallenge, X402RouteError, X402_CREATE_PATH } from './x402Challenge.js';
import { WEB_FACTS } from './webFacts.js';

export interface WebPayDeps {
  origin: string;
  fetchFn: typeof fetch;
}

/** The x402 MCP transport's metadata keys (the @x402/mcp reference). */
export const MCP_PAYMENT_META_KEY = 'x402/payment';
export const MCP_PAYMENT_RESPONSE_META_KEY = 'x402/payment-response';

const signerSchema = z.object({
  email: z.string().email().describe('Signer email address'),
  name: z.string().describe('Signer display name'),
});

/** The create inputs, identical to the local create_envelope_x402 (lockstep-tested). */
export const PAID_CREATE_INPUT = {
  creator_email: z
    .string()
    .email()
    .describe(
      'REQUIRED deliverable address that becomes the creator record: creation/completion mail and the evidence bundle land there, and signing in with it later (magic link) opens the dashboard for this envelope.',
    ),
  document_name: z.string().describe('Human-readable name for the document'),
  pdf_base64: z
    .string()
    .optional()
    .describe('Base64-encoded PDF, ≤ ~3 MB raw (synchronous-invoke body cap). For larger documents use pdf_url.'),
  pdf_url: z
    .string()
    .url()
    .optional()
    .describe('https URL the service fetches the PDF from server-side (the large-document escape).'),
  signers: z.array(signerSchema).min(1).max(20).describe('1 to 20 signers (email + display name)'),
  message: z.string().optional().describe('Optional message included in the signing-request email'),
  expiry_days: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Days until the envelope expires unsigned (omit for the operator default).'),
  callback_url: z
    .string()
    .url()
    .optional()
    .describe('https completion-webhook URL; the 201 returns callback_secret once for verifying deliveries.'),
  auto_close: z
    .boolean()
    .optional()
    .describe('false = manual seal (call seal after all signers sign) rather than auto-distribute.'),
  idempotency_key: z
    .string()
    .max(256)
    .optional()
    .describe(
      'Your spending-intent key: a retry with the same key replays the same envelope without paying twice. Omitted: derived from the request itself, so an identical request replays too; pass a new key for a second identical envelope.',
    ),
};

export const PAID_CREATE_DESCRIPTION =
  'Create a signing envelope and pay for it from YOUR OWN wallet over x402, with no account and no API key. ' +
  'This tool SPENDS REAL FUNDS: it charges this instance\'s live per-envelope price (see check_price). ' +
  'Call it once without payment: it validates the request for free and answers "payment required" with the exact terms. ' +
  'An x402-capable MCP client then signs the payment with your wallet and calls again with the payment attached ' +
  '(the x402 MCP transport, _meta "x402/payment"). kysigned never holds your keys or funds: it passes your signed ' +
  'payment to the platform, which settles it. Retries are safe: the same request (or the same idempotency_key) ' +
  'replays the first envelope instead of paying again. The result carries the payment receipt and a tracking token ' +
  '(ktt_...) that check_envelope_status accepts with no account.';

export interface PaidCreateParams {
  creator_email: string;
  document_name: string;
  pdf_base64?: string;
  pdf_url?: string;
  signers: Array<{ email: string; name: string }>;
  message?: string;
  expiry_days?: number;
  callback_url?: string;
  auto_close?: boolean;
  idempotency_key?: string;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The spending intent (DD-76): the caller's key, trimmed, or `mcpweb-` + the
 * SHA-256 of the request's canonical form. Case and spacing of email
 * addresses do not change it; the document's bytes (or URL), the signers and
 * every option do.
 */
export function deriveIntentKey(params: PaidCreateParams): string {
  const explicit = typeof params.idempotency_key === 'string' ? params.idempotency_key.trim() : '';
  if (explicit) return explicit;
  const pdf =
    typeof params.pdf_base64 === 'string' && params.pdf_base64.length > 0
      ? { sha256: sha256Hex(Buffer.from(params.pdf_base64, 'base64')) }
      : { url: params.pdf_url ?? null };
  const canonical = {
    v: 1,
    creator_email: params.creator_email.trim().toLowerCase(),
    document_name: params.document_name,
    pdf,
    signers: params.signers.map((s) => ({ email: s.email.trim().toLowerCase(), name: s.name })),
    message: params.message ?? null,
    expiry_days: params.expiry_days ?? null,
    callback_url: params.callback_url ?? null,
    auto_close: params.auto_close ?? null,
  };
  return `mcpweb-${sha256Hex(JSON.stringify(canonical))}`;
}

function errorResult(body: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${JSON.stringify(body, null, 2)}` }], isError: true };
}

/** The answer on an instance whose operator has not wired the priced route. */
export function x402NotEnabled(origin: string, detail: string): CallToolResult {
  return errorResult({
    code: 'x402_not_enabled',
    message: `This instance has no wallet-payable create: ${detail}`,
    alternatives: [
      `A creator API key: a person mints one at ${origin}${WEB_FACTS.apiKeysPath} and uses it with the local ${WEB_FACTS.localPackage} server (create_envelope).`,
      `See ${origin}/auth.md for every way in.`,
    ],
  });
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function isPaymentPayload(v: unknown): v is PaymentPayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o['x402Version'] === 'number' && !!o['payload'] && typeof o['payload'] === 'object';
}

function readSettlement(res: Response): SettleResponse | undefined {
  const header = res.headers.get('payment-response');
  if (!header) return undefined;
  try {
    return decodePaymentResponseHeader(header);
  } catch {
    return undefined;
  }
}

function priceLine(pr: PaymentRequired): string {
  const a = (pr.accepts.find((x) => x.scheme === 'exact') ?? pr.accepts[0]) as unknown as Record<string, unknown> | undefined;
  if (!a) return 'see check_price';
  const extra = (a['extra'] ?? {}) as Record<string, unknown>;
  const usd = typeof extra['amount_usd_micros'] === 'number' ? ` ($${((extra['amount_usd_micros'] as number) / 1_000_000).toFixed(2)})` : '';
  const asset = typeof extra['name'] === 'string' ? (extra['name'] as string) : String(a['asset']);
  return `${String(a['amount'])} atomic units${usd} of ${asset} on ${String(a['network'])} to ${String(a['payTo'])}`;
}

/** The transport's payment-required answer: the object itself, plus words for clients that cannot pay. */
function paymentRequiredResult(pr: PaymentRequired, intentKey: string, origin: string, lead: string): CallToolResult {
  const prose = [
    `${lead} Price: ${priceLine(pr)}.`,
    'This tool pays from your own wallet over x402: an x402-capable MCP client signs the payment and calls again with it attached (_meta "x402/payment").',
    `Spending intent: ${intentKey} (calling again with the same request replays instead of paying twice).`,
    'If your MCP client cannot pay:',
    `- run the local server on your own machine (npx -y ${WEB_FACTS.localPackage}): its create_envelope_x402 pays from a local run402 wallet;`,
    `- call POST ${origin}${X402_CREATE_PATH} with any x402 HTTP client;`,
    `- or have a person mint a creator API key at ${origin}${WEB_FACTS.apiKeysPath} and use create_envelope on the local server.`,
    'The live price is always available from check_price.',
  ].join('\n');
  return {
    content: [
      { type: 'text', text: JSON.stringify(pr) },
      { type: 'text', text: prose },
    ],
    structuredContent: pr as unknown as Record<string, unknown>,
    isError: true,
  };
}

function replayResult(envelope: unknown, intentKey: string): CallToolResult {
  const env = envelope && typeof envelope === 'object' ? (envelope as Record<string, unknown>) : {};
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            ...projectEnvelopeResult(env),
            replayed: true,
            spending_intent_key: intentKey,
            note: 'This spending intent already produced this envelope. Nothing was paid or created on this call.',
          },
          null,
          2,
        ),
      },
    ],
  };
}

export async function handlePaidCreate(
  params: PaidCreateParams,
  meta: Record<string, unknown> | undefined,
  deps: WebPayDeps,
): Promise<CallToolResult> {
  const { origin, fetchFn } = deps;
  const hasB64 = typeof params.pdf_base64 === 'string' && params.pdf_base64.length > 0;
  const hasUrl = typeof params.pdf_url === 'string' && params.pdf_url.length > 0;
  if (hasB64 === hasUrl) {
    return errorResult({ code: 'validation_failed', message: 'provide exactly one of pdf_base64 or pdf_url.' });
  }
  const intentKey = deriveIntentKey(params);
  const { idempotency_key: _omitted, ...createBody } = params;

  // 1) The free preflight, before any payment is requested or relayed.
  let pre: Response;
  try {
    pre = await fetchFn(`${origin}${WEB_FACTS.preflightPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...createBody, idempotency_key: intentKey }),
    });
  } catch (err) {
    return errorResult({
      code: 'service_unreachable',
      message: `Could not reach ${origin} to check the request; nothing was charged. (${err instanceof Error ? err.message : String(err)})`,
    });
  }
  const preText = await pre.text();
  const preBody = safeJson(preText);
  if (pre.status !== 200) {
    return errorResult({
      code: 'preflight_rejected',
      message: 'The free preflight rejected this request: nothing was charged and no payment was requested. Fix the request and call again.',
      http_status: pre.status,
      detail: preBody ?? preText.slice(0, 500),
    });
  }
  if (preBody?.['already_created'] === true) return replayResult(preBody['envelope'], intentKey);

  // 2) No payment attached: answer with the route's own terms.
  const payment = meta?.[MCP_PAYMENT_META_KEY];
  if (payment === undefined) {
    try {
      const { paymentRequired } = await fetchChallenge(origin, fetchFn);
      return paymentRequiredResult(paymentRequired, intentKey, origin, 'Payment required; nothing has been charged yet.');
    } catch (err) {
      if (err instanceof X402RouteError && err.kind === 'not_priced') return x402NotEnabled(origin, err.message);
      return errorResult({ code: 'price_unavailable', message: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!isPaymentPayload(payment)) {
    return errorResult({
      code: 'invalid_payment_payload',
      message: `_meta["${MCP_PAYMENT_META_KEY}"] must be an x402 PaymentPayload (x402Version and payload).`,
    });
  }

  // 3) Relay the caller's signed payload, unchanged, to the always-priced route.
  let res: Response;
  try {
    res = await fetchFn(`${origin}${X402_CREATE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': intentKey,
        'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payment),
      },
      body: JSON.stringify(createBody),
    });
  } catch (err) {
    return errorResult({
      code: 'service_unreachable',
      message:
        `Could not reach ${origin} to relay the payment, so it may or may not have settled. Call again with the same request ` +
        `(or idempotency_key ${intentKey}): the preflight replays the envelope if one was created, and nothing is paid twice.`,
      spending_intent_key: intentKey,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  const settlement = readSettlement(res);
  const withSettlement = (r: CallToolResult): CallToolResult =>
    settlement ? { ...r, _meta: { [MCP_PAYMENT_RESPONSE_META_KEY]: settlement } } : r;
  const data = safeJson(await res.text()) ?? {};

  if (res.status === 201) {
    return withSettlement({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { ...projectEnvelopeResult(data), payment: data['payment'], tracking: data['tracking'], spending_intent_key: intentKey },
            null,
            2,
          ),
        },
      ],
    });
  }
  if (res.status === 402 && !settlement) {
    // Refused before settlement (e.g. an expired or mismatched payment): the
    // route's fresh terms let an x402 client try again with a new payment.
    const header = res.headers.get('payment-required');
    if (header) {
      try {
        return paymentRequiredResult(decodePaymentRequiredHeader(header), intentKey, origin, 'The platform did not accept that payment, and nothing was settled.');
      } catch {
        /* fall through to the plain error */
      }
    }
    return errorResult({ code: 'payment_rejected', http_status: 402, message: 'The platform did not accept that payment; nothing was settled.', detail: data });
  }
  // Settled or otherwise final outcomes pass through machine-readably (a
  // banked credit, the platform's insufficient-funds code), never as a new
  // payment request, so no client pays twice.
  return withSettlement(errorResult({ http_status: res.status, ...data, spending_intent_key: intentKey }));
}

export function registerPaidTool(server: McpServer, deps: WebPayDeps): void {
  server.registerTool(
    'create_envelope_x402',
    {
      description: PAID_CREATE_DESCRIPTION,
      inputSchema: PAID_CREATE_INPUT,
      annotations: { title: 'Create envelope (wallet-paid)', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (params, extra) =>
      handlePaidCreate(params as PaidCreateParams, (extra as { _meta?: Record<string, unknown> })._meta, deps),
  );
}
