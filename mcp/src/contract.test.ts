/**
 * MCP contract suite — every tool's wire contract, pinned (Barry ask, 2026-07-09).
 *
 * Drives the REAL registered server over an in-memory MCP transport (no stdio,
 * no network): tool registration (names + input schemas), per-tool request
 * mapping (method, path, headers incl. verbatim Authorization passthrough,
 * body forwarding), response passthrough shapes, and the error contract
 * (`Error: <data.error>` — the human message, by design not the taxonomy code).
 * globalThis.fetch is stubbed + recorded; KYSIGNED_* env is set BEFORE the
 * dynamic import so the module-level endpoint binds to the test value.
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.KYSIGNED_ENDPOINT = 'https://contract.test';
process.env.KYSIGNED_AUTHORIZATION = 'ksk_contract_key';

const { server } = await import('./server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

// ── the real server over an in-memory pair ──────────────────────────────────
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'contract-suite', version: '0.0.0' });
await client.connect(clientTransport);
after(() => Promise.allSettled([client.close(), server.close()]));

// ── recording fetch stub ─────────────────────────────────────────────────────
interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: RecordedCall[] = [];
let queue: Array<{ status: number; body: unknown }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  calls.push({
    url: String(url),
    method: init?.method ?? 'GET',
    headers: { ...((init?.headers as Record<string, string>) ?? {}) },
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  });
  const next = queue.shift() ?? { status: 200, body: {} };
  return new Response(JSON.stringify(next.body), {
    status: next.status,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  calls = [];
  queue = [];
});

type ToolCall = { content: Array<{ type: string; text: string }>; isError?: boolean };
async function callToolFull(name: string, args: Record<string, unknown>): Promise<ToolCall> {
  return (await client.callTool({ name, arguments: args })) as ToolCall;
}
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  return (await callToolFull(name, args)).content[0]!.text;
}

describe('tool registration', () => {
  it('exposes the five key-authenticated ops tools + the wallet pair (F-30.5)', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        'check_envelope_status',
        'create_envelope',
        'create_envelope_x402',
        'list_envelopes',
        'send_reminder',
        'void_envelope',
        'wallet_status',
      ],
    );
  });

  it('create_envelope schema is in lockstep with the API/docs — #121 (document_name+signers required; expiry_days + auto_close present)', async () => {
    const { tools } = await client.listTools();
    const create = tools.find((t) => t.name === 'create_envelope')!;
    const schema = create.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    assert.deepEqual([...(schema.required ?? [])].sort(), ['document_name', 'signers']);
    // The previously-dropped documented fields must now be in the schema.
    for (const opt of ['pdf_base64', 'pdf_url', 'callback_url', 'message', 'expiry_days', 'auto_close']) {
      assert.ok(opt in schema.properties, `documented field ${opt} present in the schema`);
    }
  });

  it('the id-taking tools require envelope_id; list_envelopes takes no required args', async () => {
    const { tools } = await client.listTools();
    for (const name of ['check_envelope_status', 'send_reminder', 'void_envelope']) {
      const schema = tools.find((t) => t.name === name)!.inputSchema as { required?: string[] };
      assert.deepEqual(schema.required ?? [], ['envelope_id'], name);
    }
    const list = tools.find((t) => t.name === 'list_envelopes')!.inputSchema as { required?: string[] };
    assert.deepEqual(list.required ?? [], []);
  });

  it('#124 — tools carry annotations distinguishing reads, side-effects, and destructive actions', async () => {
    const { tools } = await client.listTools();
    const ann = (n: string) => (tools.find((t) => t.name === n) as { annotations?: Record<string, unknown> }).annotations ?? {};
    assert.equal(ann('check_envelope_status').readOnlyHint, true);
    assert.equal(ann('list_envelopes').readOnlyHint, true);
    assert.equal(ann('create_envelope').readOnlyHint, false);
    assert.equal(ann('send_reminder').readOnlyHint, false);
    assert.equal(ann('void_envelope').readOnlyHint, false);
    assert.equal(ann('void_envelope').destructiveHint, true, 'void is marked destructive');
  });
});

// #155 — a realistic one-time webhook secret: whs_ + 64 hex (webhookSignature.ts).
const CALLBACK_SECRET = 'whs_' + 'ab12'.repeat(16);

describe('create_envelope', () => {
  it('#155 — POSTs verbatim and returns the FULL documented envelope result (delivery, spam_notice, one-time callback_secret, suggestion), dropping undocumented fields', async () => {
    // Deliberate reversal (#155, Barry-approved 2026-07-16) of the 2026-07-09
    // six-field lock: the API shows callback_secret exactly ONCE, so an MCP
    // caller who supplied callback_url must receive it here or never.
    queue.push({
      status: 201,
      body: {
        envelope_id: 'env-1',
        status: 'active',
        document_hash: 'abc',
        status_url: 's',
        verify_url: 'v',
        signing_links: [{ email: 'a@b.co', link: 'l' }],
        spam_notice: 'If signers do not receive the email, ask them to check their spam folder.',
        delivery: { delivered: 1, undeliverable: [], failed: [] },
        callback_secret: CALLBACK_SECRET,
        suggestion: { has_existing_signatures: false, signed_count: 0, total_count: 1, missing_signers: [] },
        internal_flag: 'MUST_NOT_PASS',
        payment_authorization: 'MUST_NOT_PASS',
      },
    });
    const text = await callTool('create_envelope', {
      document_name: 'Contract',
      pdf_base64: 'JVBERi0=',
      signers: [{ email: 'a@b.co', name: 'A B' }],
      callback_url: 'https://hooks.example/x',
      message: 'please sign',
    });

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, 'https://contract.test/v1/envelope');
    assert.equal(call.method, 'POST');
    // Verbatim passthrough: the MCP adds no Bearer prefix (the server accepts both).
    assert.equal(call.headers['Authorization'], 'ksk_contract_key');
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.deepEqual(call.body, {
      document_name: 'Contract',
      pdf_base64: 'JVBERi0=',
      signers: [{ email: 'a@b.co', name: 'A B' }],
      callback_url: 'https://hooks.example/x',
      message: 'please sign',
    });

    const parsed = JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), [
      'callback_secret',
      'delivery',
      'document_hash',
      'envelope_id',
      'signing_links',
      'spam_notice',
      'status',
      'status_url',
      'suggestion',
      'verify_url',
    ]);
    assert.equal(parsed.envelope_id, 'env-1');
    assert.equal(parsed.callback_secret, CALLBACK_SECRET, 'the one-time secret passes VERBATIM');
    assert.deepEqual(parsed.delivery, { delivered: 1, undeliverable: [], failed: [] });
  });

  it('#155 — optional fields absent from the API result stay absent (no undefined keys)', async () => {
    queue.push({
      status: 201,
      body: {
        envelope_id: 'env-2',
        status: 'active',
        document_hash: 'abc',
        status_url: 's',
        verify_url: 'v',
        signing_links: [{ email: 'a@b.co', link: 'l' }],
        spam_notice: 'check spam',
        delivery: { delivered: 1, undeliverable: [], failed: [] },
      },
    });
    const text = await callTool('create_envelope', {
      document_name: 'Contract',
      pdf_base64: 'JVBERi0=',
      signers: [{ email: 'a@b.co', name: 'A B' }],
    });
    const parsed = JSON.parse(text) as Record<string, unknown>;
    assert.ok(!('callback_secret' in parsed), 'no callback_url → no callback_secret key');
    assert.ok(!('suggestion' in parsed), 'no suggestion → no suggestion key');
  });

  it('#119 — a non-ok API response is an isError result preserving status + stable code + message', async () => {
    queue.push({ status: 402, body: { error: 'Insufficient credit — your balance is $0.00', code: 'payment_required' } });
    const r = await callToolFull('create_envelope', {
      document_name: 'X',
      pdf_base64: 'JVBERi0=',
      signers: [{ email: 'a@b.co', name: 'A' }],
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /402/);
    assert.match(r.content[0]!.text, /payment_required/);
    assert.match(r.content[0]!.text, /Insufficient credit/);
  });

  it('#121/#122 — providing neither PDF source fails locally (isError) with no network call', async () => {
    const r = await callToolFull('create_envelope', { document_name: 'X', signers: [{ email: 'a@b.co', name: 'A' }] });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /exactly one of pdf_base64 or pdf_url/);
    assert.equal(calls.length, 0, 'no network call for a local validation failure');
  });

  it('#121/#122 — providing BOTH PDF sources fails locally (isError) with no network call', async () => {
    const r = await callToolFull('create_envelope', {
      document_name: 'X',
      pdf_base64: 'JVBERi0=',
      pdf_url: 'https://example.test/doc.pdf',
      signers: [{ email: 'a@b.co', name: 'A' }],
    });
    assert.equal(r.isError, true);
    assert.equal(calls.length, 0);
  });
});

describe('check_envelope_status', () => {
  it('GETs /v1/envelope/:id and passes the envelope JSON through VERBATIM (delivery_status preserved)', async () => {
    const envelope = {
      envelope_id: 'env-9',
      status: 'active',
      signers: [{ email: 'a@b.co', signed: false, delivery_status: 'delivered' }],
    };
    queue.push({ status: 200, body: envelope });
    const text = await callTool('check_envelope_status', { envelope_id: 'env-9' });
    assert.equal(calls[0]!.url, 'https://contract.test/v1/envelope/env-9');
    assert.equal(calls[0]!.method, 'GET');
    assert.equal(calls[0]!.headers['Authorization'], 'ksk_contract_key');
    assert.deepEqual(JSON.parse(text), envelope);
  });

  it('AC-125 — per-signer delivery_status passes through verbatim (pending / undeliverable / delivered), distinct from signing status', async () => {
    const envelope = {
      envelope_id: 'env-1',
      status: 'active',
      signers: [
        { email: 'pending@x.com', status: 'pending', delivery_status: 'pending' },
        { email: 'bounced@x.com', status: 'pending', delivery_status: 'undeliverable' },
        { email: 'done@x.com', status: 'signed', delivery_status: 'delivered' },
      ],
    };
    queue.push({ status: 200, body: envelope });
    const parsed = JSON.parse(await callTool('check_envelope_status', { envelope_id: 'env-1' })) as typeof envelope;
    assert.equal(parsed.signers[1]!.delivery_status, 'undeliverable');
    assert.equal(parsed.signers[1]!.status, 'pending', 'delivery_status is distinct from signing status');
    assert.equal(parsed.signers[2]!.delivery_status, 'delivered');
  });

  it('#119 — a non-ok response is a coded isError result', async () => {
    queue.push({ status: 404, body: { error: 'Envelope not found', code: 'not_found' } });
    const r = await callToolFull('check_envelope_status', { envelope_id: 'nope' });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /404/);
    assert.match(r.content[0]!.text, /not_found/);
  });

  it('F-30.7 — an explicit tracking_token wins over the ambient bearer key (explicit-over-ambient)', async () => {
    const TRACKING = 'ktt_' + 'P'.repeat(43);
    queue.push({ status: 200, body: { id: 'env-1', status: 'active', signers: [] } });
    await callTool('check_envelope_status', { envelope_id: 'env-1', tracking_token: TRACKING });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.headers['Authorization'], TRACKING, 'the per-call token beats the ambient env key');
  });

  it('F-30.7 — tracking_token is an optional schema field (envelope_id stays the only required arg)', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'check_envelope_status')!;
    const schema = t.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    assert.deepEqual(schema.required ?? [], ['envelope_id']);
    assert.ok('tracking_token' in schema.properties, 'tracking_token present in the schema');
  });
});

describe('list_envelopes', () => {
  it('GETs /v1/envelopes with no body and passes the list through verbatim', async () => {
    const body = { envelopes: [{ envelope_id: 'env-1', status: 'voided' }] };
    queue.push({ status: 200, body });
    const text = await callTool('list_envelopes', {});
    assert.equal(calls[0]!.url, 'https://contract.test/v1/envelopes');
    assert.equal(calls[0]!.method, 'GET');
    assert.equal(calls[0]!.body, undefined);
    assert.deepEqual(JSON.parse(text), body);
  });

  it('#119 — a non-ok response is a coded isError result', async () => {
    queue.push({ status: 401, body: { error: 'Authentication required', code: 'auth_invalid_key' } });
    const r = await callToolFull('list_envelopes', {});
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /401/);
    assert.match(r.content[0]!.text, /auth_invalid_key/);
  });
});

describe('send_reminder', () => {
  it('POSTs /v1/envelope/:id/remind and reports the reminded count', async () => {
    queue.push({ status: 200, body: { reminded: 2 } });
    const text = await callTool('send_reminder', { envelope_id: 'env-7' });
    assert.equal(calls[0]!.url, 'https://contract.test/v1/envelope/env-7/remind');
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(text, 'Sent reminders to 2 pending signer(s).');
  });

  it('#119 — a state-conflict is a coded isError result', async () => {
    queue.push({ status: 409, body: { error: 'Envelope is not active', code: 'state_not_active' } });
    const r = await callToolFull('send_reminder', { envelope_id: 'env-7' });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /409/);
    assert.match(r.content[0]!.text, /state_not_active/);
  });
});

describe('void_envelope', () => {
  it('POSTs /v1/envelope/:id/void and names the voided envelope', async () => {
    queue.push({ status: 200, body: { id: 'env-7' } });
    const text = await callTool('void_envelope', { envelope_id: 'env-7' });
    assert.equal(calls[0]!.url, 'https://contract.test/v1/envelope/env-7/void');
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(text, 'Envelope env-7 has been voided.');
  });

  it('#119 — a scope 403 is a coded isError result', async () => {
    queue.push({ status: 403, body: { error: 'API key not allowed for this action', code: 'auth_key_scope' } });
    const r = await callToolFull('void_envelope', { envelope_id: 'env-7' });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /403/);
    assert.match(r.content[0]!.text, /auth_key_scope/);
  });
});

describe('#155 — envelope-result lockstep', () => {
  it('the MCP projection mirrors the API create-201 canonical field list exactly', async () => {
    // Cross-package, test-only import (excluded from both builds): if the API
    // 201 body gains a field the MCP allowlist does not know, this fails the
    // suite — the "future documented safe fields are not silently discarded" AC.
    const { ENVELOPE_RESULT_FIELDS } = await import('./envelopeResult.js');
    const { CREATE_201_RESULT_FIELDS } = await import('../../src/api/envelopeResultFields.js');
    assert.deepEqual([...ENVELOPE_RESULT_FIELDS].sort(), [...CREATE_201_RESULT_FIELDS].sort());
  });
});

describe('#122 — missing-auth fast-fail (no wasted network call)', () => {
  it('when KYSIGNED_AUTHORIZATION is unset, tools fail locally (isError) with actionable guidance and NO fetch', async () => {
    const saved = process.env.KYSIGNED_AUTHORIZATION;
    delete process.env.KYSIGNED_AUTHORIZATION;
    try {
      const r = await callToolFull('list_envelopes', {});
      assert.equal(r.isError, true);
      assert.match(r.content[0]!.text, /KYSIGNED_AUTHORIZATION is not set/);
      assert.match(r.content[0]!.text, /\/account\/api-keys/);
      assert.equal(calls.length, 0, 'no network call was made');
    } finally {
      process.env.KYSIGNED_AUTHORIZATION = saved;
    }
  });
});
