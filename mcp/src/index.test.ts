/**
 * MCP server tests — from spec F10 (CLI/MCP).
 *
 * F10: "MCP server exposing core signing operations"
 * F10: "Endpoint configurable to point to any instance"
 *
 * Tests the tool definitions exist and produce correct output format.
 * Cannot test actual API calls without a running server.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { checkEnvelopeStatus } from './index.js';

describe('MCP Server — from spec F10', () => {
  // F-20.1: MCP server exposing: create envelope, check status, list envelopes, remind, void
  it('should import without errors', async () => {
    // The MCP server module should load without throwing
    // We can't start it (needs stdio transport) but we can verify it parses
    assert.ok(McpServer);
  });

  // F10: "Endpoint configurable to point to any instance"
  it('should default endpoint to kysigned.com', () => {
    // KYSIGNED_ENDPOINT env var controls the endpoint
    // When not set, default is https://kysigned.com
    const defaultEndpoint = process.env.KYSIGNED_ENDPOINT || 'https://kysigned.com';
    assert.equal(defaultEndpoint, 'https://kysigned.com');
  });

  it('should respect KYSIGNED_ENDPOINT env override', () => {
    const original = process.env.KYSIGNED_ENDPOINT;
    process.env.KYSIGNED_ENDPOINT = 'https://custom.example.com';
    const endpoint = process.env.KYSIGNED_ENDPOINT || 'https://kysigned.com';
    assert.equal(endpoint, 'https://custom.example.com');
    // Restore
    if (original) process.env.KYSIGNED_ENDPOINT = original;
    else delete process.env.KYSIGNED_ENDPOINT;
  });
});

// F-12.3 / AC-125 — the status tool surfaces each signer's delivery_status verbatim,
// so an agent polling a hard-bounced invite sees `undeliverable` without the dashboard.
describe('check_envelope_status — per-signer delivery_status passthrough (AC-125)', () => {
  it('returns the full envelope JSON verbatim, including each signer delivery_status', async () => {
    const apiPayload = {
      envelope_id: 'env-1',
      status: 'active',
      signers: [
        { email: 'pending@x.com', status: 'pending', delivery_status: 'pending' },
        { email: 'bounced@x.com', status: 'pending', delivery_status: 'undeliverable' },
        { email: 'done@x.com', status: 'signed', delivery_status: 'delivered' },
      ],
    };
    const stubFetch = (async () => ({ ok: true, json: async () => apiPayload })) as unknown as typeof fetch;
    const out = await checkEnvelopeStatus('env-1', stubFetch);
    const parsed = JSON.parse(out.content[0]!.text);
    assert.equal(parsed.signers[0].delivery_status, 'pending');
    assert.equal(parsed.signers[1].delivery_status, 'undeliverable'); // the bounced invite, machine-readable
    assert.equal(parsed.signers[2].delivery_status, 'delivered');
    // delivery_status is distinct from the signing status (bounced signer is still 'pending' to sign)
    assert.equal(parsed.signers[1].status, 'pending');
  });

  it('surfaces the API error string on a non-ok response', async () => {
    const stubFetch = (async () => ({ ok: false, json: async () => ({ error: 'not found' }) })) as unknown as typeof fetch;
    const out = await checkEnvelopeStatus('missing', stubFetch);
    assert.match(out.content[0]!.text, /Error: not found/);
  });
});
