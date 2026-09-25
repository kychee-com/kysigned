/**
 * forkerDeploy.test.ts — #114 regression: the forker `scripts/deploy.mjs` assembles
 * the F-29.6 CRON-LESS release shape (1 function + email/schedule triggers, ZERO
 * cron functions), and its invariant self-check rejects the old stale shape that
 * bundled the deleted src/functions/crons.ts + six cron functions.
 *
 * The test imports the (side-effect-free, main()-guarded) spec builders from the
 * .mjs deploy script and asserts the shape with injected fakes — no esbuild run and
 * no built SPA needed. The `--dry-run` path exercises the SAME builders + self-check
 * against the REAL esbuild bundle (proving the Windows build), separately.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildApiTriggers,
  buildForkerReleaseSpec,
  assertForkerSpecShape,
  FORKER_APPLY_OPTIONS,
  loadSiteFrom,
} from '../../scripts/deploy.mjs';
import { KYSIGNED_RUN402_FUNCTIONS, bundleRun402Function } from '../../scripts/run402-functions.mjs';
import { agentRoutes } from '../../scripts/lib/agentRoutes.mjs';
import { TEMPLATE_AGENT_PAGES } from '../../scripts/lib/agentPages.mjs';

const fakeBundle = async () => 'export default async () => new Response("ok");';
const fakeSite = async () => ({ 'index.html': '<!doctype html>' });
const fakeMigrations = async () => [{ id: '001_schema', sql: 'select 1;' }];

describe('#114 — forker deploy.mjs assembles the F-29.6 cron-less shape', () => {
  it('produces the api function (with its triggers) and the agent function, and zero cron functions', async () => {
    const spec = await buildForkerReleaseSpec({
      projectId: 'prj_test',
      signingMailboxId: 'mbx_test',
      bundle: fakeBundle,
      loadSite: fakeSite,
      loadMigrationSet: fakeMigrations,
    });
    // the invariant self-check the --dry-run also runs
    assert.ok(assertForkerSpecShape(spec));

    const fns = spec.functions.replace as Record<string, { schedule?: string; triggers?: Array<{ type: string; events?: string[] }> }>;
    assert.deepEqual(Object.keys(fns).sort(), ['kysigned-agent', 'kysigned-api'], 'the api and the agent front door (F-46)');
    assert.equal(fns['kysigned-agent']!.triggers, undefined, 'the agent function has no triggers');
    // ZERO cron functions: none carries a top-level `schedule` (the OLD per-cron shape).
    for (const [name, fn] of Object.entries(fns)) {
      assert.ok(!('schedule' in fn), `function ${name} must not carry a cron schedule`);
    }
    const triggers = fns['kysigned-api']!.triggers ?? [];
    assert.equal(triggers.filter((t) => t.type === 'schedule').length, 2, 'two schedule triggers (grant monitor + archive reconciliation)');
    assert.equal(triggers.filter((t) => t.type === 'email').length, 2, 'two email triggers');

    // /v1/* routes to the api function; the SPA (site) is attached.
    const route = (spec.routes.replace as Array<{ pattern: string; target: { name: string } }>).find((r) => r.pattern === '/v1/*');
    assert.equal(route?.target.name, 'kysigned-api');
    assert.ok(spec.site, 'the built SPA is attached to the release');
  });

  it('the schedule triggers are the daily grant monitor + archive reconciliation; the email triggers are reply_received + bounced on the signing mailbox', () => {
    const triggers = buildApiTriggers('mbx_x') as Array<{ id: string; type: string; cron?: string; mailbox?: string; events?: string[]; run?: { event_type?: string } }>;
    const schedules = triggers.filter((t) => t.type === 'schedule');
    const grant = schedules.find((t) => t.id === 'signup-grant-monitor');
    assert.equal(grant?.cron, '0 9 * * *');
    const reconcile = schedules.find((t) => t.id === 'archive-reconciliation');
    assert.equal(reconcile?.cron, '31 7 * * *', 'daily archive-confirmation backstop (F-32.7)');
    assert.equal(reconcile?.run?.event_type, 'archive_reconciliation_sweep');

    const email = triggers.filter((t) => t.type === 'email');
    assert.deepEqual(email.flatMap((t) => t.events ?? []).sort(), ['bounced', 'reply_received']);
    for (const t of email) assert.equal(t.mailbox, 'mbx_x', 'email triggers bind the signing mailbox id');
  });

  it('the self-check REJECTS the stale multi-function / cron-bearing shape (the #114 bug)', () => {
    // A spec shaped like the OLD deploy.mjs: the api function PLUS a standalone cron
    // function carrying a top-level `schedule`. The F-29.6 invariant must reject it.
    const stale = {
      functions: {
        replace: {
          'kysigned-api': { runtime: 'node22', source: '', triggers: buildApiTriggers('m') },
          'cron-forward-reconciler': { runtime: 'node22', source: '', schedule: '* * * * *' },
        },
      },
      routes: { replace: [{ pattern: '/v1/*', target: { type: 'function', name: 'kysigned-api' } }] },
    };
    assert.throws(() => assertForkerSpecShape(stale), /expected exactly the functions|cron-less violated/i);
  });
});

// ── F-30.2 (spec 0.39.0 / 46.6) — optional x402 priced route, forker parity ──
// The mechanism is [both]: a forker opts in with KYSIGNED_X402_PRICE_USD_MICROS
// (and needs an org payout wallet on run402); the default emits NO pricing
// anywhere (fork-inert, F-13 posture).
describe('F-30.2 — optional x402 priced route in the forker release spec', () => {
  const base = {
    projectId: 'prj_test',
    signingMailboxId: 'mbx_test',
    bundle: fakeBundle,
    loadSite: fakeSite,
    loadMigrationSet: fakeMigrations,
  };

  it('default (no x402 config) → routes are the agent routes, then the /v1/* catch-all', async () => {
    const spec = await buildForkerReleaseSpec({ ...base });
    const routes = spec.routes.replace as Array<{ pattern: string }>;
    assert.deepEqual(routes.map((r) => r.pattern), [...agentRoutes(TEMPLATE_AGENT_PAGES).map((r: { pattern: string }) => r.pattern), '/v1/*']);
    assert.equal(JSON.stringify(spec).includes('"pricing"'), false, 'no pricing object anywhere');
  });

  it('x402PriceUsdMicros > 0 → the exact POST priced route precedes the catch-all (mode:always, org_default_payout)', async () => {
    const spec = await buildForkerReleaseSpec({ ...base, x402PriceUsdMicros: 250_000 });
    assert.ok(assertForkerSpecShape(spec), 'the cron-less invariant still holds with the priced route');
    const routes = spec.routes.replace as Array<Record<string, unknown>>;
    assert.deepEqual(routes[0], {
      pattern: '/v1/x402/envelope',
      methods: ['POST'],
      target: { type: 'function', name: 'kysigned-api' },
      pricing: { mode: 'always', amount_usd_micros: 250_000, pay_to: 'org_default_payout' },
    });
    assert.equal((routes[routes.length - 1] as { pattern: string }).pattern, '/v1/*', 'catch-all stays last');
  });

  it('a non-positive price emits no pricing (0, negative, NaN)', async () => {
    for (const bad of [0, -5, Number.NaN]) {
      const spec = await buildForkerReleaseSpec({ ...base, x402PriceUsdMicros: bad });
      assert.equal(JSON.stringify(spec).includes('"pricing"'), false, `price=${bad}`);
      assert.equal((spec.routes.replace as Array<{ pattern: string }>).length, agentRoutes(TEMPLATE_AGENT_PAGES).length + 1);
    }
  });
});

// ── F-46 (spec 0.74.0, #164) — the agent front door on the forker path ────────
describe('F-46 — the kysigned-agent function in the forker release', () => {
  const base = {
    projectId: 'prj_test',
    signingMailboxId: 'mbx_test',
    bundle: fakeBundle,
    loadSite: fakeSite,
    loadMigrationSet: fakeMigrations,
  };

  it('every agent route targets the agent function, ahead of the /v1/* catch-all', async () => {
    const spec = await buildForkerReleaseSpec({ ...base, x402PriceUsdMicros: 250_000 });
    const routes = spec.routes.replace as Array<{ pattern: string; methods?: string[]; target: { name: string } }>;
    for (const want of agentRoutes(TEMPLATE_AGENT_PAGES)) {
      assert.deepEqual(routes.find((r) => r.pattern === want.pattern), want, want.pattern);
    }
    assert.equal(routes[0]!.pattern, '/v1/x402/envelope', 'the priced route stays first');
    assert.equal(routes[routes.length - 1]!.pattern, '/v1/*', 'the catch-all stays last');
    assert.equal(routes.find((r) => r.pattern === '/mcp')?.target.name, 'kysigned-agent');
  });

  it('the self-check rejects a release without the agent, or with an agent carrying triggers', async () => {
    const spec = await buildForkerReleaseSpec({ ...base });
    const noAgent = structuredClone(spec);
    delete noAgent.functions.replace['kysigned-agent'];
    assert.throws(() => assertForkerSpecShape(noAgent), /expected exactly the functions/);
    const agentTriggers = structuredClone(spec);
    agentTriggers.functions.replace['kysigned-agent'].triggers = buildApiTriggers('m');
    assert.throws(() => assertForkerSpecShape(agentTriggers), /agent function carries no triggers/);
    const noMcpRoute = structuredClone(spec);
    noMcpRoute.routes.replace = noMcpRoute.routes.replace.filter((r: { pattern: string }) => r.pattern !== '/mcp');
    assert.throws(() => assertForkerSpecShape(noMcpRoute), /\/mcp must route to the agent function/);
  });

  it('the apply allows exactly the two reviewed route warnings: page shadowing and the public agent ingress', () => {
    assert.deepEqual([...FORKER_APPLY_OPTIONS.allowWarningCodes].sort(), ['PUBLIC_ROUTED_FUNCTION', 'ROUTE_SHADOWS_STATIC_PATH']);
  });

  it('the uploaded site carries the staged pages and their markdown twins', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'forker-dist-'));
    for (const page of TEMPLATE_AGENT_PAGES) writeFileSync(join(dist, `${page}.html`), `<html><body><main><h1>${page}</h1></main></body></html>`);
    writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    const files = (await loadSiteFrom(dist)) as Record<string, unknown>;
    for (const page of TEMPLATE_AGENT_PAGES) {
      assert.ok(`${page}.html` in files, `${page}.html stays at its public path`);
      assert.ok(`_agent/pages/${page}.html` in files, `${page}.html is staged for the agent`);
      assert.ok(`_agent/pages/${page}.md` in files, `${page}.md twin is uploaded`);
    }
  });

  it('the agent function bundles standalone: its dependencies inlined, the version defined', async () => {
    const fn = KYSIGNED_RUN402_FUNCTIONS.find((f: { name: string }) => f.name === 'kysigned-agent');
    assert.ok(fn, 'the shared function manifest lists kysigned-agent');
    const source = await bundleRun402Function(fn);
    const imports = [...source.matchAll(/^import .* from ["']([^"']+)["'];?$/gm)].map((m) => m[1]!);
    assert.ok(imports.length > 0);
    for (const spec of imports) assert.match(spec, /^node:/, `only Node built-ins stay imports (found ${spec}): the MCP SDK, zod and x402 are bundled in`);
    const mcpVersion = JSON.parse((await import('node:fs')).readFileSync(join(import.meta.dirname, '..', '..', 'mcp', 'package.json'), 'utf8')).version;
    assert.ok(source.includes(JSON.stringify(mcpVersion)), 'the server version is inlined');
  });
});
