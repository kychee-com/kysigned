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
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VERSION } from './version.js';
import { normalizeEndpoint, apiRequest, textResult, type McpToolResult } from './http.js';
import {
  getWalletStatus,
  fetchChallengeTerms,
  defaultWalletSeams,
  X402RouteError,
  X402_CREATE_PATH,
  type WalletSeams,
} from './wallet.js';

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

// ── create_envelope_x402 (PAYS REAL FUNDS from the local run402 wallet) ──────
server.registerTool(
  'create_envelope_x402',
  {
    description:
      'Create a signing envelope PAYING PER ENVELOPE from the local run402 wallet via x402 — no API key and no ' +
      'kysigned account needed (the payment itself establishes the creator record for creator_email). This tool ' +
      'SPENDS REAL FUNDS: it pays the operator\'s live per-envelope price (read from the x402 route\'s challenge; ' +
      'kysigned.com: $0.25 USDC on Base mainnet). Safety order: it first runs the FREE preflight validation, then ' +
      'checks the wallet balance, and only then pays — an invalid request or short balance never triggers a charge. ' +
      'Retries are safe: the spending-intent idempotency key (yours, or a generated one returned in the result) ' +
      'replays the same envelope without paying twice. The wallet is the host-local run402 allowance wallet ' +
      '(`run402 init`); its key is never a tool argument and never appears in output. On success the result carries ' +
      'the payment receipt and a tracking note (status links need creator auth — sign in later with creator_email).',
    inputSchema: {
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
      idempotency_key: z
        .string()
        .max(256)
        .optional()
        .describe(
          'Your spending-intent key: a retry with the same key replays the same envelope without paying twice. Omitted → one is generated and returned as spending_intent_key.',
        ),
    },
    // destructiveHint: paying real funds is irreversible — hosts gate
    // confirmation on destructive tools, which is exactly what AC-146 wants.
    annotations: { title: 'Create envelope (wallet-paid)', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async (params) => {
    try {
      const seams = walletSeams();
      // Exactly one PDF source — same local cross-field rule as create_envelope.
      const hasB64 = typeof params.pdf_base64 === 'string' && params.pdf_base64.length > 0;
      const hasUrl = typeof params.pdf_url === 'string' && params.pdf_url.length > 0;
      if (hasB64 === hasUrl) {
        return textResult('Error: provide exactly one of pdf_base64 or pdf_url.', true);
      }

      // 1) Wallet presence — fail with guidance before any network work.
      const address = await seams.readAllowanceAddress();
      if (!address) {
        const path = await seams.allowancePath();
        return textResult(
          `Error: no run402 wallet is configured (expected at ${path}). Run \`run402 init\` to create one, ` +
            `fund it, then retry — or use create_envelope with a KYSIGNED_AUTHORIZATION key instead.`,
          true,
        );
      }

      const endpoint = getEndpoint();
      const { idempotency_key, ...createBody } = params;

      // 2) FREE preflight — the create's own deterministic validation, before any charge (AC-142/AC-144).
      const pre = await seams.fetchFn(`${endpoint}/v1/envelope/preflight`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
      });
      if (pre.status !== 200) {
        const body = await pre.text();
        return textResult(`Error: preflight rejected the request (nothing was charged): ${body}`, true);
      }

      // 3) Readiness gate — challenge terms vs on-chain balance, before any charge (AC-145).
      const terms = await fetchChallengeTerms(endpoint, seams.fetchFn);
      const balance = await seams.readBalanceAtomic({ network: terms.network, asset: terms.asset, address });
      const price = BigInt(terms.amountAtomic);
      if (balance < price) {
        const assetLabel = terms.assetName ?? terms.asset;
        return textResult(
          `Error: insufficient wallet balance — nothing was charged. Send at least ${(price - balance).toString()} ` +
            `atomic units of ${assetLabel} on ${terms.network} to ${address} (one envelope costs ${terms.amountAtomic}` +
            (terms.amountUsdMicros !== undefined ? ` = $${(terms.amountUsdMicros / 1_000_000).toFixed(2)}` : '') +
            `; current balance ${balance.toString()}). Check readiness any time with wallet_status.`,
          true,
        );
      }

      // 4) The paid create — x402 challenge/pay/retry via the run402 stack (DD-30).
      const paidFetch = await seams.paidFetchFactory();
      if (!paidFetch) {
        return textResult(
          'Error: the x402 payment stack is unavailable (wallet unreadable or payment libraries missing) — cannot pay. ' +
            'Nothing was charged. Re-run `run402 init` or reinstall kysigned-mcp, then retry.',
          true,
        );
      }
      const intentKey = typeof idempotency_key === 'string' && idempotency_key.trim() ? idempotency_key.trim() : randomUUID();
      const res = await paidFetch(`${endpoint}${X402_CREATE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': intentKey },
        body: JSON.stringify(createBody),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

      if (res.status === 201) {
        return textResult(
          JSON.stringify(
            {
              envelope_id: data['envelope_id'],
              status: data['status'],
              document_hash: data['document_hash'],
              status_url: data['status_url'],
              verify_url: data['verify_url'],
              signing_links: data['signing_links'],
              payment: data['payment'],
              tracking: data['tracking'],
              spending_intent_key: intentKey,
            },
            null,
            2,
          ),
        );
      }
      // Non-201 paid outcomes pass through MACHINE-READABLY (banked credit,
      // payment_insufficient_funds, …) — deliberately richer than the ops
      // tools' human-message contract, because the agent must branch on these.
      return textResult(`Error: ${JSON.stringify({ http_status: res.status, ...data }, null, 2)}`, true);
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
