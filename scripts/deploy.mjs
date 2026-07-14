#!/usr/bin/env node
/**
 * deploy.mjs — deploy a kysigned FORK to run402 (F-29.6 cron-less durable-runs model).
 *
 * This is the FORKER deploy path (kysigned.com, the operator, deploys via the
 * private scripts/deploy.ts). It bundles the ONE routed-HTTP+durable-run function
 * (src/functions/api.ts) and ships it — with its run402 triggers, the DB
 * migrations, the SPA (frontend/dist), and the /v1/* route — as ONE atomic run402
 * release via @run402/sdk/node's r.project(id).apply(spec).
 *
 * F-29.6 — NO CRONS (#114). All periodic/background work is run402 durable runs
 * created in-function or by the triggers below. The six scheduled cron functions
 * (the removed src/functions/crons.ts + forwardReconcilerCron / forwardNotifierCron
 * / completionBackstopCron / reminderSweepCron / expirySweepCron /
 * timestampUpgradeCron) are GONE; this script no longer bundles them (bundling a
 * deleted crons.ts, and embedding an absolute Windows path as an esbuild import
 * specifier, is exactly what broke the forker deploy on Windows).
 *
 * The api function is invoked two ways (branched inside api.ts by isFunctionRunBody):
 *   • routed HTTP  — every /v1/* request (the /v1/* route below);
 *   • durable run  — a `{ trigger: "function_run", … }` envelope from a trigger:
 *       - `signup-grant-monitor`   schedule (daily) — the trial-credit abuse monitor;
 *       - `inbound-reply-received` email    — a signer's forward (reply_received);
 *       - `inbound-bounced`        email    — a bounce on the signing mailbox.
 * This mirrors the operator deploy.ts trigger set; the run402.json manifest (the
 * `run402 up` path) declares the same function + the two email triggers, so the two
 * forker deploy paths stay in lock-step on the function set (shared bundler below).
 *
 * Run it locally with live creds — it is NOT run by the agent:
 *
 *   # @run402/sdk is a recent release; the local npmrc age-gate needs this flag:
 *   npm install --no-save --min-release-age=0 @run402/sdk @run402/functions
 *   npm run build && npm run build --prefix frontend   # produce dist/ + frontend/dist/
 *   RUN402_PROJECT_ID=prj_xxx \
 *     RUN402_MAILBOX_FORWARD_TO_SIGN_ID=mbx_xxx \
 *     node scripts/deploy.mjs
 *
 *   node scripts/deploy.mjs --dry-run   # bundle + assemble the release spec, apply NOTHING
 *
 * Required env:
 *   RUN402_PROJECT_ID   — the run402 project to deploy to (REQUIRED; not for --dry-run).
 *   RUN402_API_BASE     — run402 API base (default https://api.run402.com).
 *   RUN402_MAILBOX_FORWARD_TO_SIGN_ID — the signing mailbox id the two email
 *                         triggers attach to. If unset, it is resolved from
 *                         RUN402_SERVICE_KEY by listing /mailboxes/v1 for the
 *                         `forward-to-sign` slug (matching run402.json's
 *                         ${RUN402_MAILBOX_FORWARD_TO_SIGN_ID} substitution).
 *   RUN402_SERVICE_KEY  — OPTIONAL. Used to (a) resolve the signing mailbox id when
 *                         the id env is unset, and (b) strip the run402 "Sent by an
 *                         AI agent via run402.com" footer from every mailbox
 *                         (best-effort; hobby/team tiers — prototype keeps it locked).
 * Credentials for the apply come from the local run402 keystore (@run402/sdk/node
 * auto-loads ~/.config/run402/projects.json + the allowance), like the run402 CLI.
 * There are NO operator secrets, NO AWS Secrets Manager, and NO billing function
 * here — those are operator-only (private scripts/deploy.ts).
 *
 * ── UNCERTAINTY (flagged) ────────────────────────────────────────────────────
 * • `@run402/functions` is auto-bundled by run402 at deploy, so it is esbuild-
 *   EXTERNAL (see scripts/run402-functions.mjs); every OTHER dependency is bundled
 *   INTO the function source.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { run402, fileSetFromDir } from '@run402/sdk/node';
import { KYSIGNED_RUN402_FUNCTIONS, ROOT, bundleRun402Function } from './run402-functions.mjs';

// The forker deploys exactly ONE function: the api entry (HTTP + durable-run). Its
// name + entry come from the SHARED bundler manifest (also used by
// build:run402-cloud / run402.json) so this path and `run402 up` can never drift on
// the function set. Named `kysigned-api` to match run402.json + the operator.
const API_FN = KYSIGNED_RUN402_FUNCTIONS[0]; // { name: 'kysigned-api', entryPath: … }

const API_BASE = process.env.RUN402_API_BASE ?? 'https://api.run402.com';

/**
 * The run402 triggers attached to the api function (F-29 / F-29.6) — mirrors the
 * operator deploy.ts buildApiTriggers:
 *   • ONE schedule trigger — the daily trial-credit abuse monitor (the only
 *     genuinely-periodic concern; a cheap no-op when signup grants are disabled);
 *   • TWO email triggers on the signing mailbox — reply_received + bounced. run402
 *     creates a durable run per email event; api.ts dispatches by run.event_type.
 * There are NO cron functions — every other background job (expiry, reminders,
 * timestamp-upgrade, completion) is created event-by-event from inside the function
 * via functions.runs.create.
 */
