/**
 * The discovery documents and honest 404s (82.4; F-46.4, F-46.5, F-46.7,
 * F-46.9, F-46.10). Every assertion checks the content type AND the body,
 * never the status alone: on the live site an unknown extensionless path
 * answers the SPA's 200 text/html (the false-200 trap).
 *
 * Shapes follow the normative sources: the MCP Server Card v1 schema
 * (modelcontextprotocol/experimental-ext-server-card schema.ts), the Agent
 * Skills Discovery RFC v0.2.0 (cloudflare/agent-skills-discovery-rfc), and
 * RFC 9727 / RFC 9264 for the API catalog linkset.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  handleDocumentRequest,
  OAUTH_DISCOVERY_PATHS,
  SERVER_CARD_SCHEMA,
  SKILLS_INDEX_SCHEMA,
  type DocumentDeps,
} from './webDocuments.js';
import { WEB_FACTS } from './webFacts.js';
import { WEB_TOOL_NAMES } from './webServer.js';

const ORIGIN = 'https://kysigned.test';
const DEPS: DocumentDeps = { origin: ORIGIN, version: '9.9.9' };
const DASHES = /[\u2013\u2014]/;

// The local stdio server's tools (pinned by contract.test.ts:69-83).
const LOCAL_TOOLS = [
  'check_envelope_status',
  'create_envelope',
  'create_envelope_x402',
  'list_envelopes',
  'send_reminder',
  'void_envelope',
  'wallet_status',
];

async function get(path: string, init: RequestInit = {}): Promise<Response> {
  const res = handleDocumentRequest(new Request(`${ORIGIN}${path}`, init), DEPS);
  assert.ok(res, `${path} is a document path`);
  return res!;
}

function contentType(res: Response): string {
  return res.headers.get('content-type') ?? '';
}

describe('MCP server card (AC-288)', () => {
  it('both locations answer the same card as application/json', async () => {
    const a = await get('/.well-known/mcp/server-card.json');
    const b = await get('/mcp/server-card');
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.match(contentType(a), /^application\/json/);
    assert.match(contentType(b), /^application\/json/);
    assert.equal(await a.text(), await b.text());
  });

  it('meets the v1 schema rules and names the no-auth streamable-HTTP remote and the local package', async () => {
    const card = (await (await get('/mcp/server-card')).json()) as Record<string, any>;
    assert.equal(card.$schema, SERVER_CARD_SCHEMA);
    assert.equal(SERVER_CARD_SCHEMA, 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json');
    assert.match(card.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    assert.equal(card.name, 'test.kysigned/kysigned', 'reverse-DNS of the instance host');
    assert.equal(card.version, '9.9.9');
    assert.ok(card.description.length >= 1 && card.description.length <= 100, 'description is 1..100 characters');
    assert.ok(card.title.length <= 100);
    assert.equal(card.websiteUrl, ORIGIN);
    assert.deepEqual(card.repository, { url: WEB_FACTS.publicRepo, source: 'github', subfolder: 'mcp' });
    assert.equal(card.remotes.length, 1);
    assert.equal(card.remotes[0].type, 'streamable-http');
    assert.equal(card.remotes[0].url, `${ORIGIN}/mcp`);
    assert.equal(card.remotes[0].headers, undefined, 'no auth header: the endpoint is unauthenticated');
    assert.ok(Array.isArray(card.remotes[0].supportedProtocolVersions) && card.remotes[0].supportedProtocolVersions.length > 0);
    assert.equal(card.tools, undefined, 'the live tools/list is the one source of the tool list');
    const local = card._meta['com.kysigned/local-server'];
    assert.equal(local.registryType, 'npm');
    assert.equal(local.identifier, WEB_FACTS.localPackage);
    assert.equal(local.transport, 'stdio');
    assert.equal(local.environment.KYSIGNED_ENDPOINT, ORIGIN);
    assert.ok(!DASHES.test(JSON.stringify(card)));
  });

  it('answers the SEP-2127 media type when a client asks for it', async () => {
    const res = await get('/mcp/server-card', { headers: { Accept: 'application/mcp-server-card+json' } });
    assert.match(contentType(res), /^application\/mcp-server-card\+json/);
    assert.match(res.headers.get('vary') ?? '', /Accept/i);
  });
});

describe('agent skills index (AC-289)', () => {
  it('the index meets the v0.2.0 rules and every digest is the SHA-256 of the served bytes', async () => {
    const res = await get('/.well-known/agent-skills/index.json');
    assert.equal(res.status, 200);
    assert.match(contentType(res), /^application\/json/);
    const index = (await res.json()) as { $schema: string; skills: Array<Record<string, string>> };
    assert.equal(index.$schema, SKILLS_INDEX_SCHEMA);
    assert.equal(SKILLS_INDEX_SCHEMA, 'https://schemas.agentskills.io/discovery/0.2.0/schema.json');
    assert.ok(index.skills.length >= 2);
    for (const s of index.skills) {
      assert.deepEqual(Object.keys(s).sort(), ['description', 'digest', 'name', 'type', 'url']);
      assert.match(s['name']!, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase, hyphens, no leading/trailing/double hyphens');
      assert.ok(s['name']!.length <= 64);
      assert.equal(s['type'], 'skill-md');
      assert.ok(s['description']!.length > 0 && s['description']!.length <= 1024);
      assert.equal(s['url'], `${ORIGIN}/.well-known/agent-skills/${s['name']}/SKILL.md`);
      const skill = await get(new URL(s['url']!).pathname);
      assert.equal(skill.status, 200);
      assert.match(contentType(skill), /^text\/markdown/);
      const bytes = new Uint8Array(await skill.arrayBuffer());
      assert.equal(s['digest'], `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
      const text = new TextDecoder().decode(bytes);
      assert.ok(text.startsWith(`---\nname: ${s['name']}\ndescription: `), 'SKILL.md opens with name + description front matter');
      assert.ok(text.includes(JSON.stringify(s['description'])), 'the front matter description matches the index');
      assert.ok(!DASHES.test(text), `${s['name']} has no em or en dash`);
    }
  });

  it('together the skills name every tool of both MCP servers', async () => {
    const index = (await (await get('/.well-known/agent-skills/index.json')).json()) as { skills: Array<{ url: string }> };
    let all = '';
    for (const s of index.skills) all += await (await get(new URL(s.url).pathname)).text();
    for (const tool of new Set([...WEB_TOOL_NAMES, ...LOCAL_TOOLS])) {
      assert.ok(all.includes(tool), `some skill covers ${tool}`);
    }
  });

  it('HEAD has the headers and no body; an unknown skill is a JSON 404', async () => {
    const head = await get('/.well-known/agent-skills/index.json', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.match(contentType(head), /^application\/json/);
    assert.equal(await head.text(), '');
    const missing = await get('/.well-known/agent-skills/no-such-skill/SKILL.md');
    assert.equal(missing.status, 404);
    assert.match(contentType(missing), /^application\/json/);
  });
});

describe('/auth.md, plain and honest (AC-294)', () => {
  it('answers text/markdown and covers every way in', async () => {
    const res = await get('/auth.md');
    assert.equal(res.status, 200);
    assert.match(contentType(res), /^text\/markdown/);
    const md = await res.text();
    for (const needle of [
      `${ORIGIN}/mcp`, // (a) the web endpoint, no auth
      `${ORIGIN}/v1/x402/envelope`, // (b) wallet payment
      'create_envelope_x402',
      `${ORIGIN}/account/api-keys`, // (c) creator keys: where they are minted
      'Authorization: Bearer ksk_',
      'bare key',
      'CSRF',
      'revoked',
      'auth_invalid_key',
      'auth_key_scope',
      'ktt_', // (d) tracking tokens
      'auth_tracking_scope',
      'check_envelope_status',
    ]) {
      assert.ok(md.includes(needle), `auth.md names ${needle}`);
    }
    assert.match(md, /no OAuth/i);
    assert.match(md, /self-registration/i);
    assert.ok(!DASHES.test(md));
  });

  it('names only error codes and paths the server honors (docs alignment, F-30.4)', async () => {
    const md = await (await get('/auth.md')).text();
    const known = new Set<string>(Object.values(WEB_FACTS.errorCodes));
    for (const code of md.match(/\bauth_[a-z_]+\b/g) ?? []) {
      assert.ok(known.has(code), `${code} is a code the API returns (webFacts.test.ts checks the API source)`);
    }
    const paths = new Set<string>([
      WEB_FACTS.mcpPath,
      WEB_FACTS.x402CreatePath,
      WEB_FACTS.apiKeysPath,
      WEB_FACTS.envelopeStatusPattern,
      WEB_FACTS.preflightPath,
      '/llms.txt',
      '/openapi.json',
      '/.well-known/api-catalog',
    ]);
    for (const m of md.matchAll(new RegExp(`${ORIGIN.replace(/[.]/g, '\\.')}(/[A-Za-z0-9_./:-]*)`, 'g'))) {
      const p = m[1]!.replace(/[.,)]$/, '');
      assert.ok(paths.has(p), `${p} is a documented path`);
    }
  });
});

describe('API catalog, RFC 9727 (AC-295)', () => {
  it('GET answers the linkset with absolute links; HEAD the same headers and no body', async () => {
    const res = await get('/.well-known/api-catalog');
    assert.equal(res.status, 200);
    assert.match(contentType(res), /^application\/linkset\+json/);
    assert.match(contentType(res), /profile="https:\/\/www\.rfc-editor\.org\/info\/rfc9727"/);
    assert.match(res.headers.get('link') ?? '', /rel="api-catalog"/);
    const body = (await res.json()) as { linkset: Array<Record<string, any>> };
    const byAnchor = new Map(body.linkset.map((e) => [e.anchor as string, e]));
    const api = byAnchor.get(`${ORIGIN}/v1/`)!;
    assert.deepEqual(api['service-desc'].map((l: { href: string }) => l.href), [`${ORIGIN}/openapi.json`]);
    assert.deepEqual(api['service-doc'].map((l: { href: string }) => l.href), [`${ORIGIN}/llms.txt`, `${ORIGIN}/auth.md`]);
    assert.deepEqual(api['status'].map((l: { href: string }) => l.href), [`${ORIGIN}/v1/health`]);
    const mcp = byAnchor.get(`${ORIGIN}/mcp`)!;
    assert.deepEqual(mcp['service-desc'].map((l: { href: string }) => l.href), [`${ORIGIN}/mcp/server-card`]);
    const catalog = byAnchor.get(`${ORIGIN}/.well-known/api-catalog`)!;
    assert.deepEqual(catalog['item'].map((l: { href: string }) => l.href), [`${ORIGIN}/v1/`, `${ORIGIN}/mcp`]);
    for (const entry of body.linkset) {
      for (const [rel, links] of Object.entries(entry)) {
        if (rel === 'anchor') continue;
        for (const l of links as Array<{ href: string }>) assert.ok(l.href.startsWith(`${ORIGIN}/`), `${rel} ${l.href} is absolute`);
      }
    }
    const head = await get('/.well-known/api-catalog', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(contentType(head), contentType(res));
    assert.equal(await head.text(), '');
  });
});

describe('no OAuth discovery documents (AC-291)', () => {
  it('each OAuth/OpenID path answers an honest 404 with a JSON body, never HTML', async () => {
    assert.deepEqual([...OAUTH_DISCOVERY_PATHS].sort(), [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource',
      '/.well-known/openid-configuration',
    ]);
    for (const p of OAUTH_DISCOVERY_PATHS) {
      const res = await get(p);
      assert.equal(res.status, 404);
      assert.match(contentType(res), /^application\/json/);
      const body = (await res.json()) as { code: string; message: string };
      assert.equal(body.code, 'not_found');
      assert.match(body.message, /auth\.md/);
    }
  });

  it('a path that is not a document is not handled here', () => {
    assert.equal(handleDocumentRequest(new Request(`${ORIGIN}/faq`), DEPS), null);
    assert.equal(handleDocumentRequest(new Request(`${ORIGIN}/.well-known/security.txt`), DEPS), null);
  });
});
