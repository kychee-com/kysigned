/**
 * server — the kysigned MCP server + its five ops tools, IMPORTABLE with no
 * side effects (no stdio start). The executable bin lives in `index.ts`; the
 * contract suite drives this module over an in-memory transport. Splitting the
 * importable server from the entrypoint is what lets the bin always start
 * stdio without an is-main guard (#126).
 *
 * Every tool:
 *   - fast-fails locally when KYSIGNED_AUTHORIZATION is missing (#122);
 *   - routes through the shared `apiRequest` helper → coded `isError` results
 *     on any API/transport failure (#119/#120), endpoint normalized (#123);
 *   - carries MCP annotations so hosts can tell reads from side-effecting and
 *     destructive actions (#124);
 *   - has an input schema in lockstep with the public API/docs (#121).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VERSION } from './version.js';
import { normalizeEndpoint, apiRequest, textResult, type McpToolResult } from './http.js';
import { getWalletStatus, defaultWalletSeams, X402RouteError, type WalletSeams } from './wallet.js';

/** The configured instance, normalized per call (env may change between calls in tests). */
export function getEndpoint(): string {
  return normalizeEndpoint(process.env.KYSIGNED_ENDPOINT);
}

function getAuth(): string | undefined {
  const a = process.env.KYSIGNED_AUTHORIZATION;
  return a && a.trim() ? a : undefined;
}

/** #122 — fail locally (with actionable guidance) instead of a wasted 401 round-trip. */
function requireAuth(): string | McpToolResult {
  const auth = getAuth();
  if (!auth) {
    return textResult(
      `Error: KYSIGNED_AUTHORIZATION is not set. Mint a creator API key at ${getEndpoint()}/account/api-keys ` +
        `and set KYSIGNED_AUTHORIZATION=ksk_… (the MCP sends it verbatim as the Authorization header).`,
      true,
    );
  }
  return auth;
}

export const server = new McpServer({ name: 'kysigned', version: VERSION });

const signerSchema = z.object({
  email: z.string().email().describe('Signer email address'),
  name: z.string().describe('Signer display name'),
});

