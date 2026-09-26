/**
 * webDocuments — the agent discovery documents and honest 404s the web front
 * door serves (F-46.4, F-46.5, F-46.7, F-46.9, F-46.10). Every document is
 * built from the request's origin and webFacts.ts, so a fork advertises its
 * own URLs and every auth/payment statement comes from the one checked source.
 *
 * Normative shapes:
 * - MCP Server Card v1 (SEP-2127; modelcontextprotocol/experimental-ext-server-card
 *   schema.ts): `$schema`, reverse-DNS `name`, `version`, `description` (<= 100
 *   chars), `remotes`, `_meta`; no tool listing (the live tools/list is the source).
 * - Agent Skills Discovery RFC v0.2.0 (cloudflare/agent-skills-discovery-rfc):
 *   `$schema`, `skills[]` of {name, type, description, url, digest = "sha256:<hex>"},
 *   index as application/json, SKILL.md as text/markdown, GET and HEAD.
 * - RFC 9727 API catalog: an RFC 9264 linkset as application/linkset+json.
 *
 * Outbound copy: no em or en dashes (the outbound-dash guard scans these literals).
 */
import { createHash } from 'node:crypto';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { WEB_FACTS, cannotRunProgramsLine } from './webFacts.js';

export interface DocumentDeps {
  /** The instance's public origin, e.g. https://kysigned.com (no trailing slash). */
  origin: string;
  /** The server version the card reports. */
  version: string;
}

export const SERVER_CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';
export const SERVER_CARD_MEDIA_TYPE = 'application/mcp-server-card+json';
export const SKILLS_INDEX_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';
export const API_CATALOG_CONTENT_TYPE = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';

export const SERVER_CARD_PATHS = ['/.well-known/mcp/server-card.json', '/mcp/server-card'] as const;
export const SKILLS_PREFIX = '/.well-known/agent-skills/';
export const SKILLS_INDEX_PATH = '/.well-known/agent-skills/index.json';
export const API_CATALOG_PATH = '/.well-known/api-catalog';
export const AUTH_MD_PATH = '/auth.md';
export const OAUTH_DISCOVERY_PATHS = [
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/.well-known/openid-configuration',
] as const;

const JSON_TYPE = 'application/json; charset=utf-8';
const MARKDOWN_TYPE = 'text/markdown; charset=utf-8';

/** Reverse-DNS server name from the instance host: kysigned.com -> com.kysigned/kysigned. */
function serverName(origin: string): string {
  const host = new URL(origin).hostname;
  return `${host.split('.').reverse().join('.')}/kysigned`;
}

export function serverCard(deps: DocumentDeps): Record<string, unknown> {
  const { origin } = deps;
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: serverName(origin),
    version: deps.version,
    description: 'E-signatures where the signature is an email: create, pay for and track envelopes.',
    title: 'kysigned',
    websiteUrl: origin,
    repository: { url: WEB_FACTS.publicRepo, source: 'github', subfolder: 'mcp' },
    remotes: [
      {
        type: 'streamable-http',
        url: `${origin}${WEB_FACTS.mcpPath}`,
        supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      },
    ],
    _meta: {
      'com.kysigned/local-server': {
        registryType: 'npm',
        identifier: WEB_FACTS.localPackage,
        transport: 'stdio',
        command: `npx -y ${WEB_FACTS.localPackage}`,
        environment: { KYSIGNED_ENDPOINT: origin },
        note: 'On your own machine: the key-authenticated tools, the x402 create from a local wallet, and verify_bundle.',
      },
    },
  };
}

interface Skill {
  name: string;
  description: string;
  body: string;
}

