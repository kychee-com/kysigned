/**
 * verify_bundle in the local server (plan 83.5, F-47.2, AC-300; F-47.5, AC-303).
 *
 * Drives the REAL registered server over an in-memory transport with NOTHING
 * configured (no creator key, no wallet): the tool reads a completed bundle from a
 * path on this machine or from base64 bytes, runs the published `kysigned` verifier
 * here, and returns the tiered verdict as structured content (the document
 * `kysigned verify --json` prints) plus the human-first report. A FAILED verdict is
 * a result; only bad input is a tool error. Under the 83.2 network guard (a child
 * process), offline makes no network attempt at all, and online reaches only the
 * verifier's two indicators, with no bundle bytes and never the operator.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyBundleBytes } from 'kysigned';

delete process.env.KYSIGNED_AUTHORIZATION;
delete process.env.KYSIGNED_RUN402_ALLOWANCE_PATH;
process.env.KYSIGNED_ENDPOINT = 'https://operator.test';

const { server, setWalletSeamsForTests } = await import('./server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

// verify_bundle needs no wallet: any touch of the wallet seams fails the call.
setWalletSeamsForTests(
  new Proxy({}, {
    get() {
      throw new Error('verify_bundle touched the wallet');
    },
  }) as never,
);
after(() => setWalletSeamsForTests(undefined));

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'verify-tool-suite', version: '0.0.0' });
await client.connect(clientTransport);
after(() => Promise.allSettled([client.close(), server.close()]));

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(HERE, '..');
const ASSETS = join(MCP_DIR, '..', 'docs', 'test-assets');
const GENUINE = join(ASSETS, 'acme-anvil-waiver-signed-bundle.pdf');
const TAMPERED = join(ASSETS, 'sample-bundle-tampered-doc.pdf');
/** A genuine live bundle that embeds the archive's signed statement for its signer (F-32.9). */
const WITH_STATEMENT = join(ASSETS, 'acme-anvil-waiver-signed-bundle-with-statement.pdf');
const GUARD = pathToFileURL(join(MCP_DIR, '..', 'cli', 'test', 'network-guard.mjs')).href;
const KYSIGNED_BIN = join(dirname(fileURLToPath(import.meta.resolve('kysigned'))), 'kysigned.mjs');
const SATISFIED = ['INTEGRITY_VERIFIED', 'PROVIDER_KEY_CONFIRMED', 'PROVEN_DURABLE'];
/** The hosts the verifier's two indicators may reach (F-10.6, F-10.7, F-10.8). */
const ALLOWED_HOST = /(^|\.)(opentimestamps\.org|eternitywall\.com|blockstream\.info|mempool\.space|archive\.prove\.email)$/;
const DASHES = /[–—]/;

const EXISTING_TOOLS = [
  'check_envelope_status',
  'create_envelope',
  'create_envelope_x402',
  'list_envelopes',
  'send_reminder',
  'void_envelope',
  'wallet_status',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Verdict = Record<string, any>;
interface Result {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Verdict;
  isError?: boolean;
}
const verify = async (args: Record<string, unknown>) =>
  (await client.callTool({ name: 'verify_bundle', arguments: args })) as unknown as Result;
const b64 = (file: string) => readFileSync(file).toString('base64');

/** The installed `kysigned` command's offline --json verdict (F-47.1). */
function cliJson(file: string): { code: number | null; doc: Verdict } {
  const r = spawnSync(process.execPath, [KYSIGNED_BIN, 'verify', '--offline', '--json', file], { encoding: 'utf8' });
  return { code: r.status, doc: JSON.parse(r.stdout) as Verdict };
}

describe('verify_bundle: registration (AC-300)', () => {
  it('is listed beside the seven existing tools, annotated read-only and never destructive', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...EXISTING_TOOLS, 'verify_bundle'].sort());
    const t = tools.find((x) => x.name === 'verify_bundle')!;
    assert.equal(t.annotations?.readOnlyHint, true);
    assert.notEqual(t.annotations?.destructiveHint, true);
  });

  it('takes path, pdf_base64 and offline, none required by the schema (exactly one input is checked per call)', async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((x) => x.name === 'verify_bundle')!.inputSchema as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(schema.properties).sort(), ['offline', 'path', 'pdf_base64']);
    assert.deepEqual(schema.required ?? [], []);
  });

  it('says it runs on this machine with no key and no wallet, names the CLI, and has no dash', async () => {
    const { tools } = await client.listTools();
    const d = String(tools.find((x) => x.name === 'verify_bundle')!.description);
    assert.match(d, /on this machine/);
    assert.match(d, /never leaves this machine/);
    assert.match(d, /no API key/);
    assert.match(d, /no wallet/);
    assert.match(d, /npx kysigned verify/);
    assert.match(d, /offline/);
    assert.ok(!DASHES.test(d), 'no em or en dash');
  });
});