// ── create_envelope (side-effecting: emails signers, consumes credits) ───────
server.registerTool(
  'create_envelope',
  {
    description:
      'Create a new signing envelope. Sends a PDF to one or more signers (max 20); at completion every party receives a sealed evidence-bundle PDF. Provide EXACTLY ONE of pdf_base64 (≤ ~3 MB) or pdf_url (any size, fetched server-side). Consumes a creator credit and emails each signer.',
    inputSchema: {
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
      signers: z.array(signerSchema).min(1).max(20).describe('1–20 signers (email + display name)'),
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
    },
    annotations: { title: 'Create envelope', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (params) => {
    const auth = requireAuth();
    if (typeof auth !== 'string') return auth;
    // #121/#122 — cross-field validation the schema can't express: exactly one PDF source.
    const hasB64 = typeof params.pdf_base64 === 'string' && params.pdf_base64.length > 0;
    const hasUrl = typeof params.pdf_url === 'string' && params.pdf_url.length > 0;
    if (hasB64 === hasUrl) {
      return textResult('Error: provide exactly one of pdf_base64 or pdf_url.', true);
    }
    const r = await apiRequest(getEndpoint(), '/v1/envelope', { method: 'POST', auth, body: params });
    if (!r.ok) return r.result;
    const d = r.data;
    return textResult(
      JSON.stringify(
        {
          envelope_id: d['envelope_id'],
          status: d['status'],
          document_hash: d['document_hash'],
          status_url: d['status_url'],
          verify_url: d['verify_url'],
          signing_links: d['signing_links'],
        },
        null,
        2,
      ),
    );
  },
);

// ── check_envelope_status (read-only) ────────────────────────────────────────
server.registerTool(
  'check_envelope_status',
  {
    description:
      "Check a signing envelope: per-signer signing status and times, plus each signer's delivery_status (pending / delivered / undeliverable — whether the signing-request email reached them, distinct from whether they signed).",
    inputSchema: { envelope_id: z.string().min(1).describe('The envelope ID to check') },
    annotations: { title: 'Check envelope status', readOnlyHint: true, openWorldHint: true },
  },
  async ({ envelope_id }) => {
    const auth = requireAuth();
    if (typeof auth !== 'string') return auth;
    const r = await apiRequest(getEndpoint(), `/v1/envelope/${encodeURIComponent(envelope_id)}`, { auth });
    if (!r.ok) return r.result;
    return textResult(JSON.stringify(r.data, null, 2));
  },
);

// ── list_envelopes (read-only) ───────────────────────────────────────────────
server.registerTool(
  'list_envelopes',
  {
    description: "List the envelopes you (the authenticated creator) have sent, with each one's status.",
    inputSchema: {},
    annotations: { title: 'List envelopes', readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const auth = requireAuth();
    if (typeof auth !== 'string') return auth;
    const r = await apiRequest(getEndpoint(), '/v1/envelopes', { auth });
    if (!r.ok) return r.result;
    return textResult(JSON.stringify(r.data, null, 2));
  },
);

// ── send_reminder (side-effecting: emails pending signers) ───────────────────
server.registerTool(
  'send_reminder',
  {
    description: 'Send a reminder email to all pending signers on an envelope.',
    inputSchema: { envelope_id: z.string().min(1).describe('The envelope ID') },
    annotations: { title: 'Send reminder', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ envelope_id }) => {
    const auth = requireAuth();
    if (typeof auth !== 'string') return auth;
    const r = await apiRequest(getEndpoint(), `/v1/envelope/${encodeURIComponent(envelope_id)}/remind`, {
      method: 'POST',
      auth,
    });
    if (!r.ok) return r.result;
    return textResult(`Sent reminders to ${r.data['reminded']} pending signer(s).`);
  },
);

// ── wallet seams (F-30.5) — injectable for tests, real run402 stack otherwise ─
let walletSeamsOverride: WalletSeams | undefined;
/** TEST-ONLY: inject fake wallet seams (pass undefined to restore the real ones). */
export function setWalletSeamsForTests(seams?: WalletSeams): void {
  walletSeamsOverride = seams;
}
function walletSeams(): WalletSeams {
  return walletSeamsOverride ?? defaultWalletSeams();
}

/** Map wallet-path failures to the MCP error contract (`Error: <message>`). */
function walletError(err: unknown): McpToolResult {
  if (err instanceof X402RouteError) return textResult(`Error: ${err.message}`, true);
  return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
}

// ── wallet_status (read-only; part of the NO-KEY wallet-paid path, F-30.5) ───
server.registerTool(
  'wallet_status',
  {
    description:
      'Report the local run402 wallet\'s payment readiness for wallet-paid envelope creation: wallet address, ' +
      'network, asset, on-chain balance, the live per-envelope price (read from the x402 route\'s own challenge), ' +
      'and whether the balance covers it (with funding guidance when short). Read-only — never creates or spends. ' +
      'Needs no API key: the wallet-paid path works without KYSIGNED_AUTHORIZATION; the wallet is the host-local ' +
      'run402 allowance wallet (created by `run402 init`; its key is never a tool argument and never appears in output).',
    inputSchema: {},
    annotations: { title: 'Wallet status', readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const status = await getWalletStatus(getEndpoint(), walletSeams());
      return textResult(JSON.stringify(status, null, 2));
    } catch (err) {
      return walletError(err);
    }
  },
);

// ── void_envelope (destructive: cancels an active envelope, irreversible) ─────
server.registerTool(
  'void_envelope',
  {
    description: 'Void an active envelope. Cancels all pending signing requests and notifies signers. Irreversible.',
    inputSchema: { envelope_id: z.string().min(1).describe('The envelope ID to void') },
    annotations: { title: 'Void envelope', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ envelope_id }) => {
    const auth = requireAuth();
    if (typeof auth !== 'string') return auth;
    const r = await apiRequest(getEndpoint(), `/v1/envelope/${encodeURIComponent(envelope_id)}/void`, {
      method: 'POST',
      auth,
    });
    if (!r.ok) return r.result;
    return textResult(`Envelope ${r.data['id']} has been voided.`);
  },
);
