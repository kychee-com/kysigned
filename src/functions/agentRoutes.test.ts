/**
 * The agent route table (82.6, F-46, DD-73): one declarative table, used by
 * both deploy paths, routes every F-46 URL to the kysigned-agent function.
 * It must never shadow the magic-link landing (GH#20), the homepage (which
 * stays static, F-46.8) or a legal page, and it must stay in lockstep with
 * what the function actually serves.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_FUNCTION_NAME, agentRoutes } from '../../scripts/lib/agentRoutes.mjs';
import { TEMPLATE_AGENT_PAGES } from '../../scripts/lib/agentPages.mjs';
import { matchPagePath } from '../../mcp/src/webPages.js';
import { handleDocumentRequest } from '../../mcp/src/webDocuments.js';

const KYSIGNED_COM_PAGES = [...TEMPLATE_AGENT_PAGES, 'pricing'];

describe('agentRoutes', () => {
  it('routes the web MCP endpoint, every document and every page URL form to kysigned-agent', () => {
    const routes = agentRoutes(TEMPLATE_AGENT_PAGES);
    const patterns = routes.map((r) => r.pattern);
    for (const p of [
      '/mcp',
      '/mcp/server-card',
      '/.well-known/mcp/server-card.json',
      '/.well-known/agent-skills/*',
      '/.well-known/api-catalog',
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource',
      '/.well-known/openid-configuration',
      '/auth.md',
    ]) {
      assert.ok(patterns.includes(p), `${p} is routed`);
    }
    for (const page of TEMPLATE_AGENT_PAGES) {
      for (const form of [`/${page}`, `/${page}.html`, `/${page}.md`]) assert.ok(patterns.includes(form), `${form} is routed`);
    }
    assert.equal(new Set(patterns).size, patterns.length, 'no duplicate patterns');
    for (const r of routes) assert.deepEqual(r.target, { type: 'function', name: AGENT_FUNCTION_NAME });
    assert.equal(AGENT_FUNCTION_NAME, 'kysigned-agent');
  });

  it('/mcp and the skills directory take every method; everything else is GET and HEAD', () => {
    for (const r of agentRoutes(KYSIGNED_COM_PAGES)) {
      if (r.pattern === '/mcp' || r.pattern === '/.well-known/agent-skills/*') assert.equal(r.methods, undefined, r.pattern);
      else assert.deepEqual(r.methods, ['GET', 'HEAD'], r.pattern);
    }
  });

  it('never shadows the magic-link landing, the homepage or a legal page', () => {
    for (const r of agentRoutes(KYSIGNED_COM_PAGES)) {
      const p = r.pattern;
      assert.ok(p !== '/dashboard' && !p.startsWith('/dashboard/'), `${p} shadows the GH#20 landing`);
      assert.ok(!['/', '/index.html', '/home.html', '/*'].includes(p), `${p} would take the homepage off the static host`);
      assert.ok(!/^\/(terms|privacy|cookies|aup|dpa)(\.html|\.md)?$/.test(p), `${p} is a legal page`);
      assert.ok(!p.includes('*') || p === '/.well-known/agent-skills/*', `${p}: the only prefix route is the skills directory`);
    }
  });

  // Two platform checks meet here. run402's release validator accepts exactly these route keys
  // and refuses any other with INVALID_SPEC before a plan exists (run402-core
  // packages/release/src/routes.ts:82 at 61d1f9f); the first live apply of this table was refused
  // for `acknowledge_readonly` (2026-09-25, plan 82.10). And the run402 SDK raises
  // WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS (requires confirmation, so the apply stops before
  // upload) for a final-wildcard function route limited to GET/HEAD; its acknowledgement field is
  // the one the gateway refuses. So no route may carry another key, and no function wildcard may
  // be read-only: the skills directory takes every method and the function answers the rest.
  it('carries only the route keys run402 accepts, and no read-only function wildcard', () => {
    const accepted = new Set(['pattern', 'methods', 'target', 'pricing']);
    for (const r of agentRoutes(KYSIGNED_COM_PAGES) as Array<Record<string, unknown> & { pattern: string; methods?: string[] }>) {
      for (const key of Object.keys(r)) assert.ok(accepted.has(key), `${r.pattern}: run402 refuses the route key ${key}`);
      const readOnlyWildcard = r.pattern.endsWith('/*') && !!r.methods && r.methods.every((m) => m === 'GET' || m === 'HEAD');
      assert.ok(!readOnlyWildcard, `${r.pattern}: a GET/HEAD-only function wildcard stops the SDK apply`);
    }
  });

  it('kysigned.com adds pricing; the template does not have it', () => {
    assert.ok(agentRoutes(KYSIGNED_COM_PAGES).some((r) => r.pattern === '/pricing.html'));
    assert.ok(!agentRoutes(TEMPLATE_AGENT_PAGES).some((r) => r.pattern.startsWith('/pricing')));
  });

  it('lockstep: every routed URL is one the function serves', () => {
    const origin = 'https://kysigned.test';
    for (const r of agentRoutes(KYSIGNED_COM_PAGES)) {
      const path = r.pattern === '/.well-known/agent-skills/*' ? '/.well-known/agent-skills/index.json' : r.pattern;
      if (path === '/mcp') continue; // the MCP endpoint itself (webFunction dispatches it first)
      const served =
        matchPagePath(path) !== null || handleDocumentRequest(new Request(`${origin}${path}`), { origin, version: '0' }) !== null;
      assert.ok(served, `${path} is routed to the function but the function does not serve it`);
    }
  });
});