describe('verify_bundle: the verdict, with nothing configured (AC-300)', () => {
  it('a genuine bundle by path: the satisfied tier, per-signer detail and the original-document SHA-256', async () => {
    const r = await verify({ path: GENUINE, offline: true });
    assert.notEqual(r.isError, true, r.content[0]?.text);
    const expected = await verifyBundleBytes(new Uint8Array(readFileSync(GENUINE)), { offline: true });
    assert.deepEqual(r.structuredContent, expected.json, 'structured content is the kysigned verdict document');
    const v = r.structuredContent!;
    assert.equal(v['schema'], 'kysigned.verdict.v1');
    assert.ok(SATISFIED.includes(v['tier']), `tier ${v['tier']}`);
    assert.match(String(v['originalDocSha256']), /^[0-9a-f]{64}$/);
    assert.ok(v['signers'].length >= 1);
    for (const s of v['signers']) {
      assert.ok(SATISFIED.includes(s.tier), `signer ${s.index} tier ${s.tier}`);
      assert.ok(s.assurance && s.checks, 'per-signer dimensions and checks');
    }
    assert.equal(r.content[0]!.text, expected.report, 'the first text block is the human-first report');
    assert.deepEqual(JSON.parse(r.content[1]!.text), expected.json, 'the second text block is the same document, serialized');
  });

  it('a tampered bundle by base64: FAILED, naming the broken check, as a result and not a tool error', async () => {
    const r = await verify({ pdf_base64: b64(TAMPERED), offline: true });
    assert.notEqual(r.isError, true, r.content[0]?.text);
    const v = r.structuredContent!;
    assert.equal(v['tier'], 'FAILED');
    assert.ok(
      v['signers'].some((s: Verdict) => s.checks.attachment === false && s.reasons.includes('attachment modified')),
      'a signer fails the attachment check with its reason',
    );
    assert.match(r.content[0]!.text, /FAILED/);
    const expected = await verifyBundleBytes(new Uint8Array(readFileSync(TAMPERED)), { offline: true });
    assert.deepEqual(v, expected.json);
  });

  it('matches `npx kysigned verify --json` for the same bundle', async () => {
    for (const [file, exit] of [[GENUINE, 0], [TAMPERED, 1]] as const) {
      const cli = cliJson(file);
      assert.equal(cli.code, exit, file);
      const r = await verify({ path: file, offline: true });
      assert.deepEqual(r.structuredContent, cli.doc, file);
    }
  });

  it('accepts a data: URL prefix and line breaks in pdf_base64', async () => {
    const plain = b64(GENUINE);
    const wrapped = `data:application/pdf;base64,${plain.replace(/(.{76})/g, '$1\n')}`;
    const r = await verify({ pdf_base64: wrapped, offline: true });
    assert.notEqual(r.isError, true, r.content[0]?.text);
    assert.deepEqual(r.structuredContent, (await verify({ pdf_base64: plain, offline: true })).structuredContent);
  });

  it('bytes that are not a bundle get a FAILED verdict saying so, not a tool error', async () => {
    const r = await verify({ pdf_base64: Buffer.from('hello, not a pdf').toString('base64'), offline: true });
    assert.notEqual(r.isError, true);
    assert.equal(r.structuredContent!['tier'], 'FAILED');
    assert.match(JSON.stringify(r.structuredContent!['errors']), /damaged/);
  });
});

describe('verify_bundle: bad input is a tool error', () => {
  it('both inputs, or neither, are refused', async () => {
    for (const args of [{ path: GENUINE, pdf_base64: b64(GENUINE) }, {}, { path: '  ', pdf_base64: '' }]) {
      const r = await verify({ ...args, offline: true });
      assert.equal(r.isError, true, JSON.stringify(Object.keys(args)));
      assert.match(r.content[0]!.text, /^Error: provide exactly one of path or pdf_base64/);
    }
  });

  it('an unreadable path is refused, naming the path', async () => {
    const missing = join(tmpdir(), 'no-such-dir-kysigned', 'bundle.pdf');
    const r = await verify({ path: missing, offline: true });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /^Error: cannot read /);
    assert.ok(r.content[0]!.text.includes(missing));
  });

  it('pdf_base64 that is not base64 is refused', async () => {
    const r = await verify({ pdf_base64: 'this is not base64!', offline: true });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /^Error: pdf_base64 is not valid base64/);
  });
});

/**
 * One verify_bundle call in a child process under the 83.2 network guard. The
 * arguments go over stdin: a bundle's base64 is far past the Windows command-line
 * limit (32,767 characters).
 */
