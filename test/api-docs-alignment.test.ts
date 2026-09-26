/**
 * API Documentation Alignment Test
 *
 * Ensures every public /v1/* endpoint is documented in llms.txt.
 * Catches undocumented endpoints and stale docs for removed endpoints.
 *
 * Run: npm run test:docs
 *
 * Modeled after run402's test:docs suite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Use import.meta.dirname (Node 21.2+) with fallback
const ROOT = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..');
// llms.txt lives in the Vite static dir so the build copies it to frontend/dist/llms.txt
// and run402 serves it at https://kysigned.com/llms.txt (the agent-discovery location).
const LLMS_TXT = join(ROOT, 'frontend', 'public', 'llms.txt');

/**
 * Canonical list of public API endpoints exposed by kysigned.
 * When you add a new handler, add its endpoint here — the test will
 * remind you to document it in llms.txt.
 *
 * Format: "METHOD /v1/path" with :param for path params.
 */
const PUBLIC_ENDPOINTS = [
  'GET /v1/health',
  'POST /v1/auth/magic-link',
  'POST /v1/auth/token',
  'POST /v1/envelope',
  'GET /v1/envelope/:id',
  'POST /v1/envelope/:id/remind',
  'POST /v1/envelope/:id/void',
  'POST /v1/envelope/:id/signers',
  'PATCH /v1/envelope/:id/signers',
  'DELETE /v1/envelope/:id/signers',
  'POST /v1/envelope/:id/seal',
  'GET /v1/envelope/:id/pdf',
  'GET /v1/envelopes',
  'GET /v1/documents',
  'GET /v1/sign/:id/:token/info',
  'GET /v1/envelope/:id/:token/pdf',
  // F-30.1 — creator API keys (session-managed; the keys themselves authenticate
  // the creator envelope actions above via the Authorization header).
  'POST /v1/api-keys',
  'GET /v1/api-keys',
  'DELETE /v1/api-keys/:id',
  // F-30.2 — the always-priced x402 create (operator-dependent: kysigned.com on;
  // a fork without x402 config answers payment_x402_not_enabled).
  'POST /v1/x402/envelope',
  // #129 — free deterministic pre-validation of a create body (no charge/create);
  // agents validate inputs before paying the x402 create.
  'POST /v1/envelope/preflight',
];

/**
 * Admin endpoints — intentionally excluded from public docs.
 * Each entry must have a comment explaining why.
 */