function skillList(origin: string): Skill[] {
  const f = WEB_FACTS;
  const send: Skill = {
    name: 'kysigned-send-for-signature',
    description:
      'Send a PDF for e-signature with kysigned. Signers sign by forwarding an email, and every party receives a ' +
      'self-verifying evidence bundle. Pay per envelope from your own wallet over x402 with no account, or use a ' +
      'creator API key.',
    body: [
      '# Send a document for signature with kysigned',
      '',
      'Use this when a person or an agent needs a PDF signed by one or more people. Signers are always people: they',
      'sign by forwarding the signing email with "I sign this document" as the first line. When everyone has signed,',
      'every party receives the evidence bundle by email.',
      '',
      '## Option A: the web MCP endpoint, nothing to install',
      '',
      `1. Connect an MCP client to ${origin}${f.mcpPath} (streamable HTTP, no auth).`,
      '2. Call `explain_kysigned` for the whole picture and `check_price` for the live per-envelope price.',
      '3. Call `create_envelope_x402` with `creator_email`, `document_name`, exactly one of `pdf_base64` or `pdf_url`,',
      '   and `signers` (name and email each). It validates the request for free, then answers "payment required".',
      '4. An x402-capable MCP client signs the payment with your own wallet and calls again with it attached',
      '   (`_meta` "x402/payment"). The result carries the envelope id, the payment receipt and a tracking token.',
      '',
      'Calling again with the same request replays the first envelope instead of paying twice. Pass a new',
      '`idempotency_key` only when you want a second, identical envelope.',
      '',
      '## Option B: the local MCP server on your own machine',
      '',
      `Run \`npx -y ${f.localPackage}\` with \`KYSIGNED_ENDPOINT=${origin}\`.`,
      '',
      '- `wallet_status` reports whether a local run402 wallet can cover the price.',
      '- `create_envelope_x402` pays from that local wallet, with no account and no key.',
      `- \`create_envelope\` uses a creator API key instead: a person mints one at ${origin}${f.apiKeysPath} and sets`,
      `  \`KYSIGNED_AUTHORIZATION=${f.apiKeyPrefix}...\`. Each create uses one of that account's credits.`,
      '',
      '## Option C: plain HTTP',
      '',
      `- \`POST ${origin}${f.preflightPath}\` validates a request for free.`,
      `- \`POST ${origin}${f.x402CreatePath}\` creates and pays with any x402 client (an unpaid call answers 402 with the terms).`,
      `- \`POST ${origin}/v1/envelope\` with \`Authorization: Bearer ${f.apiKeyPrefix}...\` creates on an account's credits.`,
      '',
      '## After sending',
      '',
      'Track the envelope with the kysigned-track-envelope skill. Authentication details for every path:',
      `${origin}/auth.md`,
      '',
    ].join('\n'),
  };
  const track: Skill = {
    name: 'kysigned-track-envelope',
    description:
      'Track a kysigned envelope after it is sent: signer progress, delivery, rejected forwards, reminders and voiding. ' +
      'Uses the tracking token from the create result with no account, or a creator API key.',
    body: [
      '# Track a kysigned envelope',
      '',
      `Every create returns \`tracking.token\` (${f.trackingTokenPrefix}...). It reads that one envelope and nothing else, with`,
      'no account.',
      '',
      '## With the tracking token',
      '',
      `- Web MCP (${origin}${f.mcpPath}) or the local server: call \`check_envelope_status\` with \`envelope_id\` and`,
      '  `tracking_token`.',
      `- HTTP: \`GET ${origin}/v1/envelope/{id}\` with the token as the \`Authorization\` header.`,
      '',
      'The result lists every signer with their signing status, their `delivery_status` (whether the signing email',
      'reached them) and `last_rejection`: null, or the class and time of their latest rejected forward while they',
      'still owe a signature. The classes `google_workspace_no_dkim` and `microsoft_365_no_dkim` mean the signer cannot',
      "fix it by forwarding again: their organization must turn on DKIM, or the creator can change that signer's address.",
      '',
      '## With a creator API key (local server)',
      '',
      `Set \`KYSIGNED_AUTHORIZATION=${f.apiKeyPrefix}...\` for \`npx -y ${f.localPackage}\`:`,
      '',
      '- `list_envelopes` lists the envelopes that account sent.',
      '- `check_envelope_status` reads one envelope with the key.',
      '- `send_reminder` emails every pending signer again.',
      '- `void_envelope` cancels an open envelope (irreversible).',
      '',
      '## When it completes',
      '',
      'Every party, including the creator email, receives the evidence bundle. Verify it on your own machine, never by',
      `uploading it anywhere: run \`${f.verifyCommand} <bundle.pdf>\` or call \`${f.verifyTool}\` on the local server. A person`,
      `can open ${origin}${f.verifyPath} in a browser. The kysigned-verify-bundle skill has the details.`,
      '',
    ].join('\n'),
  };
  const verify: Skill = {
    name: 'kysigned-verify-bundle',
    description:
      'Verify a kysigned evidence bundle (the signed PDF every party receives) on your own machine, with no account ' +
      'and no upload: npx kysigned verify, or verify_bundle on the local MCP server. The web verifier page is for people.',
    body: [
      '# Verify a kysigned evidence bundle',
      '',
      'Use this when you have a completed kysigned bundle (the PDF every party receives when an envelope completes)',
      'and need to know whether it holds. Verification always runs on the machine that holds the bundle: never upload',
      'a bundle to anyone, including the service that produced it. The check uses public math and public keys, so',
      'kysigned is not part of what you trust.',
      '',
      '## Option A: the command line (Node 22 or later, nothing to clone)',
      '',
      `\`${f.verifyCommand} <bundle.pdf>\``,
      '',
      '- Exit 0: verified at the tier it prints. Exit 1: FAILED, with the reasons. Exit 2: the file could not be read,',
      '  or the command was wrong.',
      '- `--json` prints one document (schema `kysigned.verdict.v1`): the bundle tier, each signer\'s tier, checks and',
      '  reasons, and `originalDocSha256`, the SHA-256 of the document every signer signed.',
      '- `--offline` skips the two online indicators (the Bitcoin timestamp anchor and the public key archive). They',
      '  report pending, and the verdict still holds.',
      '',
      '## Option B: the local MCP server',
      '',
      `Run \`npx -y ${f.localPackage}\` and call \`${f.verifyTool}\` with exactly one of \`path\` (the file on that machine)`,
      'or `pdf_base64`, and optionally `offline: true`. It needs no key and no wallet, and returns the same document as',
      'structured content plus a readable report. A FAILED verdict is a result, not a tool error.',
      `The web endpoint (${origin}${f.mcpPath}) has no verify tool, by design.`,
      '',
      '## Reading the verdict',
      '',
      'The tiers, weakest first: FAILED; INTEGRITY_VERIFIED (valid email signatures, the matching document, the intent',
      'line and a timestamp); PROVIDER_KEY_CONFIRMED (the signing key is confirmed as the email provider\'s own);',
      'PROVEN_DURABLE (also a Bitcoin-anchored time inside the key\'s observed lifetime). The bundle\'s tier is its',
      'weakest signer\'s. To check that a document you hold is the one that was signed, compare its SHA-256 with',
      '`originalDocSha256`.',
      '',
      '## If you cannot run programs',
      '',
      cannotRunProgramsLine(origin),
      '',
      '## For people',
      '',
      `${origin}${f.verifyPath} runs the same check in a browser, and the file never leaves the device.`,
      '',
    ].join('\n'),
  };
  return [send, track, verify];
}