export function buildApiTriggers(signingMailboxId) {
  return [
    { id: 'signup-grant-monitor', type: 'schedule', cron: '0 9 * * *', run: { event_type: 'signup_grant_monitor' } },
    // F-32.7 — the daily archive-confirmation backstop: re-checks 24-48h-old artifacts
    // whose signing-time archive confirmation is not clean; alerts the operator only.
    { id: 'archive-reconciliation', type: 'schedule', cron: '31 7 * * *', run: { event_type: 'archive_reconciliation_sweep' } },
    {
      id: 'inbound-reply-received',
      type: 'email',
      mailbox: signingMailboxId,
      events: ['reply_received'],
      run: { event_type: 'reply_received', retry: { max_attempts: 5, min_delay_seconds: 30 }, expires_after_seconds: 86400 },
    },
    {
      id: 'inbound-bounced',
      type: 'email',
      mailbox: signingMailboxId,
      events: ['bounced'],
      run: { event_type: 'bounced', retry: { max_attempts: 3, min_delay_seconds: 60 }, expires_after_seconds: 86400 },
    },
  ];
}

/**
 * Read the ordered DB migration set from run402.json (the single source of truth
 * the `run402 up` path also uses), resolving each sql_path to its SQL text. A fresh
 * fork's DB starts empty, so — unlike the operator, whose schema is applied
 * out-of-band (manual-migrations rule) — the forker deploy SHIPS the migrations in
 * the release. Reading them from run402.json keeps deploy.mjs and `run402 up` from
 * drifting on the migration list.
 */
export async function loadMigrations(root = ROOT) {
  const manifest = JSON.parse(await readFile(path.join(root, 'run402.json'), 'utf8'));
  const migs = manifest.release?.database?.migrations ?? [];
  return Promise.all(migs.map(async (m) => ({ id: m.id, sql: await readFile(path.join(root, m.sql_path), 'utf8') })));
}

/** Load the built SPA as a run402 file set (fails clearly if the SPA isn't built). */
async function defaultLoadSite() {
  const dist = path.join(ROOT, 'frontend/dist');
  if (!existsSync(dist)) {
    throw new Error(`SPA not built: ${dist} is missing — run \`npm run build --prefix frontend\` (or \`npm run build:run402-cloud\`) first`);
  }
  return fileSetFromDir(dist);
}