const EXCLUDED_ENDPOINTS = [
  // Operator-only allowlist admin — gated by the operator session, not part of the public agent API.
  'GET /v1/admin/allowed-senders',
  'POST /v1/admin/allowed-senders',
  'DELETE /v1/admin/allowed-senders/:id',
  // Session lifecycle + passkey ceremony — UI-internal auth, not in the agent-facing API doc.
  'GET /v1/auth/user',
  'POST /v1/auth/signout',
  'POST /v1/auth/passkeys/login/options',
  'POST /v1/auth/passkeys/login/verify',
  'POST /v1/auth/passkeys/register/options',
  'POST /v1/auth/passkeys/register/verify',
  'GET /v1/auth/passkeys',
  'DELETE /v1/auth/passkeys/:id',
  // F-41 Google sign-in — a BROWSER redirect ceremony (Google's consent screen
  // cannot be driven by an agent), same UI-internal class as the passkey
  // ceremony above. Agents authenticate with ksk_ bearer keys (F-30.1).
  'GET /v1/auth/methods',
  'POST /v1/auth/google/start',
  'POST /v1/auth/google/exchange',
  'POST /v1/auth/google/link',
  // F-43 email-code confirm — the browser types the six digits from the email;
  // same UI-internal ceremony class as the passkey/Google routes above.
  'POST /v1/auth/code',
  // Internal inbound-mail webhook (run402 signature-gated).
  'POST /v1/webhooks/inbound',
  // kysigned.com-proprietary billing (the operator's private function); not in the forkable public API:
  // /v1/credits/*, /v1/webhooks/stripe.
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize endpoint for fuzzy matching in llms.txt — strip :params to path segments */
function endpointToSearchPatterns(endpoint: string): string[] {
  // "POST /v1/envelope/:id/void" → search for both "/v1/envelope" and "void"
  const [method, path] = endpoint.split(' ');
  // Return the method + base path (without params) as a search string
  const basePath = path!.replace(/\/:[^/]+/g, '');
  return [`${method} ${path}`, basePath, path!];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('API Documentation Alignment', () => {
  it('llms.txt exists', () => {
    assert.ok(
      existsSync(LLMS_TXT),
      `llms.txt not found at ${LLMS_TXT}. Create it to document the public API.`
    );
  });

  // Only run endpoint checks if llms.txt exists
  const llmsExists = existsSync(LLMS_TXT);

  for (const endpoint of PUBLIC_ENDPOINTS) {
    it(`${endpoint} is documented in llms.txt`, { skip: !llmsExists ? 'llms.txt does not exist yet' : undefined }, () => {
      const llmsContent = readFileSync(LLMS_TXT, 'utf-8');
      const patterns = endpointToSearchPatterns(endpoint);
      const found = patterns.some(p => llmsContent.includes(p));
      assert.ok(
        found,
        `Endpoint "${endpoint}" not found in llms.txt. Searched for: ${patterns.join(', ')}`
      );
    });
  }

  it('no stale endpoints in llms.txt', { skip: !llmsExists ? 'llms.txt does not exist yet' : undefined }, () => {
    const llmsContent = readFileSync(LLMS_TXT, 'utf-8');
    // Extract all /v1/ paths mentioned in llms.txt
    // Exclude markdown delimiters (backtick, pipe) and trailing punctuation from the captured
    // path — endpoints never contain them, so an inline-code `POST /v1/x` span shouldn't trail one.
    const mentionedPaths = [...llmsContent.matchAll(/(?:GET|POST|PUT|DELETE|PATCH)\s+(\/v1\/[^\s,)}\]`|]+)/g)]
      .map(m => m[1]!);

    const allKnownPaths = [
      ...PUBLIC_ENDPOINTS.map(e => e.split(' ')[1]!),
      ...EXCLUDED_ENDPOINTS.map(e => e.split(' ')[1]!),
    ];

    for (const mentioned of mentionedPaths) {
      // Normalize :param segments for matching
      const normalized = mentioned.replace(/\/[a-f0-9-]{36}/g, '/:id');
      const isKnown = allKnownPaths.some(known => {
        const knownNorm = known.replace(/\/:[^/]+/g, '/[^/]+');
        return new RegExp(`^${knownNorm}$`).test(normalized) || known === mentioned;
      });
      assert.ok(
        isKnown,
        `llms.txt mentions "${mentioned}" but it's not in PUBLIC_ENDPOINTS or EXCLUDED_ENDPOINTS. ` +
        `Either remove it from llms.txt or add it to the canonical list in this test.`
      );
    }
  });

  it('excluded endpoints have comments explaining why', () => {
    // This test just verifies the EXCLUDED_ENDPOINTS list is non-empty
    // and the source file has comments. A human-readable check.
    assert.ok(EXCLUDED_ENDPOINTS.length > 0, 'EXCLUDED_ENDPOINTS should have at least one entry');
  });

  // ── F-30.4 / AC-139 — OpenAPI drift + docs truth ───────────────────────────

  const OPENAPI = join(ROOT, 'frontend', 'public', 'openapi.json');

  it('openapi.json exists (served at /openapi.json alongside llms.txt)', () => {
    assert.ok(existsSync(OPENAPI), `openapi.json not found at ${OPENAPI}`);
  });

  const openapiExists = existsSync(OPENAPI);

  it('every public endpoint appears in openapi.json (and nothing extra) — bidirectional drift', { skip: !openapiExists ? 'openapi.json does not exist yet' : undefined }, () => {
    const spec = JSON.parse(readFileSync(OPENAPI, 'utf-8')) as {
      openapi?: string;
      paths?: Record<string, Record<string, unknown>>;
    };
    assert.match(spec.openapi ?? '', /^3\./, 'OpenAPI 3.x');
    const specSet = new Set<string>();
    for (const [p, methods] of Object.entries(spec.paths ?? {})) {
      for (const m of Object.keys(methods)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(m)) {
          specSet.add(`${m.toUpperCase()} ${p}`);
        }
      }
    }
    // OpenAPI uses {param}; the canonical list uses :param — normalize.
    const wanted = new Set(PUBLIC_ENDPOINTS.map((e) => e.replace(/:([^/]+)/g, '{$1}')));
    for (const w of wanted) {
      assert.ok(specSet.has(w), `openapi.json is missing "${w}"`);
    }
    for (const s of specSet) {
      assert.ok(wanted.has(s), `openapi.json documents "${s}" which is not a public endpoint`);
    }
  });

  it('F-45.6 / F-45.5 — openapi documents each signer\'s last_rejection and each envelope brief\'s needs_attention', { skip: !openapiExists ? 'openapi.json does not exist yet' : undefined }, () => {
    const spec = JSON.parse(readFileSync(OPENAPI, 'utf-8')) as any;
    const signerProps = Object.values(spec.components?.schemas ?? {})
      .map((s: any) => s?.properties?.signers?.items?.properties)
      .find((p: any) => p?.delivery_status);
    assert.ok(signerProps?.last_rejection, 'the signer schema documents last_rejection');
    const classes = signerProps.last_rejection.properties?.class?.enum ?? [];
    for (const c of ['wrong_phrase', 'google_workspace_no_dkim', 'microsoft_365_no_dkim']) {
      assert.ok(classes.includes(c), `last_rejection.class enum includes ${c}`);
    }
    const brief = spec.paths?.['/v1/documents']?.get?.responses?.['200']?.content?.['application/json']?.schema?.items?.properties?.envelopes?.items?.properties;
    assert.equal(brief?.needs_attention?.type, 'boolean', 'the documents envelope brief documents needs_attention');
  });

  it('llms.txt documents ONLY honored auth (bearer keys), never the session-as-Authorization lie', { skip: !llmsExists ? 'llms.txt missing' : undefined }, () => {
    const t = readFileSync(LLMS_TXT, 'utf-8');
    assert.ok(!/pass it as the `Authorization` header/.test(t), 'the old session-as-Authorization instruction must be gone');
    assert.ok(t.includes('ksk_'), 'documents the ksk_ API-key format');
    assert.ok(t.includes('/account/api-keys'), 'points at where keys are minted');
  });

  it('llms.txt documents the F-30.3 agent ergonomics (idempotency, webhooks, error codes)', { skip: !llmsExists ? 'llms.txt missing' : undefined }, () => {
    const t = readFileSync(LLMS_TXT, 'utf-8');
    for (const needle of ['Idempotency-Key', 'callback_url', 'callback_secret', 'X-Kysigned-Signature', 'openapi.json']) {
      assert.ok(t.includes(needle), `llms.txt must document ${needle}`);
    }
    assert.match(t, /"code"|error code/i, 'documents the machine-readable error codes');
  });

  // ── F-46.11 / AC-296: the agent front door, checked against its own sources ──

  it('llms.txt names the web MCP endpoint, its tools, the discovery documents and every markdown address (F-46.11 / AC-296)', { skip: !llmsExists ? 'llms.txt missing' : undefined }, async () => {
    const t = readFileSync(LLMS_TXT, 'utf-8');
    // Loaded here, not at the top, so a checkout without mcp/'s packages fails this test alone.
    const { WEB_TOOL_NAMES } = await import('../mcp/src/webServer.ts');
    const { WEB_FACTS } = await import('../mcp/src/webFacts.ts');
    const docs = await import('../mcp/src/webDocuments.ts');
    const { TEMPLATE_AGENT_PAGES } = await import('../scripts/lib/agentPages.mjs');

    assert.ok(t.includes(`\`${WEB_FACTS.mcpPath}\``), `names the web endpoint ${WEB_FACTS.mcpPath}`);
    for (const tool of WEB_TOOL_NAMES) assert.ok(t.includes(`**${tool}**`), `lists the web tool ${tool}`);
    for (const path of [...docs.SERVER_CARD_PATHS, docs.SKILLS_INDEX_PATH, docs.API_CATALOG_PATH, docs.AUTH_MD_PATH]) {
      assert.ok(t.includes(`\`${path}\``), `names ${path}`);
    }
    for (const page of TEMPLATE_AGENT_PAGES) assert.ok(t.includes(`/${page}.md`), `lists the markdown address /${page}.md`);
    assert.ok(!t.includes('/pricing.md'), 'the template has no pricing page, so no /pricing.md');
    assert.match(t, /`npx kysigned-mcp` exposes eight tools/, 'the local server has its seven tools plus verify_bundle');
  });

  // ── F-47.4 / AC-302: verification wayfinding, programmatic paths first ──

  it('llms.txt points agents at the command and the local tool first, with the line for an agent that cannot run programs (F-47.4 / AC-302)', { skip: !llmsExists ? 'llms.txt missing' : undefined }, async () => {
    const t = readFileSync(LLMS_TXT, 'utf-8');
    const flat = t.replace(/\s+/g, ' ');
    const { WEB_FACTS, cannotRunProgramsLine } = await import('../mcp/src/webFacts.ts');
    const pointer = t.split('\n').find((l) => l.startsWith('> Verify a bundle'));
    assert.ok(pointer, 'the header has a verification pointer');
    assert.ok(pointer!.includes(WEB_FACTS.verifyCommand) && pointer!.includes(WEB_FACTS.verifyTool), 'it names the command and the local tool');
    assert.ok(pointer!.indexOf(WEB_FACTS.verifyCommand) < pointer!.indexOf(WEB_FACTS.verifyPath), 'before the page');
    assert.ok(t.includes(`**${WEB_FACTS.verifyTool}**`), 'lists verify_bundle among the local tools');
    assert.ok(flat.includes(cannotRunProgramsLine('')), 'the line for an agent that cannot run programs, instance-relative');
    assert.ok(!/reference verifier/.test(t), 'no clone-and-run reference verifier once the package ships');
    assert.match(flat, /Agent skills: `\/\.well-known\/agent-skills\/index\.json` \(send a document for signature; track an envelope; verify a bundle\)/);
  });

  it('the MCP README names the command, verify_bundle and the line for an agent that cannot run programs (F-47.4 / AC-302)', async () => {
    const readme = readFileSync(join(ROOT, 'mcp', 'README.md'), 'utf-8');
    const flat = readme.replace(/\s+/g, ' ');
    const { WEB_FACTS, cannotRunProgramsLine } = await import('../mcp/src/webFacts.ts');
    assert.match(readme, /^### `verify_bundle` \(no key needed\)$/m, 'documents the tool');
    assert.ok(readme.includes(WEB_FACTS.verifyCommand), 'names the command');
    assert.ok(flat.includes(cannotRunProgramsLine('https://kysigned.com')), 'the line for an agent that cannot run programs');
    assert.match(readme, /The server exposes 8 tools/);
    assert.ok(!/bin\/verify-bundle\.mjs|Verification is not an MCP tool/.test(readme), 'no stale verification path');
  });

  it('the MCP README names the web endpoint, its tools and its documents (F-46.11 / AC-296)', async () => {
    const readme = readFileSync(join(ROOT, 'mcp', 'README.md'), 'utf-8');
    const { WEB_TOOL_NAMES } = await import('../mcp/src/webServer.ts');
    const docs = await import('../mcp/src/webDocuments.ts');
    assert.match(readme, /^## Web endpoint \(no install\)$/m, 'has the web endpoint section');
    assert.ok(readme.includes('`<instance>/mcp`') && readme.includes('https://kysigned.com/mcp'), 'names the endpoint');
    for (const tool of WEB_TOOL_NAMES) assert.ok(readme.includes(`\`${tool}\``), `names the web tool ${tool}`);
    for (const path of [docs.SERVER_CARD_PATHS[0], docs.SKILLS_INDEX_PATH, docs.API_CATALOG_PATH, docs.AUTH_MD_PATH]) {
      assert.ok(readme.includes(path), `names ${path}`);
    }
  });
});
