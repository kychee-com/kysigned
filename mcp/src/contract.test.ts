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

const { server } = await import('./index.js');
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

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
  };
  return res.content[0]!.text;
}

describe('tool registration', () => {
  it('exposes exactly the five ops tools', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['check_envelope_status', 'create_envelope', 'list_envelopes', 'send_reminder', 'void_envelope'],
    );
  });

  it('create_envelope requires document_name + signers; pdf fields, callback_url, message stay optional', async () => {
    const { tools } = await client.listTools();
    const create = tools.find((t) => t.name === 'create_envelope')!;
    const schema = create.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    assert.deepEqual([...(schema.required ?? [])].sort(), ['document_name', 'signers']);
    for (const opt of ['pdf_base64', 'pdf_url', 'callback_url', 'message']) {
      assert.ok(opt in schema.properties, `optional field ${opt} present in the schema`);
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
});

describe('create_envelope', () => {
  it('POSTs the body verbatim to /v1/envelope with the verbatim Authorization, and returns the six passthrough fields', async () => {
    queue.push({
      status: 201,
      body: {
        envelope_id: 'env-1',
        status: 'active',
        document_hash: 'abc',
        status_url: 's',
        verify_url: 'v',
        signing_links: [{ email: 'a@b.co', link: 'l' }],
        callback_secret: 'whs_never_surfaced_by_this_tool',
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
      'document_hash',
      'envelope_id',
      'signing_links',
      'status',
      'status_url',
      'verify_url',
    ]);
    assert.equal(parsed.envelope_id, 'env-1');
  });

  it('surfaces the API error message on a non-ok response (human message, not the code)', async () => {
    queue.push({ status: 402, body: { error: 'Insufficient credit — your balance is $0.00', code: 'payment_required' } });
    const text = await callTool('create_envelope', {
      document_name: 'X',
      pdf_base64: 'JVBERi0=',
      signers: [{ email: 'a@b.co', name: 'A' }],
    });
    assert.equal(text, 'Error: Insufficient credit — your balance is $0.00');
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

  it('surfaces the API error message', async () => {
    queue.push({ status: 404, body: { error: 'Envelope not found', code: 'not_found' } });
    assert.equal(await callTool('check_envelope_status', { envelope_id: 'nope' }), 'Error: Envelope not found');
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

  it('surfaces the API error message', async () => {
    queue.push({ status: 401, body: { error: 'Authentication required', code: 'auth_invalid_key' } });
    assert.equal(await callTool('list_envelopes', {}), 'Error: Authentication required');
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

  it('surfaces the API error message (e.g. a state conflict)', async () => {
    queue.push({ status: 409, body: { error: 'Envelope is not active', code: 'state_envelope_inactive' } });
    assert.equal(await callTool('send_reminder', { envelope_id: 'env-7' }), 'Error: Envelope is not active');
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

  it('surfaces the API error message', async () => {
    queue.push({ status: 403, body: { error: 'API key not allowed for this action', code: 'auth_key_scope' } });
    assert.equal(await callTool('void_envelope', { envelope_id: 'env-7' }), 'Error: API key not allowed for this action');
  });
});

describe('Authorization passthrough', () => {
  it('omits the Authorization header entirely when KYSIGNED_AUTHORIZATION is unset (never sends an empty one)', async () => {
    const saved = process.env.KYSIGNED_AUTHORIZATION;
    delete process.env.KYSIGNED_AUTHORIZATION;
    try {
      queue.push({ status: 401, body: { error: 'Authentication required', code: 'auth_required' } });
      await callTool('list_envelopes', {});
      assert.equal('Authorization' in calls[0]!.headers, false);
    } finally {
      process.env.KYSIGNED_AUTHORIZATION = saved;
    }
  });
});