function skillMarkdown(s: Skill): string {
  // JSON strings are valid YAML double-quoted scalars.
  return `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body}`;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(new TextEncoder().encode(text)).digest('hex');
}

export function skillsIndex(origin: string): Record<string, unknown> {
  return {
    $schema: SKILLS_INDEX_SCHEMA,
    skills: skillList(origin).map((s) => ({
      name: s.name,
      type: 'skill-md',
      description: s.description,
      url: `${origin}${SKILLS_PREFIX}${s.name}/SKILL.md`,
      digest: `sha256:${sha256Hex(skillMarkdown(s))}`,
    })),
  };
}

export function authMarkdown(origin: string): string {
  const f = WEB_FACTS;
  return [
    '# Authenticating to kysigned',
    '',
    'kysigned has no OAuth and no agent self-registration: an agent cannot mint its own key. A person mints a key, or',
    'the agent pays per envelope from its own wallet. There are four ways in, and three need no account at all.',
    '',
    '## 1. The web MCP endpoint: no auth',
    '',
    `${origin}${f.mcpPath} speaks MCP over streamable HTTP. It needs no account, no key and no session, and it never`,
    'uses anyone\'s credits. Its tools are `explain_kysigned`, `check_price`, `check_envelope_status` (with a tracking',
    'token) and `create_envelope_x402` (paid from your own wallet).',
    '',
    '## 2. Paying per envelope with a wallet (x402): no account, no key',
    '',
    'The payment is the authorization. Use any of:',
    '',
    `- \`POST ${origin}${f.x402CreatePath}\` with any x402 client (an unpaid call answers 402 with the exact terms);`,
    '- `create_envelope_x402` on the web endpoint, from an MCP client that supports x402;',
    `- \`create_envelope_x402\` on the local server (\`npx -y ${f.localPackage}\`) with a local run402 wallet.`,
    '',
    'The request names a `creator_email`: creation and completion mail and the evidence bundle go there, and signing',
    'in with that address later opens the dashboard for the envelope.',
    '',
    `## 3. Creator API keys (${f.apiKeyPrefix}...): an account's credits`,
    '',
    `- A person signs in and mints a key at ${origin}${f.apiKeysPath}. It is shown once.`,
    `- Send it as \`Authorization: Bearer ${f.apiKeyPrefix}...\`; the bare key also works.`,
    '- It acts as its creator for envelope actions only (create, read, list, edit signers, remind, seal, void). It',
    '  cannot manage keys or the account.',
    '- Requests authenticated by a key need no CSRF header.',
    '- Keys can be revoked on the same page; a revoked key stops working on its next use.',
    `- An absent, malformed or revoked key answers \`401 {"code": "${f.errorCodes.invalidKey}"}\`; a key used outside its`,
    `  scope answers \`403 {"code": "${f.errorCodes.keyScope}"}\`.`,
    `- With the local server: set \`KYSIGNED_ENDPOINT=${origin}\` and \`KYSIGNED_AUTHORIZATION=${f.apiKeyPrefix}...\`.`,
    '',
    `## 4. Tracking tokens (${f.trackingTokenPrefix}...): read one envelope`,
    '',
    `Every create returns \`tracking.token\`. Send it as the \`Authorization\` header on \`GET ${origin}${f.envelopeStatusPattern}\`,`,
    'or pass it to `check_envelope_status`. It reads that envelope\'s status and signer roster and nothing else: any',
    `other envelope answers 404, and every other route refuses it with \`403 {"code": "${f.errorCodes.trackingScope}"}\`.`,
    '',
    '## Signers',
    '',
    'Signers never authenticate to kysigned. They sign by forwarding the signing email; their own email provider\'s',
    'signature on that forward is the proof.',
    '',
    '## More',
    '',
    `- ${origin}/llms.txt and ${origin}/openapi.json describe the API.`,
    `- ${origin}/.well-known/api-catalog lists this instance's APIs.`,
    '',
  ].join('\n');
}