/**
 * Assemble the run402 release spec: ONE function (api) + its triggers, the DB
 * migrations, the SPA site, and the /v1/* route. `bundle`, `loadSite`, and
 * `loadMigrationSet` are injectable so a unit test can assert the shape without
 * running esbuild or needing a built SPA.
 */
export async function buildForkerReleaseSpec({
  projectId,
  signingMailboxId,
  bundle = bundleRun402Function,
  loadSite = defaultLoadSite,
  loadMigrationSet = loadMigrations,
  // F-30.2 — optional x402 machine payment: a positive price (USD micros)
  // declares the always-priced create route below AND should match the fn's
  // KYSIGNED_X402_PRICE_USD_MICROS secret (one value drives both). Requires a
  // resolvable org payout wallet on run402 (else the apply fails
  // PAYOUT_WALLET_REQUIRED). Default 0 → no priced route, fully inert.
  x402PriceUsdMicros = 0,
} = {}) {
  const source = await bundle(API_FN);
  const functionsReplace = {
    [API_FN.name]: { runtime: 'node22', source, triggers: buildApiTriggers(signingMailboxId) },
  };
  const spec = {
    project: projectId,
    database: { migrations: await loadMigrationSet() },
    // The function's load-bearing runtime secrets must exist (set out-of-band via
    // set_secret); the apply fails fast if they are missing.
    secrets: { require: ['RUN402_SERVICE_KEY', 'RUN402_ANON_KEY'] },
    functions: { replace: functionsReplace },
    // Every /v1/* request → the api function; every other path falls through to the
    // static SPA (index.html SPA-fallback) run402 serves after a route miss. The
    // optional x402 create is an EXACT route, so it precedes the catch-all
    // (run402 precedence: exact > longest-prefix > catch-all).
    routes: {
      replace: [
        ...(Number.isFinite(x402PriceUsdMicros) && x402PriceUsdMicros > 0
          ? [{
              pattern: '/v1/x402/envelope',
              methods: ['POST'],
              target: { type: 'function', name: API_FN.name },
              pricing: { mode: 'always', amount_usd_micros: x402PriceUsdMicros, pay_to: 'org_default_payout' },
            }]
          : []),
        { pattern: '/v1/*', target: { type: 'function', name: API_FN.name } },
      ],
    },
  };
  const site = await loadSite();
  if (site) spec.site = { replace: site };
  return spec;
}

/**
 * Resolve the signing (`forward-to-sign`) mailbox id for the two email triggers:
 * prefer the explicit env, else look it up with the service key. Returns null when
 * neither is available (the caller then fails with an actionable message rather
 * than silently deploying without the inbound-email triggers).
 */
export async function resolveSigningMailboxId({ apiBase = API_BASE, env = process.env } = {}) {
  if (env.RUN402_MAILBOX_FORWARD_TO_SIGN_ID) return env.RUN402_MAILBOX_FORWARD_TO_SIGN_ID;
  const serviceKey = env.RUN402_SERVICE_KEY;
  if (!serviceKey) return null;
  const res = await fetch(`${apiBase}/mailboxes/v1`, { headers: { Authorization: `Bearer ${serviceKey}` } });
  if (!res.ok) return null;
  const mailboxes = (await res.json()).mailboxes ?? [];
  return mailboxes.find((m) => m.slug === 'forward-to-sign')?.mailbox_id ?? null;
}

/**
 * Self-check the F-29.6 forker release invariants (run by BOTH --dry-run and the
 * unit test): exactly ONE function, the api function, carrying 2 schedule (grant
 * monitor + archive reconciliation, F-32.7) + 2 email (reply_received + bounced)
 * triggers, and ZERO cron functions (no extra functions, and none carrying a
 * top-level `schedule` — the OLD per-cron shape). Throws on any violation. Returns
 * true so a test can `assert.ok(...)` it.
 */
