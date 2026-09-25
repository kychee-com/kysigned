/**
 * webPay — the web endpoint's paid create over the x402 MCP transport
 * (F-46.2, DD-74, DD-76). STUB (82.3 RED): registered with its real schema
 * and annotations so the tool list is complete; the behavior lands in 82.3.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult } from './http.js';

export interface WebPayDeps {
  origin: string;
  fetchFn: typeof fetch;
}

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

export function registerPaidTool(server: McpServer, _deps: WebPayDeps): void {
  server.registerTool(
    'create_envelope_x402',
    {
      description: PAID_CREATE_DESCRIPTION,
      inputSchema: PAID_CREATE_INPUT,
      annotations: { title: 'Create envelope (wallet-paid)', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async () => textResult('Error: not implemented', true),
  );
}
