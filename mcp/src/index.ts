#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const DEFAULT_ENDPOINT = 'https://kysigned.com';

const endpoint = process.env.KYSIGNED_ENDPOINT || DEFAULT_ENDPOINT;

/**
 * Build auth headers for outbound calls. Uses KYSIGNED_AUTHORIZATION
 * env var (API key or session token) if set.
 */
function authedHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = process.env.KYSIGNED_AUTHORIZATION;
  if (auth && auth.length > 0) {
    headers['Authorization'] = auth;
  }
  return headers;
}

/** Exported for the contract suite (driven over an in-memory transport). */
export const server = new McpServer({
  name: 'kysigned',
  version: '0.1.0',
});

// --- Tools ---

server.tool(
  'create_envelope',
  'Create a new signing envelope. Sends a PDF document to one or more signers (max 20); at completion every party receives a sealed evidence-bundle PDF. Provide the PDF as pdf_base64 (capped at ~3 MB) or pdf_url (any size, fetched server-side).',
  {
    document_name: z.string().describe('Human-readable name for the document'),
    pdf_base64: z.string().optional().describe('Base64-encoded PDF content. Capped at ~3 MB raw: the create call is invoked synchronously on Lambda and base64-in-body inflates a larger PDF past the 6 MiB invoke limit (the gateway returns a 502). For larger documents use pdf_url instead.'),
    pdf_url: z.string().optional().describe('URL the service fetches the PDF from server-side. Use this instead of pdf_base64 for documents over ~3 MB — it bypasses the request-body limit (still subject to the ~6.6 MB single-signer / 15 MiB assembled-bundle ceiling).'),
    signers: z.array(z.object({
      email: z.string().describe('Signer email address'),
      name: z.string().describe('Signer display name'),
    })).describe('List of signers'),
    callback_url: z.string().optional().describe('Webhook URL for completion notification'),
    message: z.string().optional().describe('Optional message to include in signing request email'),
  },
  async (params) => {
    const res = await fetch(`${endpoint}/v1/envelope`, {
      method: 'POST',
      headers: authedHeaders(),
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] };

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          envelope_id: data.envelope_id,
          status: data.status,
          document_hash: data.document_hash,
          status_url: data.status_url,
          verify_url: data.verify_url,
          signing_links: data.signing_links,
        }, null, 2),
      }],
    };
  }
);

/**
 * F-20 / F-12.3 / AC-125 — fetch an envelope's status and return it VERBATIM (the full
 * envelope JSON, so each signer's `delivery_status` — pending / delivered / undeliverable
 * — surfaces to the agent without a dashboard). Exported + fetch-injectable so the
 * passthrough shape is regression-testable without a running server.
 */
export async function checkEnvelopeStatus(
  envelopeId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const res = await fetchImpl(`${endpoint}/v1/envelope/${envelopeId}`, {
    headers: authedHeaders(),
  });
  const data = await res.json();
  if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] };
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

server.tool(
  'check_envelope_status',
  'Check the status of a signing envelope. Returns per-signer signing status and signing times, plus each signer\'s delivery_status (pending / delivered / undeliverable) — whether the signing-request email reached them, distinct from whether they have signed. An invite that hard-bounced reads undeliverable.',
  {
    envelope_id: z.string().describe('The envelope ID to check'),
  },
  async ({ envelope_id }) => checkEnvelopeStatus(envelope_id),
);

server.tool(
  'list_envelopes',
  "List the envelopes you (the authenticated creator) have sent, with each one's status.",
  {},
  async () => {
    // Session-scoped to the authed creator (KYSIGNED_AUTHORIZATION) — no email arg.
    const res = await fetch(`${endpoint}/v1/envelopes`, {
      headers: authedHeaders(),
    });
    const data = await res.json();
    if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] };

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      }],
    };
  }
);

// Verification is NOT an MCP tool in the evidence-bundle model (spec F-20.1):
// anyone verifies a completed bundle client-side at /verify or with the
// reference CLI verifier — no server/registry lookup. The chain verify_document
// / verify_envelope tools were carved in the pivot.

server.tool(
  'send_reminder',
  'Send a reminder to all pending signers on an envelope.',
  {
    envelope_id: z.string().describe('The envelope ID'),
  },
  async ({ envelope_id }) => {
    const res = await fetch(`${endpoint}/v1/envelope/${envelope_id}/remind`, {
      method: 'POST',
      headers: authedHeaders(),
    });
    const data = await res.json();
    if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] };

    return {
      content: [{
        type: 'text' as const,
        text: `Sent reminders to ${data.reminded} pending signer(s).`,
      }],
    };
  }
);

server.tool(
  'void_envelope',
  'Void an active envelope. Cancels all pending signing requests and notifies signers.',
  {
    envelope_id: z.string().describe('The envelope ID to void'),
  },
  async ({ envelope_id }) => {
    const res = await fetch(`${endpoint}/v1/envelope/${envelope_id}/void`, {
      method: 'POST',
      headers: authedHeaders(),
    });
    const data = await res.json();
    if (!res.ok) return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] };

    return {
      content: [{
        type: 'text' as const,
        text: `Envelope ${data.id} has been voided.`,
      }],
    };
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only start the stdio server when RUN directly (`npx kysigned-mcp`), not when this
// module is IMPORTED (e.g. by unit tests that exercise the exported tool functions).
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  main().catch((err) => {
    console.error('Failed to start kysigned MCP server:', err);
    process.exit(1);
  });
}
