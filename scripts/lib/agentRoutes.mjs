/**
 * agentRoutes — the one route table for the kysigned-agent function (F-46,
 * DD-73), shared by both deploy paths (kysigned.com's scripts/deploy.ts and the
 * forker scripts/deploy.mjs; run402.json is lockstep-tested against it).
 *
 * run402 matches routes on path and method only, exact or a final `/*`, and a
 * method-compatible dynamic route beats a static file. So every agent URL is an
 * exact route here. `/mcp` takes every method: a GET-only or POST-only route
 * would let other methods fall through to the static host and the SPA shell.
 * Everything else is GET and HEAD. Never routed here: `/`, `/dashboard` (the
 * GH#20 magic-link landing) and the legal pages.
 *
 * The one prefix route, the skills directory, also takes every method, and the
 * function answers the rest itself (OPTIONS as the CORS preflight, a mutation
 * as a JSON 405). A GET/HEAD-only function wildcard cannot pass both platform
 * checks: the SDK raises WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS, which
 * requires confirmation and stops the apply, and the field it offers to
 * acknowledge that (`acknowledge_readonly`) is refused by run402's release
 * validator, which accepts only pattern, methods, target and pricing
 * (2026-09-25: the first live apply failed on it with INVALID_SPEC).
 */

export const AGENT_FUNCTION_NAME = 'kysigned-agent';

const READ = Object.freeze(['GET', 'HEAD']);

/** The documents (the MCP endpoint and the pages are added below). */
export const AGENT_DOCUMENT_PATTERNS = Object.freeze([
  '/mcp/server-card',
  '/.well-known/mcp/server-card.json',
  '/.well-known/agent-skills/*',
  '/.well-known/api-catalog',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/.well-known/openid-configuration',
  '/auth.md',
]);

/**
 * The route entries for an instance whose negotiated pages are `pages`
 * (the template: TEMPLATE_AGENT_PAGES; kysigned.com adds `pricing`).
 */
export function agentRoutes(pages) {
  const target = () => ({ type: 'function', name: AGENT_FUNCTION_NAME });
  const routes = [{ pattern: '/mcp', target: target() }];
  for (const pattern of AGENT_DOCUMENT_PATTERNS) {
    routes.push(pattern.endsWith('/*') ? { pattern, target: target() } : { pattern, methods: [...READ], target: target() });
  }
  for (const page of pages) {
    for (const pattern of [`/${page}`, `/${page}.html`, `/${page}.md`]) {
      routes.push({ pattern, methods: [...READ], target: target() });
    }
  }
  return routes;
}
