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
import {
  buildApiTriggers,
  buildForkerReleaseSpec,
  assertForkerSpecShape,
} from '../../scripts/deploy.mjs';

const fakeBundle = async () => 'export default async () => new Response("ok");';
const fakeSite = async () => ({ 'index.html': '<!doctype html>' });
const fakeMigrations = async () => [{ id: '001_schema', sql: 'select 1;' }];

describe('#114 — forker deploy.mjs assembles the F-29.6 cron-less shape', () => {
  it('produces exactly ONE function (kysigned-api) with the api triggers, and zero cron functions', async () => {
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
    assert.deepEqual(Object.keys(fns), ['kysigned-api'], 'exactly one function, the api');
    // ZERO cron functions: none carries a top-level `schedule` (the OLD per-cron shape).
    for (const [name, fn] of Object.entries(fns)) {
      assert.ok(!('schedule' in fn), `function ${name} must not carry a cron schedule`);
    }
    const triggers = fns['kysigned-api']!.triggers ?? [];
    assert.equal(triggers.filter((t) => t.type === 'schedule').length, 1, 'one schedule trigger');
    assert.equal(triggers.filter((t) => t.type === 'email').length, 2, 'two email triggers');

    // /v1/* routes to the api function; the SPA (site) is attached.
    const route = (spec.routes.replace as Array<{ pattern: string; target: { name: string } }>).find((r) => r.pattern === '/v1/*');
    assert.equal(route?.target.name, 'kysigned-api');
    assert.ok(spec.site, 'the built SPA is attached to the release');
  });

  it('the schedule trigger is the daily signup-grant monitor; the email triggers are reply_received + bounced on the signing mailbox', () => {
    const triggers = buildApiTriggers('mbx_x') as Array<{ id: string; type: string; cron?: string; mailbox?: string; events?: string[] }>;
    const schedule = triggers.find((t) => t.type === 'schedule');
    assert.equal(schedule?.id, 'signup-grant-monitor');
    assert.equal(schedule?.cron, '0 9 * * *');

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
    assert.throws(() => assertForkerSpecShape(stale), /expected exactly 1 function|cron-less violated/i);
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

  it('default (no x402 config) → routes are exactly the /v1/* catch-all', async () => {
    const spec = await buildForkerReleaseSpec({ ...base });
    const routes = spec.routes.replace as Array<{ pattern: string }>;
    assert.deepEqual(routes.map((r) => r.pattern), ['/v1/*']);
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
      assert.equal((spec.routes.replace as Array<{ pattern: string }>).length, 1);
    }
  });
});