export function assertForkerSpecShape(spec) {
  const fns = spec.functions?.replace ?? {};
  const names = Object.keys(fns);
  if (names.length !== 1) throw new Error(`expected exactly 1 function, got ${names.length}: ${names.join(', ')}`);
  if (!fns[API_FN.name]) throw new Error(`the one function must be ${API_FN.name}, got ${names[0]}`);
  for (const [name, fn] of Object.entries(fns)) {
    if ('schedule' in fn) throw new Error(`cron-less violated: function ${name} carries a top-level schedule (F-29.6 removed all crons)`);
  }
  const triggers = fns[API_FN.name].triggers ?? [];
  const schedule = triggers.filter((t) => t.type === 'schedule');
  const email = triggers.filter((t) => t.type === 'email');
  if (schedule.length !== 2) throw new Error(`expected 2 schedule triggers, got ${schedule.length}`);
  if (email.length !== 2) throw new Error(`expected 2 email triggers, got ${email.length}`);
  const events = email.flatMap((t) => t.events ?? []);
  for (const ev of ['reply_received', 'bounced']) {
    if (!events.includes(ev)) throw new Error(`missing the ${ev} email trigger`);
  }
  const routes = spec.routes?.replace ?? [];
  const apiRoute = routes.find((r) => r.pattern === '/v1/*');
  if (!apiRoute || apiRoute.target?.name !== API_FN.name) throw new Error('/v1/* must route to the api function');
  return true;
}

/**
 * Best-effort: strip the run402 "Sent by an AI agent via run402.com" transparency
 * footer from EVERY mailbox in this project (run402 #525). `footer_policy` is a
 * per-mailbox setting (not per-message), so one PATCH per mailbox covers raw +
 * template sends. NEEDS RUN402_SERVICE_KEY — if it is not in the deploy env, this
 * is skipped with a hint. NEVER fails the deploy: on the PROTOTYPE tier the footer
 * is LOCKED, so a mailbox that stays footered just warns.
 */