function guardedCall(args: Record<string, unknown>): { result?: Result; err: string; attempts: Verdict[] } {
  const dir = mkdtempSync(join(tmpdir(), 'kysigned-mcp-netlog-'));
  const log = join(dir, 'net.jsonl');
  const script = [
    "const { readFileSync } = await import('node:fs');",
    "const args = JSON.parse(readFileSync(0, 'utf8'));",
    `const { server } = await import(${JSON.stringify(pathToFileURL(join(HERE, 'server.ts')).href)});`,
    "const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');",
    "const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');",
    'const [c, s] = InMemoryTransport.createLinkedPair();',
    'await server.connect(s);',
    "const client = new Client({ name: 'guarded', version: '0.0.0' });",
    'await client.connect(c);',
    "const r = await client.callTool({ name: 'verify_bundle', arguments: args });",
    'process.stdout.write(JSON.stringify(r));',
    'await client.close();',
    'await server.close();',
  ].join('\n');
  const env: NodeJS.ProcessEnv = { ...process.env, KYSIGNED_NETLOG: log, KYSIGNED_ENDPOINT: 'https://operator.test' };
  delete env.KYSIGNED_AUTHORIZATION;
  delete env.KYSIGNED_RUN402_ALLOWANCE_PATH;
  try {
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--import', GUARD, '--input-type=module', '-e', script], {
      cwd: MCP_DIR,
      encoding: 'utf8',
      env,
      input: JSON.stringify(args),
      maxBuffer: 64 * 1024 * 1024,
    });
    const attempts = existsSync(log)
      ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Verdict)
      : [];
    const err = `${r.error ? `${r.error}\n` : ''}exit ${r.status}\n${r.stderr}`;
    return { result: r.stdout ? (JSON.parse(r.stdout) as Result) : undefined, err, attempts };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('verify_bundle stays on this machine (AC-303)', () => {
  it('offline, bundles with no archive statement: no network attempt at all, and the verdict comes back with both indicators pending', () => {
    for (const args of [{ path: GENUINE }, { pdf_base64: b64(TAMPERED) }]) {
      const g = guardedCall({ ...args, offline: true });
      assert.deepEqual(g.attempts, [], `offline made a network attempt: ${JSON.stringify(g.attempts)}`);
      assert.ok(g.result, g.err);
      assert.notEqual(g.result!.isError, true, g.result!.content[0]?.text);
      assert.equal(g.result!.structuredContent!['offline'], true);
      for (const s of g.result!.structuredContent!['signers']) {
        assert.equal(s.checks.keyAuthenticity, 'pending-online');
        assert.ok(['pending', 'absent'].includes(s.bitcoinAnchor.status), `bitcoin anchor ${s.bitcoinAnchor.status}`);
      }
    }
  });

  it('offline, a bundle carrying a verified archive statement: no network attempt, the key archive confirmed from the statement, the Bitcoin anchor pending (spec 0.75.1)', () => {
    const g = guardedCall({ path: WITH_STATEMENT, offline: true });
    assert.deepEqual(g.attempts, [], `offline made a network attempt: ${JSON.stringify(g.attempts)}`);
    assert.ok(g.result, g.err);
    assert.notEqual(g.result!.isError, true, g.result!.content[0]?.text);
    const v = g.result!.structuredContent!;
    assert.equal(v['offline'], true);
    assert.equal(v['tier'], 'PROVIDER_KEY_CONFIRMED');
    for (const s of v['signers']) {
      assert.equal(s.checks.keyAuthenticity, 'archive-confirmed', 'the embedded statement confirms the key archive offline (F-32.9)');
      assert.equal(s.assurance.keyProvenance, 'confirmed');
      assert.equal(s.bitcoinAnchor.status, 'pending', 'only an online run can confirm a Bitcoin block');
    }
    assert.match(g.result!.content[0]!.text, /Key archive: confirmed/);
  });

  it('online: only the indicator hosts, no bundle bytes, never the operator; the verdict still holds', () => {
    const g = guardedCall({ pdf_base64: b64(GENUINE) });
    assert.ok(g.attempts.length > 0, 'the guard saw no attempt: the online indicators did not run, so this test proves nothing');
    const bundle = b64(GENUINE);
    const markers = [0.25, 0.5, 0.75].map((f) => bundle.slice(Math.floor(bundle.length * f), Math.floor(bundle.length * f) + 64));
    for (const a of g.attempts) {
      assert.equal(a['kind'], 'fetch', `a ${a['kind']} attempt outside fetch: ${a['detail']}`);
      const host = new URL(a['url']).hostname;
      assert.match(host, ALLOWED_HOST, `request to ${host} (${a['url']})`);
      assert.ok(a['bodyLength'] < 4096, `${a['url']} sent ${a['bodyLength']} bytes`);
      const body = Buffer.from(a['bodyBase64'], 'base64');
      assert.ok(!body.includes('%PDF'), `${a['url']} sent PDF bytes`);
      for (const m of markers) assert.ok(!a['bodyBase64'].includes(m) && !body.toString('latin1').includes(m), `${a['url']} sent the bundle`);
    }
    assert.ok(g.result, g.err);
    assert.notEqual(g.result!.isError, true, g.result!.content[0]?.text);
    const v = g.result!.structuredContent!;
    assert.equal(v['offline'], false);
    assert.ok(SATISFIED.includes(v['tier']), `tier ${v['tier']}`);
    for (const s of v['signers']) assert.equal(s.checks.keyAuthenticity, 'pending-online', 'an unreachable archive reads as pending, never an error');
  });
});