export function apiCatalog(origin: string): Record<string, unknown> {
  return {
    linkset: [
      {
        anchor: `${origin}${API_CATALOG_PATH}`,
        item: [
          { href: `${origin}/v1/`, title: 'kysigned REST API' },
          { href: `${origin}${WEB_FACTS.mcpPath}`, title: 'kysigned MCP endpoint' },
        ],
      },
      {
        anchor: `${origin}/v1/`,
        'service-desc': [{ href: `${origin}/openapi.json`, type: 'application/json' }],
        'service-doc': [
          { href: `${origin}/llms.txt`, type: 'text/plain' },
          { href: `${origin}${AUTH_MD_PATH}`, type: 'text/markdown' },
        ],
        status: [{ href: `${origin}/v1/health`, type: 'application/json' }],
      },
      {
        anchor: `${origin}${WEB_FACTS.mcpPath}`,
        'service-desc': [{ href: `${origin}/mcp/server-card`, type: SERVER_CARD_MEDIA_TYPE }],
        'service-doc': [
          { href: `${origin}${AUTH_MD_PATH}`, type: 'text/markdown' },
          { href: `${origin}${SKILLS_INDEX_PATH}`, type: 'application/json' },
        ],
      },
    ],
  };
}

const COMMON_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=300',
};