async function stripMailboxFooters() {
  const serviceKey = process.env.RUN402_SERVICE_KEY;
  if (!serviceKey) {
    console.log('\n(footer) set RUN402_SERVICE_KEY in the deploy env to auto-remove the run402 "Sent by an AI agent" footer from your mailboxes (hobby/team tiers).');
    return;
  }
  const auth = { Authorization: `Bearer ${serviceKey}` };
  try {
    const res = await fetch(`${API_BASE}/mailboxes/v1`, { headers: auth });
    if (!res.ok) {
      console.warn(`(footer) mailbox list failed (${res.status}) — skipping footer cleanup`);
      return;
    }
    const mailboxes = (await res.json()).mailboxes ?? [];
    console.log(`\nStripping the run402 footer from ${mailboxes.length} mailbox(es) (run402 #525)…`);
    for (const m of mailboxes) {
      try {
        const p = await fetch(`${API_BASE}/mailboxes/v1/${m.mailbox_id}`, {
          method: 'PATCH',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ footer_policy: 'none' }),
        });
        if (!p.ok) {
          console.warn(`  (footer) ${m.slug}@ PATCH failed (${p.status}) — left as-is`);
          continue;
        }
        const j = await p.json();
        if (j.effective_footer_policy === 'none') {
          console.log(`  ${m.slug}@ footer_policy → none`);
        } else {
          console.warn(`  (footer) ${m.slug}@ still '${j.effective_footer_policy}' (locked: ${j.footer_policy_locked_reason}) — the prototype tier keeps the run402 footer; upgrade to hobby/team to remove it.`);
        }
      } catch (e) {
        console.warn(`  (footer) ${m.slug}@ — ${e?.message ?? e}`);
      }
    }
  } catch (e) {
    console.warn(`(footer) skipped — ${e?.message ?? e}`);
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const projectId = process.env.RUN402_PROJECT_ID;
  // F-30.2 — optional x402 opt-in: the same env that enables the app's handler
  // + 402 pointer also prices the route (one value drives both). Unset → 0 → inert.
  const x402PriceUsdMicros = Number.parseInt(process.env.KYSIGNED_X402_PRICE_USD_MICROS ?? '', 10) || 0;

  if (dryRun) {
    console.log('DRY RUN — bundling the api function + assembling the release spec (nothing is applied)…');
    const spec = await buildForkerReleaseSpec({
      projectId: projectId ?? 'prj_DRYRUN',
      signingMailboxId: 'mbx_DRYRUN',
      // The SPA file set isn't needed to prove the function/trigger/migration shape.
      loadSite: async () => null,
      x402PriceUsdMicros,
    });
    assertForkerSpecShape(spec);
    const fn = spec.functions.replace[API_FN.name];
    console.log(`  • ${API_FN.name} — ${(fn.source.length / 1024).toFixed(0)} KiB`);
    console.log(`  • triggers: ${fn.triggers.map((t) => `${t.id}(${t.type})`).join(', ')}`);
    console.log(`  • migrations: ${spec.database.migrations.map((m) => m.id).join(', ')}`);
    console.log(`  • routes: ${spec.routes.replace.map((r) => `${r.pattern} → ${r.target.name}`).join(', ')}`);
    console.log('DRY RUN complete — parse + bundle OK, 1 function, 0 cron functions, nothing applied.');
    return;
  }

  if (!projectId) {
    console.error('RUN402_PROJECT_ID is required (the run402 project to deploy to).');
    process.exit(1);
  }

  const signingMailboxId = await resolveSigningMailboxId();
  if (!signingMailboxId) {
    console.error(
      'Cannot resolve the signing mailbox id for the inbound email triggers. Set ' +
        'RUN402_MAILBOX_FORWARD_TO_SIGN_ID (the forward-to-sign mailbox id), or set ' +
        'RUN402_SERVICE_KEY so it can be looked up from /mailboxes/v1.',
    );
    process.exit(1);
  }

  console.log(`Bundling the api function + assembling the release for project ${projectId}…`);
  const spec = await buildForkerReleaseSpec({ projectId, signingMailboxId, x402PriceUsdMicros });
  assertForkerSpecShape(spec);
  const fn = spec.functions.replace[API_FN.name];
  console.log(`  • ${API_FN.name} — ${(fn.source.length / 1024).toFixed(0)} KiB; triggers: ${fn.triggers.map((t) => `${t.id}(${t.type})`).join(', ')}`);
  console.log(`  • migrations: ${spec.database.migrations.map((m) => m.id).join(', ')}`);

  console.log(`Deploying release to project ${projectId} …`);
  const r = run402({ apiBase: API_BASE });
  const project = await r.project(projectId);
  const result = await project.apply(spec, {
    onEvent: (e) => {
      if (e.type === 'commit.phase') console.log(`  [${e.phase}] ${e.status}`);
      else if (e.type === 'ready') console.log(`  ready → ${JSON.stringify(e.urls)}`);
    },
  });
  console.log(`\nRelease activated: ${result.release_id}`);
  console.log(JSON.stringify(result.urls, null, 2));

  // run402 #525 — best-effort, never fails the deploy (see the function doc).
  await stripMailboxFooters();
}

// Only run main() when executed directly (`node scripts/deploy.mjs`), NOT when
// imported by the unit test — importing must have no side effects (no apply, no
// process.exit), so the exported spec builders can be asserted in isolation.
// pathToFileURL is the cross-platform idiom — hand-building the file:/// URL
// breaks on posix (leading / doubles up), silently no-opping the forker deploy
// on Linux/macOS.
const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMainModule) {
  main().catch((err) => {
    console.error('\nDeploy failed:', err?.message ?? err);
    if (err && typeof err.toJSON === 'function') {
      console.error(JSON.stringify(err.toJSON(), null, 2));
    }
    process.exit(1);
  });
}