function respond(req: Request, status: number, body: string, headers: Record<string, string>): Response {
  const h = new Headers({ ...COMMON_HEADERS, ...headers });
  return new Response(req.method === 'HEAD' ? null : body, { status, headers: h });
}

function notFound(req: Request, message: string): Response {
  return respond(req, 404, JSON.stringify({ error: 'Not found', code: 'not_found', message }), { 'Content-Type': JSON_TYPE });
}

/**
 * Serve a discovery document or honest 404, or return null when the path is
 * not one of this module's (the caller dispatches pages and /mcp itself).
 */
export function handleDocumentRequest(req: Request, deps: DocumentDeps): Response | null {
  const path = new URL(req.url).pathname;
  const isOurs =
    (SERVER_CARD_PATHS as readonly string[]).includes(path) ||
    path.startsWith(SKILLS_PREFIX) ||
    path === API_CATALOG_PATH ||
    path === AUTH_MD_PATH ||
    (OAUTH_DISCOVERY_PATHS as readonly string[]).includes(path);
  if (!isOurs) return null;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...COMMON_HEADERS, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' } });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return respond(req, 405, JSON.stringify({ error: 'Method not allowed', code: 'method_not_allowed' }), {
      'Content-Type': JSON_TYPE,
      Allow: 'GET, HEAD, OPTIONS',
    });
  }
  const { origin } = deps;

  if ((SERVER_CARD_PATHS as readonly string[]).includes(path)) {
    const wantsCardType = (req.headers.get('accept') ?? '').toLowerCase().includes(SERVER_CARD_MEDIA_TYPE);
    return respond(req, 200, JSON.stringify(serverCard(deps), null, 2), {
      'Content-Type': wantsCardType ? `${SERVER_CARD_MEDIA_TYPE}; charset=utf-8` : JSON_TYPE,
      Vary: 'Accept',
    });
  }
  if (path === SKILLS_INDEX_PATH) {
    return respond(req, 200, JSON.stringify(skillsIndex(origin), null, 2), { 'Content-Type': JSON_TYPE });
  }
  if (path.startsWith(SKILLS_PREFIX)) {
    const m = /^\/\.well-known\/agent-skills\/([a-z0-9-]+)\/SKILL\.md$/.exec(path);
    const skill = m ? skillList(origin).find((s) => s.name === m[1]) : undefined;
    if (!skill) return notFound(req, `No such skill. The index is at ${origin}${SKILLS_INDEX_PATH}.`);
    return respond(req, 200, skillMarkdown(skill), { 'Content-Type': MARKDOWN_TYPE });
  }
  if (path === API_CATALOG_PATH) {
    return respond(req, 200, JSON.stringify(apiCatalog(origin), null, 2), {
      'Content-Type': API_CATALOG_CONTENT_TYPE,
      Link: `<${origin}${API_CATALOG_PATH}>; rel="api-catalog"`,
    });
  }
  if (path === AUTH_MD_PATH) {
    return respond(req, 200, authMarkdown(origin), { 'Content-Type': MARKDOWN_TYPE });
  }
  // The OAuth/OpenID discovery paths (F-46.7): honest, never the SPA's 200.
  return notFound(
    req,
    `kysigned has no OAuth authorization server and its API is not an OAuth protected resource. See ${origin}${AUTH_MD_PATH} for every way to authenticate.`,
  );
}
