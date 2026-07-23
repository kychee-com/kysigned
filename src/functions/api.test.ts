/**
 * api.test — the routed-HTTP entry's AUTH GATE + dispatch (14.5).
 *
 * The auth gate is the security boundary, so it is tested directly against fake
 * deps + fake `Request`s (no run402, no real DB): a session route with no cookie
 * → 401; an unsafe method without the CSRF header → 403; a public route
 * dispatches; a webhook with a bad signature → 401; and the right handler runs
 * for a representative route (the verified inbound webhook records the reply).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { handleRequest, type RequestDeps } from './api.js';
import type { AppDeps } from './config.js';
import type { DbPool } from '../db/pool.js';
import { CSRF_HEADER, SESSION_COOKIE } from '../api/auth/session.js';
import { createAdminAnalyticsMemoryPool } from '../db/adminAnalytics.testpool.js';

// ── a recording fake DbPool ──────────────────────────────────────────────────
interface RecordedQuery {
  text: string;
  values?: unknown[];
}
function makePool(handler?: (text: string, values?: unknown[]) => unknown[]): {
  pool: DbPool;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      const rows = handler ? handler(text, values) : [];
      return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] } as unknown as pg.QueryResult;
    },
    async end() {},
  };
  return { pool, queries };
}

// A well-formed session-cookie UUID (passes SESSION_ID_RE so resolveSession queries).
const VALID_SESSION_ID = '11111111-1111-1111-1111-111111111111';

// A pool that resolves ANY well-formed-UUID session cookie to a valid actor — used
// to reach the POST-authentication CSRF check (F-001 ordering: resolve session
// first → 401, THEN csrfOk → 403). access_token_expires_at is in the future so
// resolveSession never triggers a token refresh.
function validSessionPool(email = 'creator@example.com'): DbPool {
  const future = new Date(Date.now() + 60 * 60 * 1000);
  return {
    async query(text: string) {
      if (text.includes('FROM auth_sessions')) {
        return {
          rows: [
            {
              session_id: VALID_SESSION_ID,
              email,
              run402_access_token: 'a',
              run402_refresh_token: 'r',
              access_token_expires_at: future,
              session_expires_at: future,
              created_at: future,
              last_used_at: future,
            },
          ],
          rowCount: 1,
          command: '',
          oid: 0,
          fields: [],
        } as unknown as pg.QueryResult;
      }
      return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as pg.QueryResult;
    },
    async end() {},
  };
}

// A noisy stub for every factory in AppDeps we don't exercise — throwing makes a
// mis-routed dispatch obvious. The tests below override only what they touch.
function makeDeps(over: Partial<RequestDeps> = {}): RequestDeps {
  const { pool } = makePool();
  const thrower = (label: string) => () => {
    throw new Error(`unexpected ctx build: ${label}`);
  };
  const base: AppDeps = {
    pool,
    emailProvider: { async send() { return { messageId: 'x' }; } },
    sessionConfig: { projectAnonKey: 'anon' },
    signingMailboxId: 'mbx_signing',
    baseUrl: 'https://kysigned.com',
    operatorDomain: 'kysigned.com',
    projectId: 'proj_1',
    getPdf: async () => null,
    storePdf: async () => {},
    deletePdf: async () => {},
    fetchRawMime: async () => null,
    healthChecks: () => ({ checkDb: async () => {}, checkMailbox: async () => {} }),
    apiContext: thrower('apiContext') as never,
    authCtx: thrower('authCtx') as never,
    adminCtx: thrower('adminCtx') as never,
    signerCtx: thrower('signerCtx') as never,
    reconcilerDeps: thrower('reconcilerDeps') as never,
    notifierDeps: thrower('notifierDeps') as never,
    distributeDeps: thrower('distributeDeps') as never,
    reminderSendCtx: thrower('reminderSendCtx') as never,
    expirationStorage: thrower('expirationStorage') as never,
    timestampProvider: thrower('timestampProvider') as never,
  };
  return { ...base, ...over };
}

function req(method: string, path: string, init: RequestInit = {}): Request {
  return new Request(`https://kysigned.com${path}`, { method, ...init });
}

describe('handleRequest — routing + auth gate', () => {
  it('404s an unknown route', async () => {
    const res = await handleRequest(req('GET', '/v1/nope'), makeDeps());
    assert.equal(res.status, 404);
  });

  it('POST /v1/telemetry is public and answers silent success even with the rail disabled (F-38, fork default)', async () => {
    const res = await handleRequest(
      req('POST', '/v1/telemetry', { body: JSON.stringify({ page: '/', records: [{ event: 'page_view', seq: 1 }] }) }),
      makeDeps(), // no deps.telemetry — the fork default
    );
    assert.equal(res.status, 204);
  });

  it('POST /v1/telemetry with the rail enabled records via the collection ctx', async () => {
    const inserts: unknown[][] = [];
    const pool = {
      async query(text: string, values?: unknown[]) {
        if (/INSERT INTO telemetry_events/i.test(text)) inserts.push(values ?? []);
        return { rows: [], rowCount: 1 } as never;
      },
      async end() {},
    };
    const res = await handleRequest(
      req('POST', '/v1/telemetry', { body: JSON.stringify({ page: '/pricing', records: [{ event: 'page_view', seq: 1 }] }) }),
      makeDeps({
        telemetry: { pool, ownHost: 'kysigned.com', limiter: { allow: () => true } },
      }),
    );
    assert.equal(res.status, 204);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0][2], 'pricing');
  });

  it('GET /v1/telemetry is not a route (collection is POST-only)', async () => {
    const res = await handleRequest(req('GET', '/v1/telemetry'), makeDeps());
    assert.equal(res.status, 404);
  });

  it('GET /v1/telemetry/summary refuses an unauthenticated caller (401) and a signed-in NON-operator (403) — AC-219', async () => {
    const anon = await handleRequest(req('GET', '/v1/telemetry/summary'), makeDeps());
    assert.equal(anon.status, 401);
    const nonOp = await handleRequest(
      req('GET', '/v1/telemetry/summary', { headers: { cookie: `${SESSION_COOKIE}=${VALID_SESSION_ID}` } }),
      makeDeps({ pool: validSessionPool('creator@example.com'), operatorEmails: ['op@kychee.com'] }),
    );
    assert.equal(nonOp.status, 403);
    assert.equal(((await nonOp.json()) as { code: string }).code, 'auth_operator_scope');
  });

  it('GET /v1/telemetry/summary serves the operator the full funnel — 11 steps incl. the F-39.5 editor steps (rail enabled)', async () => {
    const sessionPool = validSessionPool('op@kychee.com');
    const telemetryPool = {
      async query(text: string) {
        if (/FROM telemetry_events/i.test(text)) {
          return { rows: [{ event: 'page_view', page: 'home', element: null, country: 'IL', source: 'paid' }], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 0 } as never;
      },
      async end() {},
    };
    const res = await handleRequest(
      req('GET', '/v1/telemetry/summary?days=14', { headers: { cookie: `${SESSION_COOKIE}=${VALID_SESSION_ID}` } }),
      makeDeps({
        pool: sessionPool,
        operatorEmails: ['op@kychee.com'],
        telemetry: { pool: telemetryPool, ownHost: 'kysigned.com', limiter: { allow: () => true } },
      }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { window_days: number; steps: Array<{ step: string; count: number }> };
    assert.equal(body.window_days, 14);
    assert.equal(body.steps.length, 11); // AC-219 0.61.0 — the F-39.5 editor steps joined the funnel
    assert.equal(body.steps[0].step, 'landed');
    assert.equal(body.steps[0].count, 1);
  });

  it('GET /v1/telemetry/summary with the rail DISABLED returns the empty shape — no data, zero telemetry reads (AC-221)', async () => {
    const res = await handleRequest(
      req('GET', '/v1/telemetry/summary', { headers: { cookie: `${SESSION_COOKIE}=${VALID_SESSION_ID}` } }),
      makeDeps({ pool: validSessionPool('op@kychee.com'), operatorEmails: ['op@kychee.com'] }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { enabled: boolean; steps: unknown[] };
    assert.equal(body.enabled, false);
    assert.deepEqual(body.steps, []);
  });

  it('the auth anchors thread the platform-provided country onto server-recorded steps (F-38.4/AC-218)', async () => {
    const steps: Array<[string, { country?: string } | undefined]> = [];
    const okSend = async (url: string) =>
      ({ status: 200, ok: true, json: async () => ({}) }) as never;
    const { pool } = makePool();
    const res = await handleRequest(
      req('POST', '/v1/auth/magic-link', {
        body: JSON.stringify({ email: 'a@x.com' }),
        headers: { 'cf-ipcountry': 'IL' },
      }),
      makeDeps({
        authCtx: () =>
          ({
            pool,
            appBaseUrl: 'https://kysigned.com',
            session: { projectAnonKey: 'anon', fetchImpl: okSend },
            telemetryStep: async (event: string, opts?: { country?: string }) => {
              steps.push([event, opts]);
            },
          }) as never,
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(steps.length, 1);
    assert.equal(steps[0][0], 'send_ok');
    assert.equal(steps[0][1]?.country, 'IL');
  });

  it('dispatches a public route (health) with no auth', async () => {
    const res = await handleRequest(req('GET', '/v1/health'), makeDeps());
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; service: string; checks?: unknown };
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'kysigned');
    assert.equal(body.checks, undefined, '#146: the BARE liveness body is untouched (forker verify.http)');
  });

  it('#146 — /v1/health?deep=1 runs the readiness probes and reports named checks', async () => {
    const res = await handleRequest(req('GET', '/v1/health?deep=1'), makeDeps());
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; checks: { db: string; mailbox: string } };
    assert.equal(body.status, 'ok');
    assert.deepEqual(body.checks, { db: 'ok', mailbox: 'ok' });
  });

  it('#146 — a dead DB turns ?deep=1 into a 503 naming the db check (mailbox still reported)', async () => {
    const res = await handleRequest(
      req('GET', '/v1/health?deep=1'),
      makeDeps({
        healthChecks: () => ({
          checkDb: async () => {
            throw new Error('connection refused');
          },
          checkMailbox: async () => {},
        }),
      }),
    );
    assert.equal(res.status, 503);
    const body = (await res.json()) as { status: string; checks: { db: string; mailbox: string } };
    assert.equal(body.status, 'degraded');
    assert.equal(body.checks.db, 'fail');
    assert.equal(body.checks.mailbox, 'ok');
  });

  it('#146 — a suspended signing mailbox turns ?deep=1 into a 503 naming the mailbox check', async () => {
    const res = await handleRequest(
      req('GET', '/v1/health?deep=1'),
      makeDeps({
        healthChecks: () => ({
          checkDb: async () => {},
          checkMailbox: async () => {
            throw new Error('signing mailbox status suspended');
          },
        }),
      }),
    );
    assert.equal(res.status, 503);
    const body = (await res.json()) as { checks: { db: string; mailbox: string } };
    assert.equal(body.checks.db, 'ok');
    assert.equal(body.checks.mailbox, 'fail');
  });

  it('a session route with NO cookie → 401', async () => {
    // resolveSession returns null with no session cookie (never touches the DB).
    const res = await handleRequest(req('GET', '/v1/auth/user'), makeDeps());
    assert.equal(res.status, 401);
  });

  it('a session route with an unknown cookie → 401 (no session row)', async () => {
    // The pool returns no rows for getAuthSession → resolveSession → null → 401.
    const { pool } = makePool(() => []);
    const res = await handleRequest(
      req('GET', '/v1/auth/user', { headers: { cookie: `${SESSION_COOKIE}=deadbeef` } }),
      makeDeps({ pool }),
    );
    assert.equal(res.status, 401);
  });

  it('an unsafe (POST) session route with a VALID session but no CSRF header → 403 (CSRF checked AFTER auth) (F-001)', async () => {
    // F-001 ordering: the session resolves first; the authenticated caller is THEN
    // held to CSRF on the unsafe method — a missing custom header 403s. (Only a
    // caller who has already proven authentication can reach this 403.)
    const res = await handleRequest(
      req('POST', '/v1/envelope', {
        headers: { cookie: `${SESSION_COOKIE}=${VALID_SESSION_ID}`, 'content-type': 'application/json' },
        body: '{}',
      }),
      makeDeps({ pool: validSessionPool() }),
    );
    assert.equal(res.status, 403);
  });

  it('an unsafe session route WITH the CSRF header but no session → 401 (not 403)', async () => {
    const res = await handleRequest(
      req('POST', '/v1/envelope', {
        headers: { [CSRF_HEADER]: '1', 'content-type': 'application/json' },
        body: '{}',
      }),
      makeDeps(),
    );
    assert.equal(res.status, 401);
  });

  it('an unsafe (POST) session route with NO cookie and no CSRF header → 401 (auth runs BEFORE CSRF) (F-001)', async () => {
    // FC1 regression (system-test F-001): the gate must resolve the session FIRST.
    // A caller with neither a session cookie nor the CSRF header gets 401
    // (authentication required), NOT 403 — a 403 here would leak that the route
    // exists and needs CSRF before the caller has proven they are authenticated.
    const res = await handleRequest(
      req('POST', '/v1/envelope', { headers: { 'content-type': 'application/json' }, body: '{}' }),
      makeDeps(),
    );
    assert.equal(res.status, 401);
  });

  // ── FC1.1 regression (system-test F-001) ──────────────────────────────────
  // A malformed/expired session cookie must yield 401 on EVERY authed route, not
  // a 500. In prod the auth_sessions.session_id uuid-cast THROWS on a non-uuid
  // cookie; the integration harness above used a non-throwing mock, which hid it.
  // This drives a pool that throws on the session lookup (like real Postgres) and
  // asserts the auth gate still answers a clean 401 — across a GET, a CSRF-gated
  // POST, and signout (a representative slice of the six endpoints the Red Team hit).
  it('a malformed session cookie → 401 (not 500) even when the DB throws on the lookup (F-001)', async () => {
    const throwingPool: DbPool = {
      async query(text: string) {
        if (text.includes('FROM auth_sessions')) {
          throw new Error('invalid input syntax for type uuid: "fake_session_token"');
        }
        return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as pg.QueryResult;
      },
      async end() {},
    };
    const cookie = `${SESSION_COOKIE}=fake_session_token`;
    const cases: Array<[string, string, RequestInit]> = [
      ['GET', '/v1/envelopes', { headers: { cookie } }],
      ['POST', '/v1/envelope', { headers: { cookie, [CSRF_HEADER]: '1', 'content-type': 'application/json' }, body: '{}' }],
      ['POST', '/v1/auth/signout', { headers: { cookie, [CSRF_HEADER]: '1' } }],
    ];
    for (const [method, path, init] of cases) {
      const res = await handleRequest(req(method, path, init), makeDeps({ pool: throwingPool }));
      assert.equal(res.status, 401, `${method} ${path} should 401 on a malformed session, got ${res.status}`);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, 'Authentication required', `${method} ${path} body`);
    }
  });

  it('the recipient-editing + seal routes (F-23/F-24) are registered + session-gated', async () => {
    // With F-001 auth-before-CSRF, a VALID session on an unsafe method with no CSRF
    // header → 403 proves the route matched a SESSION route (a missing route would
    // 404) AND is CSRF-gated. Covers add/edit/delete + seal.
    for (const [method, path] of [
      ['POST', '/v1/envelope/e1/signers'],
      ['PATCH', '/v1/envelope/e1/signers'],
      ['DELETE', '/v1/envelope/e1/signers'],
      ['POST', '/v1/envelope/e1/seal'],
    ] as const) {
      const res = await handleRequest(
        req(method, path, {
          headers: { cookie: `${SESSION_COOKIE}=${VALID_SESSION_ID}`, 'content-type': 'application/json' },
          body: '{}',
        }),
        makeDeps({ pool: validSessionPool() }),
      );
      assert.equal(res.status, 403, `${method} ${path} should 403 without CSRF`);
    }
  });

  // F-29.6 — inbound MAILBOX email is no longer a webhook ROUTE: run402 delivers it
  // as a `reply_received` / `bounced` EMAIL-TRIGGER durable run (handleRequest never
  // sees it). The handlers are covered by inboundEmail.test.ts.

  it('signer-token routes need NO session and call the signer handler (token validated in-handler)', async () => {
    // getSignerByToken returns no row for an unknown token → 404 from the handler
    // (NOT a 401 — there is no session gate on this route).
    const { pool } = makePool(() => []); // no signer row for the token
    const res = await handleRequest(
      req('GET', '/v1/sign/env1/badtoken/info'),
      makeDeps({ pool, signerCtx: () => ({ pool, getPdf: async () => null }) }),
    );
    assert.equal(res.status, 404);
  });

  it('HEAD is allowed on a GET route (matched as GET)', async () => {
    const res = await handleRequest(req('HEAD', '/v1/health'), makeDeps());
    assert.equal(res.status, 200);
  });

  // ── F-28 / AC-116 — secret-gated, identity-scoped test-account reset ─────────
  it('POST /v1/test/reset-user with the secret + a matched identity → 200 (seven DELETEs)', async () => {
    const { pool, queries } = makePool(() => []);
    const res = await handleRequest(
      req('POST', '/v1/test/reset-user', {
        headers: { 'content-type': 'application/json', 'x-test-reset-secret': 'S3CRET' },
        body: JSON.stringify({ email: 'redteam@kysigned.com' }),
      }),
      makeDeps({ pool, testResetSecret: 'S3CRET', testResetPattern: /^redteam.*@kysigned\.com$/ }),
    );
    assert.equal(res.status, 200);
    // signature_artifacts (FK-uncascaded) + envelopes + auth_sessions + user_credits +
    // credit_ledger + the two F-37 attribution tables (captures + establishment stamp)
    assert.equal(queries.filter((q) => /^DELETE FROM/.test(q.text.trim())).length, 7);
  });

  it('POST /v1/test/reset-user is DISABLED (handler 404) when no reset secret is configured', async () => {
    const { pool, queries } = makePool(() => []);
    const res = await handleRequest(
      req('POST', '/v1/test/reset-user', {
        headers: { 'content-type': 'application/json', 'x-test-reset-secret': 'anything' },
        body: JSON.stringify({ email: 'redteam@kysigned.com' }),
      }),
      makeDeps({ pool }), // no testResetSecret → fail-closed
    );
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'not_found'); // the HANDLER's 404, not the router's 'Not found'
    assert.equal(queries.length, 0);
  });

  it('POST /v1/test/reset-user with a WRONG secret → 401, zero mutation', async () => {
    const { pool, queries } = makePool(() => []);
    const res = await handleRequest(
      req('POST', '/v1/test/reset-user', {
        headers: { 'content-type': 'application/json', 'x-test-reset-secret': 'WRONG' },
        body: JSON.stringify({ email: 'redteam@kysigned.com' }),
      }),
      makeDeps({ pool, testResetSecret: 'S3CRET', testResetPattern: /^redteam.*@kysigned\.com$/ }),
    );
    assert.equal(res.status, 401);
    assert.equal(queries.length, 0);
  });

  it('POST /v1/test/reset-user refuses an identity OUTSIDE the pattern → 403, zero mutation', async () => {
    const { pool, queries } = makePool(() => []);
    const res = await handleRequest(
      req('POST', '/v1/test/reset-user', {
        headers: { 'content-type': 'application/json', 'x-test-reset-secret': 'S3CRET' },
        body: JSON.stringify({ email: 'realuser@example.com' }),
      }),
      makeDeps({ pool, testResetSecret: 'S3CRET', testResetPattern: /^redteam.*@kysigned\.com$/ }),
    );
    assert.equal(res.status, 403);
    assert.equal(queries.length, 0);
  });

  it('passkey login/options is PUBLIC — dispatches with no session (proxies to run402)', async () => {
    // The WebAuthn login ceremony IS the auth, so the route needs no cookie/CSRF.
    const fakeFetch = async () => ({
      status: 200,
      ok: true,
      json: async () => ({ challenge_id: 'c1', options: { challenge: 'x' } }),
    });
    const res = await handleRequest(
      req('POST', '/v1/auth/passkeys/login/options', {
        body: JSON.stringify({ email: 'a@b.com', app_origin: 'https://kysigned.com' }),
      }),
      makeDeps({ sessionConfig: { projectAnonKey: 'anon', fetchImpl: fakeFetch } }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { challenge_id: string };
    assert.equal(body.challenge_id, 'c1');
  });

  it('passkey management (GET list) is SESSION — 401 without a cookie (gate, no run402 call)', async () => {
    const res = await handleRequest(req('GET', '/v1/auth/passkeys'), makeDeps());
    assert.equal(res.status, 401);
  });

  it('passkey register/options (session POST) with a valid session but no CSRF header → 403', async () => {
    // F-001 auth-before-CSRF: a valid session reaches the post-auth CSRF check, so
    // an unsafe passkey POST with no custom header 403s (proves it is session+CSRF gated).
    const res = await handleRequest(
      req('POST', '/v1/auth/passkeys/register/options', {
        headers: { cookie: `${SESSION_COOKIE}=${VALID_SESSION_ID}` },
        body: '{}',
      }),
      makeDeps({ pool: validSessionPool() }),
    );
    assert.equal(res.status, 403);
  });
});

// ── F-002 regression (system-test Fix Cycle 1) ──────────────────────────────
// The void ROUTE must pass a ctx that carries senderGate so the (already-correct)
// refund block runs. The handler-level test injects senderGate directly, so it
// never caught that the route hand-built a ctx WITHOUT it — every void returned
// refunded:false. This drives a POST through the ROUTED-HTTP ENTRY
// (handleRequest → deps.apiContext → handleVoidEnvelope) and asserts a fully-unsigned
// void refunds (refunded:true) via the route-built ctx.
describe('handleRequest — void route wires senderGate (F-002)', () => {
  function voidPool(email = 'creator@example.com'): DbPool {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const envelope = {
      id: 'env1',
      sender_email: email,
      status: 'active',
      auto_close: false, // skip the F-24.1 all-signed guard
      document_name: 'NDA',
      pdf_deleted_at: future, // already stamped → skip the delete branch
      pdf_storage_key: null,
    };
    return {
      async query(text: string) {
        if (text.includes('FROM auth_sessions')) {
          return {
            rows: [
              {
                session_id: VALID_SESSION_ID,
                email,
                run402_access_token: 'a',
                run402_refresh_token: 'r',
                access_token_expires_at: future,
                session_expires_at: future,
                created_at: future,
                last_used_at: future,
              },
            ],
            rowCount: 1,
          } as unknown as pg.QueryResult;
        }
        if (text.includes("UPDATE envelopes SET status = 'voided'")) {
          return { rows: [{ ...envelope, status: 'voided' }], rowCount: 1 } as unknown as pg.QueryResult;
        }
        if (text.includes('FROM envelopes WHERE id')) {
          return { rows: [envelope], rowCount: 1 } as unknown as pg.QueryResult;
        }
        // getEnvelopeSigners (none signed → refund) + getOutstandingSigners (none → no notify).
        if (text.includes('FROM envelope_signers')) {
          return { rows: [], rowCount: 0 } as unknown as pg.QueryResult;
        }
        return { rows: [], rowCount: 0 } as unknown as pg.QueryResult;
      },
      async end() {},
    } as DbPool;
  }

  it('a fully-unsigned void through the ROUTE refunds the credit (refunded:true)', async () => {
    const pool = voidPool();
    let refundedAmount = 0;
    const deps = makeDeps({
      pool,
      // The production apiContext carries senderGate; the route must pass THIS ctx
      // (not a hand-built one) so refundCredit runs.
      apiContext: ((email: string) => ({
        pool,
        emailProvider: { async send() { return { messageId: 'x' }; } },
        senderIdentity: email,
        operatorDomain: 'kysigned.com',
        deletePdf: async () => {},
        senderGate: {
          costUsdMicros: 250_000,
          refundCredit: async (_id: string, amt: number) => {
            refundedAmount = amt;
            return { ok: true };
          },
        },
      })) as never,
    });
    const res = await handleRequest(
      req('POST', '/v1/envelope/env1/void', {
        headers: { cookie: `${SESSION_COOKIE}=${VALID_SESSION_ID}`, [CSRF_HEADER]: '1' },
      }),
      deps,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { refunded: boolean };
    assert.equal(body.refunded, true, 'the void route must pass senderGate so the credit refunds');
    assert.equal(refundedAmount, 250_000, 'flat $0.25 refunded');
  });
});

// ── F-005 regression (system-test cycle 4) ──────────────────────────────────
// An authenticated internal_test:true create (the ONLY path a $0 @kychee.com
// account reaches past the credit gate) must return 201 — not 500 — end-to-end
// through the ROUTED-HTTP ENTRY (handleRequest → apiContext → handleCreateEnvelope).
// The F-004 upload-guard restructuring shipped without an entry-level test on this
// success path, so a regression here would not have been caught. This drives the
// real dispatch with a session-seeded + create-handling pool and a real apiContext.
describe('handleRequest — internal_test:true create dispatches to 201 (F-005)', () => {
  // A tiny REAL PDF (pdf-lib parses the source during assembly), base64.
  const TINY_PDF_B64 =
    'JVBERi0xLjcKJYGBgYEKCjEgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgNCAwIFIgXQovQ291bnQgMQo+PgplbmRvYmoKCjIgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCj4+CmVuZG9iagoKMyAwIG9iago8PAovUHJvZHVjZXIgPEZFRkYwMDc0MDA2NTAwNzMwMDc0MDAyRDAwNjYwMDY5MDA3ODAwNzQwMDc1MDA3MjAwNjU+Ci9Nb2REYXRlIChEOjIwMjAwMTAxMDAwMDAwWikKL0NyZWF0b3IgPEZFRkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyMDAwMjgwMDY4MDA3NDAwNzQwMDcwMDA3MzAwM0EwMDJGMDAyRjAwNjcwMDY5MDA3NDAwNjgwMDc1MDA2MjAwMkUwMDYzMDA2RjAwNkQwMDJGMDA0ODAwNkYwMDcwMDA2NDAwNjkwMDZFMDA2NzAwMkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyOT4KL0NyZWF0aW9uRGF0ZSAoRDoyMDIwMDEwMTAwMDAwMFopCi9UaXRsZSA8RkVGRjAwNzQwMDY1MDA3MzAwNzQ+Cj4+CmVuZG9iagoKNCAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDEgMCBSCi9SZXNvdXJjZXMgPDwKL0ZvbnQgPDwKL0hlbHZldGljYS03MDk4NDgwNzg5IDUgMCBSCj4+Ci9YT2JqZWN0IDw8Cj4+Ci9FeHRHU3RhdGUgPDwKPj4KPj4KL01lZGlhQm94IFsgMCAwIDYxMiA3OTIgXQovQW5ub3RzIFsgXQovQ29udGVudHMgWyA2IDAgUiBdCj4+CmVuZG9iagoKNSAwIG9iago8PAovVHlwZSAvRm9udAovU3VidHlwZSAvVHlwZTEKL0Jhc2VGb250IC9IZWx2ZXRpY2EKL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcKPj4KZW5kb2JqCgo2IDAgb2JqCjw8Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGggOTYKPj4Kc3RyZWFtCnicK+RyCuEyUADBonQufY/UnLLUkszkRF1zA0sLEwsDcwtLBSMThZA0LhDpw2UIVgohQ3K5bMxNzEzNjc1NjAzMzMwszS3MTcxNzY3MTO0UQrK4QrS4XEO4ArkAobMWLQplbmRzdHJlYW0KZW5kb2JqCgp4cmVmCjAgNwowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTYgMDAwMDAgbiAKMDAwMDAwMDA3NiAwMDAwMCBuIAowMDAwMDAwMTI2IDAwMDAwIG4gCjAwMDAwMDA0OTggMDAwMDAgbiAKMDAwMDAwMDY5MyAwMDAwMCBuIAowMDAwMDAwNzkxIDAwMDAwIG4gCgp0cmFpbGVyCjw8Ci9TaXplIDcKL1Jvb3QgMiAwIFIKL0luZm8gMyAwIFIKPj4KCnN0YXJ0eHJlZgo5NTkKJSVFT0Y=';

  /** A pool that resolves the seeded session AND handles the create-envelope CTE +
   *  the internal-test UPDATE — enough for the full create dispatch to run. */
  function createPool(): DbPool {
    const envelopes: Array<Record<string, unknown>> = [];
    return {
      async query(text: string, values?: unknown[]) {
        const v = (values ?? []) as unknown[];
        if (text.includes('FROM auth_sessions')) {
          // resolveSession: a live row for the red-team creator, far-future expiry.
          return {
            rows: [{
              session_id: v[0], email: 'redteam@kychee.com',
              run402_access_token: 'x', run402_refresh_token: 'y',
              access_token_expires_at: new Date('2027-12-31'),
              session_expires_at: new Date('2027-12-31'),
              created_at: new Date(), last_used_at: new Date(),
            }],
            rowCount: 1,
          } as unknown as import('pg').QueryResult;
        }
        if (text.includes('WITH env_ins AS')) {
          const env = { id: v[0], sender_email: v[1], document_name: v[2], status: 'active', internal_test: false };
          envelopes.push(env);
          // Mirror the real CTE: return the inserted signer rows WITH their tokens
          // (createEnvelope matches returned signers to client tokens, else it throws).
          // Signer params: 6 envelope params, then batches of 6 starting at index 6
          // (email, name, verification_level, signing_token, on_behalf_of, sent_pdf_hash).
          const signers: Array<Record<string, unknown>> = [];
          for (let i = 6; i + 3 < v.length; i += 6) {
            signers.push({
              id: `sg-${signers.length + 1}`, envelope_id: v[0], email: v[i], name: v[i + 1],
              verification_level: v[i + 2], signing_token: v[i + 3], on_behalf_of: v[i + 4] ?? null,
              sent_pdf_hash: v[i + 5] ?? null, status: 'pending', signed_at: null, reminder_count: 0,
            });
          }
          return { rows: [{ envelope: env, signers }], rowCount: 1 } as unknown as import('pg').QueryResult;
        }
        if (text.includes('SET internal_test = true')) {
          const e = envelopes.find((x) => x.id === v[0]);
          if (e) e.internal_test = true;
          return { rows: [], rowCount: e ? 1 : 0 } as unknown as import('pg').QueryResult;
        }
        // creator_profiles upsert (display name) + anything else → no-op.
        return { rows: [], rowCount: 0 } as unknown as import('pg').QueryResult;
      },
      async end() {},
    };
  }

  it('POST /v1/envelope { internal_test:true } with a valid session + @kychee.com creator → 201', async () => {
    const pool = createPool();
    const SESSION = '11111111-1111-4111-8111-111111111111'; // a well-formed UUID
    const deps = makeDeps({
      pool,
      // A real apiContext for the create dispatch: @kychee.com creator (internal-test
      // eligible), zero-credit gate (so non-internal would 402 — internal must skip it).
      apiContext: () => ({
        pool,
        emailProvider: { async send() { return { messageId: 'm' }; } },
        baseUrl: 'https://kysigned.com',
        senderIdentity: 'redteam@kychee.com',
        internalTestDomains: ['kychee.com'],
        storePdf: async () => {},
        deletePdf: async () => {},
        senderGate: { getCreditBalance: async () => 0 },
      }) as never,
    });

    const res = await handleRequest(
      req('POST', '/v1/envelope', {
        headers: { cookie: `${SESSION_COOKIE}=${SESSION}`, [CSRF_HEADER]: '1', 'content-type': 'application/json' },
        body: JSON.stringify({
          document_name: 'Internal test', pdf_base64: TINY_PDF_B64, internal_test: true,
          signers: [{ email: 's@redteam.kysigned.test', name: 'S' }],
        }),
      }),
      deps,
    );
    assert.equal(res.status, 201, `internal_test create must dispatch to 201, got ${res.status}`);
    const body = (await res.json()) as { envelope_id?: string };
    assert.ok(body.envelope_id, 'response carries an envelope_id');
  });
});

// ── F-30.1 / AC-131 — bearer creator API keys: the auth gate's second mode ──
//
// An `Authorization` header on a session route is a BEARER ATTEMPT: it must win
// (resolve to the key's creator, CSRF-exempt) or fail with a machine-readable
// 401 — it must NEVER fall back to the cookie path or a CSRF-flavored 403.
describe('handleRequest — bearer API keys (F-30.1 / AC-131)', () => {
  const RAW_KEY = 'ksk_' + 'a'.repeat(64);
  const KEY_EMAIL = 'agent-owner@example.com';

  /** Pool that resolves the api_keys hash lookup to KEY_EMAIL and answers the
   *  envelopes list with zero rows; records every query for scoping assertions. */
  function keyPool(): { pool: DbPool; queries: Array<{ text: string; values?: unknown[] }> } {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const pool: DbPool = {
      async query(text: string, values?: unknown[]) {
        queries.push({ text, values });
        if (text.includes('FROM api_keys')) {
          return {
            rows: [{
              id: 'key-1', creator_email: KEY_EMAIL, key_hash: 'irrelevant-here',
              label: 'mcp', created_at: new Date(), last_used_at: null, revoked_at: null,
            }],
            rowCount: 1,
          } as unknown as pg.QueryResult;
        }
        return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as pg.QueryResult;
      },
      async end() {},
    };
    return { pool, queries };
  }

  it('a valid bearer key with NO cookie and NO CSRF header dispatches as the key creator', async () => {
    const { pool, queries } = keyPool();
    const res = await handleRequest(
      req('GET', '/v1/envelopes', { headers: { authorization: `Bearer ${RAW_KEY}` } }),
      makeDeps({ pool }),
    );
    assert.equal(res.status, 200, `bearer-authed list must dispatch, got ${res.status}`);
    // The key was actually resolved (hash lookup ran)…
    assert.ok(queries.some((q) => q.text.includes('FROM api_keys')), 'api_keys hash lookup ran');
    // …and the envelope query is scoped to the KEY's creator, not any request input.
    assert.ok(
      queries.some((q) => (q.values ?? []).includes(KEY_EMAIL)),
      'downstream query is scoped to the key creator email',
    );
  });

  it('an unsafe (POST) route with a valid bearer key and NO CSRF header is CSRF-EXEMPT, and an unexpected dispatch throw becomes a coded 500 (TR-018 / AC-137)', async () => {
    const { pool } = keyPool();
    // remindEnvelope hits reminderSendCtx (a thrower in makeDeps) AFTER the gate —
    // reaching the thrower proves the gate passed (a 401/403 would mean it did not).
    // The top-level error boundary then turns that unexpected throw into a clean,
    // taxonomy-coded 500 (`internal_error`) — never an uncoded platform error (TR-018).
    const res = await handleRequest(
      req('POST', '/v1/envelope/env-1/remind', { headers: { authorization: `Bearer ${RAW_KEY}` } }),
      makeDeps({ pool }),
    );
    assert.equal(res.status, 500, 'gate passed the bearer POST through to dispatch (CSRF-exempt)');
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, 'internal_error', 'unexpected throw → coded 500, never an uncoded platform error');
  });

  it('an unknown key → 401 with the machine-readable code auth_invalid_key (never a CSRF 403)', async () => {
    const { pool } = makePool(() => []); // api_keys lookup finds nothing
    const res = await handleRequest(
      req('POST', '/v1/envelope', {
        headers: { authorization: `Bearer ${'ksk_' + 'b'.repeat(64)}`, 'content-type': 'application/json' },
        body: '{}',
      }),
      makeDeps({ pool }),
    );
    assert.equal(res.status, 401, `unknown key must 401, got ${res.status}`);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, 'auth_invalid_key');
  });

  it('a malformed Authorization value → 401 auth_invalid_key (bearer attempt never falls back to cookies)', async () => {
    // Even WITH a valid session cookie present, an explicit-but-garbage
    // Authorization header must fail closed, not silently use the cookie.
    const res = await handleRequest(
      req('GET', '/v1/envelopes', {
        headers: {
          authorization: 'Bearer not-a-key',
          cookie: `${SESSION_COOKIE}=${VALID_SESSION_ID}`,
        },
      }),
      makeDeps({ pool: validSessionPool() }),
    );
    assert.equal(res.status, 401, `malformed bearer must 401, got ${res.status}`);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, 'auth_invalid_key');
  });

  it('a key on an out-of-scope session route → 403 auth_key_scope (a key cannot mint keys)', async () => {
    const { pool } = keyPool();
    const res = await handleRequest(
      req('POST', '/v1/api-keys', {
        headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
        body: '{}',
      }),
      makeDeps({ pool }),
    );
    assert.equal(res.status, 403, `key on key-management must 403, got ${res.status}`);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, 'auth_key_scope');
  });

  it('cookie-path regression: a session route with no Authorization header behaves exactly as before', async () => {
    // No cookie → 401 (and no code field required on the legacy path).
    const res = await handleRequest(req('GET', '/v1/envelopes'), makeDeps());
    assert.equal(res.status, 401);
  });
});

// ── F-30.3 / AC-136 — Idempotency-Key on create, wired at the dispatch ──────
describe('handleRequest — Idempotency-Key on createEnvelope (F-30.3 / AC-136)', () => {
  const RAW_KEY = 'ksk_' + 'e'.repeat(64);

  /** Pool = bearer key resolution + the create CTE + an in-memory
   *  idempotency_keys table; counts how many times the create CTE ran. */
  function idemPool() {
    const idem = new Map<string, { request_hash: string; response_status: number | null; response_body: string | null }>();
    let createRuns = 0;
    const pool: DbPool = {
      async query(text: string, values?: unknown[]) {
        const v = (values ?? []) as unknown[];
        if (text.includes('FROM api_keys')) {
          return {
            rows: [{ id: 'key-1', creator_email: 'agent@example.com', key_hash: 'h', label: null, created_at: new Date(), last_used_at: null, revoked_at: null }],
            rowCount: 1,
          } as unknown as pg.QueryResult;
        }
        if (/INSERT INTO idempotency_keys/i.test(text)) {
          const k = `${v[0]} ${v[1]}`;
          if (idem.has(k)) return { rows: [], rowCount: 0 } as unknown as pg.QueryResult;
          idem.set(k, { request_hash: v[2] as string, response_status: null, response_body: null });
          return { rows: [{ ok: 1 }], rowCount: 1 } as unknown as pg.QueryResult;
        }
        if (/^\s*SELECT/i.test(text) && /FROM idempotency_keys/i.test(text)) {
          const r = idem.get(`${v[0]} ${v[1]}`);
          return { rows: r ? [r] : [], rowCount: r ? 1 : 0 } as unknown as pg.QueryResult;
        }
        if (/UPDATE idempotency_keys/i.test(text)) {
          const r = idem.get(`${v[2]} ${v[3]}`);
          if (r) { r.response_status = v[0] as number; r.response_body = v[1] as string; }
          return { rows: [], rowCount: 1 } as unknown as pg.QueryResult;
        }
        if (/DELETE FROM idempotency_keys/i.test(text)) {
          idem.delete(`${v[0]} ${v[1]}`);
          return { rows: [], rowCount: 1 } as unknown as pg.QueryResult;
        }
        if (text.includes('WITH env_ins AS')) {
          createRuns += 1;
          const env = { id: `env-${createRuns}`, sender_email: v[1], document_name: v[2], status: 'active', internal_test: false };
          const signers: Array<Record<string, unknown>> = [];
          for (let i = 6; i + 3 < v.length; i += 6) {
            signers.push({
              id: `sg-${signers.length + 1}`, envelope_id: env.id, email: v[i], name: v[i + 1],
              verification_level: v[i + 2], signing_token: v[i + 3], on_behalf_of: v[i + 4] ?? null,
              sent_pdf_hash: v[i + 5] ?? null, status: 'pending', signed_at: null, reminder_count: 0,
            });
          }
          return { rows: [{ envelope: env, signers }], rowCount: 1 } as unknown as pg.QueryResult;
        }
        return { rows: [], rowCount: 0 } as unknown as pg.QueryResult;
      },
      async end() {},
    };
    return { pool, createCount: () => createRuns };
  }

  it('two creates with the same Idempotency-Key yield ONE envelope; the retry replays the same response', async () => {
    const { pool, createCount } = idemPool();
    const deps = makeDeps({
      pool,
      apiContext: () => ({
        pool,
        emailProvider: { async send() { return { messageId: 'm' }; } },
        baseUrl: 'https://kysigned.com',
        senderIdentity: 'agent@example.com',
        internalTestDomains: ['kychee.com'],
        storePdf: async () => {},
        deletePdf: async () => {},
        senderGate: { getCreditBalance: async () => 10_000_000 },
      }) as never,
    });
    const TINY = 'JVBERi0xLjcKJYGBgYEKCjEgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgNCAwIFIgXQovQ291bnQgMQo+PgplbmRvYmoKCjIgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCj4+CmVuZG9iagoKMyAwIG9iago8PAovUHJvZHVjZXIgPEZFRkYwMDc0MDA2NTAwNzMwMDc0MDAyRDAwNjYwMDY5MDA3ODAwNzQwMDc1MDA3MjAwNjU+Ci9Nb2REYXRlIChEOjIwMjAwMTAxMDAwMDAwWikKL0NyZWF0b3IgPEZFRkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyMDAwMjgwMDY4MDA3NDAwNzQwMDcwMDA3MzAwM0EwMDJGMDAyRjAwNjcwMDY5MDA3NDAwNjgwMDc1MDA2MjAwMkUwMDYzMDA2RjAwNkQwMDJGMDA0ODAwNkYwMDcwMDA2NDAwNjkwMDZFMDA2NzAwMkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyOT4KL0NyZWF0aW9uRGF0ZSAoRDoyMDIwMDEwMTAwMDAwMFopCi9UaXRsZSA8RkVGRjAwNzQwMDY1MDA3MzAwNzQ+Cj4+CmVuZG9iagoKNCAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDEgMCBSCi9SZXNvdXJjZXMgPDwKL0ZvbnQgPDwKL0hlbHZldGljYS03MDk4NDgwNzg5IDUgMCBSCj4+Ci9YT2JqZWN0IDw8Cj4+Ci9FeHRHU3RhdGUgPDwKPj4KPj4KL01lZGlhQm94IFsgMCAwIDYxMiA3OTIgXQovQW5ub3RzIFsgXQovQ29udGVudHMgWyA2IDAgUiBdCj4+CmVuZG9iagoKNSAwIG9iago8PAovVHlwZSAvRm9udAovU3VidHlwZSAvVHlwZTEKL0Jhc2VGb250IC9IZWx2ZXRpY2EKL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcKPj4KZW5kb2JqCgo2IDAgb2JqCjw8Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGggOTYKPj4Kc3RyZWFtCnicK+RyCuEyUADBonQufY/UnLLUkszkRF1zA0sLEwsDcwtLBSMThZA0LhDpw2UIVgohQ3K5bMxNzEzNjc1NjAzMzMwszS3MTcxNzY3MTO0UQrK4QrS4XEO4ArkAobMWLQplbmRzdHJlYW0KZW5kb2JqCgp4cmVmCjAgNwowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTYgMDAwMDAgbiAKMDAwMDAwMDA3NiAwMDAwMCBuIAowMDAwMDAwMTI2IDAwMDAwIG4gCjAwMDAwMDA0OTggMDAwMDAgbiAKMDAwMDAwMDY5MyAwMDAwMCBuIAowMDAwMDAwNzkxIDAwMDAwIG4gCgp0cmFpbGVyCjw8Ci9TaXplIDcKL1Jvb3QgMiAwIFIKL0luZm8gMyAwIFIKPj4KCnN0YXJ0eHJlZgo5NTkKJSVFT0Y=';
    const payload = JSON.stringify({
      document_name: 'Idem test',
      pdf_base64: TINY,
      signers: [{ email: 's@example.com', name: 'S' }],
    });
    const mk = () =>
      req('POST', '/v1/envelope', {
        headers: {
          authorization: `Bearer ${RAW_KEY}`,
          'content-type': 'application/json',
          'idempotency-key': 'agent-retry-1',
        },
        body: payload,
      });

    const first = await handleRequest(mk(), deps);
    assert.equal(first.status, 201, `first create must 201, got ${first.status}`);
    const firstBody = (await first.json()) as { envelope_id: string };

    const second = await handleRequest(mk(), deps);
    assert.equal(second.status, 201);
    const secondBody = (await second.json()) as { envelope_id: string };

    assert.equal(createCount(), 1, 'the create CTE ran exactly once — one envelope, one debit');
    assert.equal(secondBody.envelope_id, firstBody.envelope_id, 'the retry returns the SAME envelope');

    // F-30.7 / AC-173+AC-175 — every create 201 carries the observer handle,
    // and the stored replay body carries the SAME token (the recovery path).
    const t1 = (firstBody as unknown as { tracking?: { token?: string; poll?: string } }).tracking;
    const t2 = (secondBody as unknown as { tracking?: { token?: string; poll?: string } }).tracking;
    assert.match(String(t1?.token), /^ktt_[A-Za-z0-9_-]{43}$/, 'create 201 returns the ktt_ observer token');
    assert.match(String(t1?.poll), /\/v1\/envelope\//, 'a runnable poll instruction accompanies the token');
    assert.equal(t2?.token, t1?.token, 'the idempotent replay returns the SAME token — restart recovery');
  });

  it('F-30.7 — a tracking-token store failure degrades gracefully: 201 WITHOUT tracking, never a dead token', async () => {
    const { pool } = idemPool();
    const wrapped: DbPool = {
      async query(text: string, values?: unknown[]) {
        if (/INSERT INTO envelope_tracking_tokens/i.test(text)) throw new Error('tokens table down');
        return pool.query(text, values);
      },
      async end() {},
    };
    const deps = makeDeps({
      pool: wrapped,
      apiContext: () => ({
        pool: wrapped,
        emailProvider: { async send() { return { messageId: 'm' }; } },
        baseUrl: 'https://kysigned.com',
        senderIdentity: 'agent@example.com',
        internalTestDomains: ['kychee.com'],
        storePdf: async () => {},
        deletePdf: async () => {},
        senderGate: { getCreditBalance: async () => 10_000_000 },
      }) as never,
    });
    const TINY2 = 'JVBERi0xLjcKJYGBgYEKCjEgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgNCAwIFIgXQovQ291bnQgMQo+PgplbmRvYmoKCjIgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCj4+CmVuZG9iagoKMyAwIG9iago8PAovUHJvZHVjZXIgPEZFRkYwMDc0MDA2NTAwNzMwMDc0MDAyRDAwNjYwMDY5MDA3ODAwNzQwMDc1MDA3MjAwNjU+Ci9Nb2REYXRlIChEOjIwMjAwMTAxMDAwMDAwWikKL0NyZWF0b3IgPEZFRkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyMDAwMjgwMDY4MDA3NDAwNzQwMDcwMDA3MzAwM0EwMDJGMDAyRjAwNjcwMDY5MDA3NDAwNjgwMDc1MDA2MjAwMkUwMDYzMDA2RjAwNkQwMDJGMDA0ODAwNkYwMDcwMDA2NDAwNjkwMDZFMDA2NzAwMkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyOT4KL0NyZWF0aW9uRGF0ZSAoRDoyMDIwMDEwMTAwMDAwMFopCi9UaXRsZSA8RkVGRjAwNzQwMDY1MDA3MzAwNzQ+Cj4+CmVuZG9iagoKNCAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDEgMCBSCi9SZXNvdXJjZXMgPDwKL0ZvbnQgPDwKL0hlbHZldGljYS03MDk4NDgwNzg5IDUgMCBSCj4+Ci9YT2JqZWN0IDw8Cj4+Ci9FeHRHU3RhdGUgPDwKPj4KPj4KL01lZGlhQm94IFsgMCAwIDYxMiA3OTIgXQovQW5ub3RzIFsgXQovQ29udGVudHMgWyA2IDAgUiBdCj4+CmVuZG9iagoKNSAwIG9iago8PAovVHlwZSAvRm9udAovU3VidHlwZSAvVHlwZTEKL0Jhc2VGb250IC9IZWx2ZXRpY2EKL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcKPj4KZW5kb2JqCgo2IDAgb2JqCjw8Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGggOTYKPj4Kc3RyZWFtCnicK+RyCuEyUADBonQufY/UnLLUkszkRF1zA0sLEwsDcwtLBSMThZA0LhDpw2UIVgohQ3K5bMxNzEzNjc1NjAzMzMwszS3MTcxNzY3MTO0UQrK4QrS4XEO4ArkAobMWLQplbmRzdHJlYW0KZW5kb2JqCgp4cmVmCjAgNwowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTYgMDAwMDAgbiAKMDAwMDAwMDA3NiAwMDAwMCBuIAowMDAwMDAwMTI2IDAwMDAwIG4gCjAwMDAwMDA0OTggMDAwMDAgbiAKMDAwMDAwMDY5MyAwMDAwMCBuIAowMDAwMDAwNzkxIDAwMDAwIG4gCgp0cmFpbGVyCjw8Ci9TaXplIDcKL1Jvb3QgMiAwIFIKL0luZm8gMyAwIFIKPj4KCnN0YXJ0eHJlZgo5NTkKJSVFT0Y=';
    const res = await handleRequest(
      req('POST', '/v1/envelope', {
        headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ document_name: 'Degrade', pdf_base64: TINY2, signers: [{ email: 's@example.com', name: 'S' }] }),
      }),
      deps,
    );
    assert.equal(res.status, 201, 'a token-store failure must NOT fail the create');
    const body = (await res.json()) as { tracking?: unknown };
    assert.ok(!('tracking' in body), 'no dead token: tracking is OMITTED when the store failed');
  });

  // ── F-30.3 / AC-138 — callback_url on create: stored + secret returned once ──
  it('create with a callback_url returns a whs_ callback_secret and stores the webhook row', async () => {
    const { pool } = idemPool();
    const inserted: unknown[][] = [];
    const wrapped: DbPool = {
      async query(text: string, values?: unknown[]) {
        if (/INSERT INTO envelope_webhooks/i.test(text)) {
          inserted.push(values ?? []);
          return { rows: [], rowCount: 1 } as unknown as pg.QueryResult;
        }
        return pool.query(text, values);
      },
      async end() {},
    };
    const deps = makeDeps({
      pool: wrapped,
      apiContext: () => ({
        pool: wrapped,
        emailProvider: { async send() { return { messageId: 'm' }; } },
        baseUrl: 'https://kysigned.com',
        senderIdentity: 'agent@example.com',
        internalTestDomains: ['kychee.com'],
        storePdf: async () => {},
        deletePdf: async () => {},
        senderGate: { getCreditBalance: async () => 10_000_000 },
      }) as never,
    });
    const TINY = 'JVBERi0xLjcKJYGBgYEKCjEgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgNCAwIFIgXQovQ291bnQgMQo+PgplbmRvYmoKCjIgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCj4+CmVuZG9iagoKMyAwIG9iago8PAovUHJvZHVjZXIgPEZFRkYwMDc0MDA2NTAwNzMwMDc0MDAyRDAwNjYwMDY5MDA3ODAwNzQwMDc1MDA3MjAwNjU+Ci9Nb2REYXRlIChEOjIwMjAwMTAxMDAwMDAwWikKL0NyZWF0b3IgPEZFRkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyMDAwMjgwMDY4MDA3NDAwNzQwMDcwMDA3MzAwM0EwMDJGMDAyRjAwNjcwMDY5MDA3NDAwNjgwMDc1MDA2MjAwMkUwMDYzMDA2RjAwNkQwMDJGMDA0ODAwNkYwMDcwMDA2NDAwNjkwMDZFMDA2NzAwMkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyOT4KL0NyZWF0aW9uRGF0ZSAoRDoyMDIwMDEwMTAwMDAwMFopCi9UaXRsZSA8RkVGRjAwNzQwMDY1MDA3MzAwNzQ+Cj4+CmVuZG9iagoKNCAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDEgMCBSCi9SZXNvdXJjZXMgPDwKL0ZvbnQgPDwKL0hlbHZldGljYS03MDk4NDgwNzg5IDUgMCBSCj4+Ci9YT2JqZWN0IDw8Cj4+Ci9FeHRHU3RhdGUgPDwKPj4KPj4KL01lZGlhQm94IFsgMCAwIDYxMiA3OTIgXQovQW5ub3RzIFsgXQovQ29udGVudHMgWyA2IDAgUiBdCj4+CmVuZG9iagoKNSAwIG9iago8PAovVHlwZSAvRm9udAovU3VidHlwZSAvVHlwZTEKL0Jhc2VGb250IC9IZWx2ZXRpY2EKL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcKPj4KZW5kb2JqCgo2IDAgb2JqCjw8Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGggOTYKPj4Kc3RyZWFtCnicK+RyCuEyUADBonQufY/UnLLUkszkRF1zA0sLEwsDcwtLBSMThZA0LhDpw2UIVgohQ3K5bMxNzEzNjc1NjAzMzMwszS3MTcxNzY3MTO0UQrK4QrS4XEO4ArkAobMWLQplbmRzdHJlYW0KZW5kb2JqCgp4cmVmCjAgNwowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTYgMDAwMDAgbiAKMDAwMDAwMDA3NiAwMDAwMCBuIAowMDAwMDAwMTI2IDAwMDAwIG4gCjAwMDAwMDA0OTggMDAwMDAgbiAKMDAwMDAwMDY5MyAwMDAwMCBuIAowMDAwMDAwNzkxIDAwMDAwIG4gCgp0cmFpbGVyCjw8Ci9TaXplIDcKL1Jvb3QgMiAwIFIKL0luZm8gMyAwIFIKPj4KCnN0YXJ0eHJlZgo5NTkKJSVFT0Y=';
    const res = await handleRequest(
      req('POST', '/v1/envelope', {
        headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          document_name: 'Hooked',
          pdf_base64: TINY,
          callback_url: 'https://agent.example.com/hook',
          signers: [{ email: 's@example.com', name: 'S' }],
        }),
      }),
      deps,
    );
    assert.equal(res.status, 201, `create with callback_url must 201, got ${res.status}`);
    const body = (await res.json()) as { callback_secret?: string };
    assert.ok(body.callback_secret?.startsWith('whs_'), 'callback_secret returned once at create');
    assert.equal(inserted.length, 1, 'webhook row stored');
    assert.ok(inserted[0]!.includes('https://agent.example.com/hook'));
    // #155 lockstep hop 1: every key of the real 201 body is in the canonical
    // list that the kysigned-mcp projection mirrors (hop 2 lives in the MCP
    // contract suite). A new 201 field not added there fails HERE, not by
    // silently vanishing from MCP results.
    const { CREATE_201_RESULT_FIELDS } = await import('../api/envelopeResultFields.js');
    for (const k of Object.keys(body)) {
      assert.ok(
        (CREATE_201_RESULT_FIELDS as readonly string[]).includes(k),
        `create-201 field "${k}" missing from CREATE_201_RESULT_FIELDS (and the MCP projection)`,
      );
    }
  });

  it('create with an invalid callback_url → 400 validation_callback_url', async () => {
    const { pool } = idemPool();
    const deps = makeDeps({
      pool,
      apiContext: () => ({ pool }) as never,
    });
    const res = await handleRequest(
      req('POST', '/v1/envelope', {
        headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          document_name: 'Bad hook',
          pdf_base64: 'JVBERi0x',
          callback_url: 'http://10.0.0.5/hook',
          signers: [{ email: 's@example.com', name: 'S' }],
        }),
      }),
      deps,
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, 'validation_callback_url');
  });
});

// ── F-16.7 / AC-140 — SSRF guard on the pdf_url create path ─────────────────
describe('handleRequest — pdf_url SSRF guard (F-16.7 / AC-140)', () => {
  const RAW_KEY = 'ksk_' + 'f'.repeat(64);
  function keyPool() {
    const pool: DbPool = {
      async query(text: string) {
        if (text.includes('FROM api_keys')) {
          return { rows: [{ id: 'k-1', creator_email: 'agent@example.com', key_hash: 'h', label: null, created_at: new Date(), last_used_at: null, revoked_at: null }], rowCount: 1 } as unknown as pg.QueryResult;
        }
        return { rows: [], rowCount: 0 } as unknown as pg.QueryResult;
      },
      async end() {},
    };
    return pool;
  }
  const mkDeps = (pool: DbPool) => makeDeps({
    pool,
    apiContext: () => ({ pool, baseUrl: 'https://kysigned.com', operatorDomain: 'kysigned.com', senderIdentity: 'agent@example.com', internalTestDomains: [] }) as never,
  });

  it('a pdf_url pointing at a literal private/metadata host → 400 validation_pdf_url (no fetch, no charge)', async () => {
    for (const url of ['https://169.254.169.254/latest/meta-data/', 'https://10.0.0.5/x.pdf', 'http://cdn.example.com/x.pdf']) {
      const res = await handleRequest(
        req('POST', '/v1/envelope', {
          headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ document_name: 'Doc', pdf_url: url, signers: [{ email: 's@example.com', name: 'S' }] }),
        }),
        mkDeps(keyPool()),
      );
      assert.equal(res.status, 400, `${url} must 400`);
      const body = (await res.json()) as { code?: string };
      assert.equal(body.code, 'validation_pdf_url', `${url} → validation_pdf_url`);
    }
  });
});

// ── F-30.2 — the x402 always-priced create route (spec 0.39.0 / AC-134) ─────
describe('handleRequest — x402 create dispatch gates (F-30.2)', () => {
  const SETTLED = {
    scheme: 'x402' as const,
    paymentId: 'pay_disp1',
    amountUsdMicros: 250_000,
    payer: null,
    network: 'base',
    asset: null,
    payTo: '0x8d671cd12ecf69e0b049a6b55c5b318097b4bc35',
    transaction: null,
    settledAt: '2026-07-08T10:00:00.000Z',
  };

  it('operator has NO x402 config → 404 payment_x402_not_enabled, even with a settled context (fork-inert)', async () => {
    const res = await handleRequest(
      req('POST', '/v1/x402/envelope', { headers: { 'content-type': 'application/json' }, body: '{}' }),
      makeDeps({ readPaymentContext: () => SETTLED } as never),
    );
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, 'payment_x402_not_enabled');
  });

  it('config on but NO settled context reached the fn → 503 payment_x402_unavailable (fail-closed)', async () => {
    const res = await handleRequest(
      req('POST', '/v1/x402/envelope', { headers: { 'content-type': 'application/json' }, body: '{}' }),
      makeDeps({ x402: { priceUsdMicros: 250_000 }, readPaymentContext: () => null } as never),
    );
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { code: string }).code, 'payment_x402_unavailable');
  });

  it('a settled context dispatches with NO session/key — an Authorization header is ignored, orchestration is reached', async () => {
    // Body lacks creator_email → the orchestration's 400 proves the request
    // passed the auth-free dispatch (no 401/403 despite the garbage bearer)
    // and reached the x402 handler. apiContext stays a thrower: that path
    // must not build a create ctx before validation.
    const res = await handleRequest(
      req('POST', '/v1/x402/envelope', {
        headers: { 'content-type': 'application/json', authorization: 'Bearer ksk_garbage' },
        body: '{}',
      }),
      makeDeps({ x402: { priceUsdMicros: 250_000 }, readPaymentContext: () => SETTLED } as never),
    );
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, 'validation_creator_email');
  });
});

// ── F-30.7 / #154 — the envelope-observer branch (tracking token) ─────────────
describe('tracking-token observer (F-30.7, AC-173/AC-174)', () => {
  const TOKEN = 'ktt_' + 'A'.repeat(43);
  const OTHER = 'ktt_' + 'B'.repeat(43);

  function observerPool(boundEnvelopeId: string | null) {
    return makePool((text) => {
      if (/FROM envelope_tracking_tokens/i.test(text)) {
        return boundEnvelopeId ? [{ envelope_id: boundEnvelopeId }] : [];
      }
      if (/SELECT \* FROM envelopes WHERE id = \$1/i.test(text)) {
        return [{
          id: 'env-7', sender_email: 'creator@example.com', document_name: 'NDA',
          document_hash: 'h', status: 'active', auto_close: true,
          created_at: new Date('2026-07-17T00:00:00Z'), completed_at: null,
          completion_distributed_at: null, expiry_at: null, pdf_deleted_at: null,
        }];
      }
      if (/FROM envelope_signers/i.test(text)) {
        return [{
          id: 'sg-1', envelope_id: 'env-7', email: 'alice@example.com', name: 'Alice',
          on_behalf_of: null, status: 'pending', signing_method: null, signed_at: null,
          undeliverable_at: null, delivery_confirmed_at: null, completion_email_provider_msg_id: null,
          signing_token: 't', reminder_count: 0,
        }];
      }
      if (/FROM signature_artifacts/i.test(text)) return [];
      return [];
    });
  }

  it('AC-173 — a valid token reads its OWN envelope: 200 with the FULL roster (email, signing + delivery status), no session', async () => {
    const { pool } = observerPool('env-7');
    const res = await handleRequest(
      req('GET', '/v1/envelope/env-7', { headers: { authorization: TOKEN } }),
      makeDeps({ pool }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; status: string; signers: Array<Record<string, unknown>> };
    assert.equal(body.id, 'env-7');
    assert.equal(body.status, 'active');
    assert.equal(body.signers[0]!.email, 'alice@example.com', 'FULL roster: signer emails present (Barry decision 2)');
    assert.equal(body.signers[0]!.status, 'pending');
    assert.equal(body.signers[0]!.delivery_status, 'pending', 'per-signer delivery status present');
  });

  it('AC-174 — a valid token against ANY OTHER envelope gets the stranger 404', async () => {
    const { pool } = observerPool('env-7');
    const res = await handleRequest(
      req('GET', '/v1/envelope/env-8', { headers: { authorization: TOKEN } }),
      makeDeps({ pool }),
    );
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, 'not_found');
  });

  it('an unknown/revoked token → 401 auth_invalid_key (an invalid credential, not a 404 oracle)', async () => {
    const { pool } = observerPool(null);
    const res = await handleRequest(
      req('GET', '/v1/envelope/env-7', { headers: { authorization: OTHER } }),
      makeDeps({ pool }),
    );
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, 'auth_invalid_key');
  });

  it('AC-174 — the refusal matrix: every mutation/list/download route refuses ktt_ machine-readably, handlers never run', async () => {
    const { pool, queries } = observerPool('env-7');
    const deps = makeDeps({ pool });
    const attempts: Array<[string, string]> = [
      ['POST', '/v1/envelope/env-7/remind'],
      ['POST', '/v1/envelope/env-7/void'],
      ['POST', '/v1/envelope/env-7/seal'],
      ['GET', '/v1/envelopes'],
      ['GET', '/v1/envelope/env-7/pdf'],
      ['POST', '/v1/api-keys'],
    ];
    for (const [method, path] of attempts) {
      const res = await handleRequest(req(method, path, { headers: { authorization: TOKEN } }), deps);
      assert.equal(res.status, 403, `${method} ${path} must refuse a tracking token`);
      assert.equal(((await res.json()) as { code: string }).code, 'auth_tracking_scope', `${method} ${path}`);
    }
    assert.equal(queries.length, 0, 'refusals happen BEFORE any handler/DB work');
  });

  it('AC-175 — the token keeps reading through completion AND void (the observer sees the outcome)', async () => {
    for (const status of ['completed', 'voided']) {
      const { pool } = makePool((text) => {
        if (/FROM envelope_tracking_tokens/i.test(text)) return [{ envelope_id: 'env-7' }];
        if (/SELECT \* FROM envelopes WHERE id = \$1/i.test(text)) {
          return [{
            id: 'env-7', sender_email: 'creator@example.com', document_name: 'NDA',
            document_hash: 'h', status, auto_close: true,
            created_at: new Date('2026-07-17T00:00:00Z'),
            completed_at: status === 'completed' ? new Date('2026-07-17T01:00:00Z') : null,
            completion_distributed_at: null, expiry_at: null, pdf_deleted_at: null,
          }];
        }
        if (/FROM envelope_signers/i.test(text)) return [];
        if (/FROM signature_artifacts/i.test(text)) return [];
        return [];
      });
      const res = await handleRequest(
        req('GET', '/v1/envelope/env-7', { headers: { authorization: TOKEN } }),
        makeDeps({ pool }),
      );
      assert.equal(res.status, 200, `observer read must survive status=${status}`);
      assert.equal(((await res.json()) as { status: string }).status, status);
    }
  });

  it('Bearer-prefixed tracking tokens are accepted on the observer read (header spelling parity with ksk_)', async () => {
    const { pool } = observerPool('env-7');
    const res = await handleRequest(
      req('GET', '/v1/envelope/env-7', { headers: { authorization: `Bearer ${TOKEN}` } }),
      makeDeps({ pool }),
    );
    assert.equal(res.status, 200);
  });
});

// ── F-33.1 / AC-177 + AC-178 — the operator gate on /v1/admin/* ─────────────────
// The F-3.6 allowlist-management endpoints are operator-only. Before #157 any
// signed-in creator could reach them (the "operator-gated in the handler" comment
// gated nothing); the gate now refuses a non-operator SESSION with 403
// `auth_operator_scope`, is fail-closed on an empty allowlist, and still refuses a
// bearer key with 403 `auth_key_scope` (allowed-senders are out of BEARER_ROUTES).
describe('handleRequest — operator gate (F-33.1 / AC-177, AC-178, #157)', () => {
  const CSRF = () => ({ 'content-type': 'application/json' } as Record<string, string>);
  const cookie = () => `${SESSION_COOKIE}=${VALID_SESSION_ID}`;

  it('a signed-in NON-operator creator is refused GET /v1/admin/allowed-senders → 403 auth_operator_scope (#157)', async () => {
    const res = await handleRequest(
      req('GET', '/v1/admin/allowed-senders', { headers: { cookie: cookie() } }),
      makeDeps({ pool: validSessionPool('creator@example.com'), operatorEmails: ['op@kychee.com'] }),
    );
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'auth_operator_scope');
  });

  it('a signed-in NON-operator creator is refused POST /v1/admin/allowed-senders → 403 auth_operator_scope (#157)', async () => {
    const res = await handleRequest(
      req('POST', '/v1/admin/allowed-senders', {
        headers: { cookie: cookie(), [CSRF_HEADER]: '1', ...CSRF() },
        body: JSON.stringify({ identity_type: 'email', identity: 'x@y.com', quota_per_month: null }),
      }),
      makeDeps({ pool: validSessionPool('creator@example.com'), operatorEmails: ['op@kychee.com'] }),
    );
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'auth_operator_scope');
  });

  it('a signed-in NON-operator creator is refused DELETE /v1/admin/allowed-senders/:id → 403 auth_operator_scope (#157)', async () => {
    const res = await handleRequest(
      req('DELETE', '/v1/admin/allowed-senders/row-1?identity_type=email&identity=x@y.com', {
        headers: { cookie: cookie(), [CSRF_HEADER]: '1' },
      }),
      makeDeps({ pool: validSessionPool('creator@example.com'), operatorEmails: ['op@kychee.com'] }),
    );
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'auth_operator_scope');
  });

  it('FAIL-CLOSED — an empty operator allowlist refuses even an operator-looking session → 403', async () => {
    const res = await handleRequest(
      req('GET', '/v1/admin/allowed-senders', { headers: { cookie: cookie() } }),
      makeDeps({ pool: validSessionPool('op@kychee.com'), operatorEmails: [] }),
    );
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'auth_operator_scope');
  });

  it('an operator session reaches the handler → 200', async () => {
    const res = await handleRequest(
      req('GET', '/v1/admin/allowed-senders', { headers: { cookie: cookie() } }),
      makeDeps({
        pool: validSessionPool('op@kychee.com'),
        operatorEmails: ['op@kychee.com'],
        adminCtx: (operator: string) => ({ pool: makePool(() => []).pool, operator }),
      }),
    );
    assert.equal(res.status, 200);
  });

  it('a bearer key is still refused on an operator route → 403 auth_key_scope (out of BEARER_ROUTES)', async () => {
    const res = await handleRequest(
      req('GET', '/v1/admin/allowed-senders', { headers: { authorization: 'ksk_deadbeef' } }),
      makeDeps({ operatorEmails: ['op@kychee.com'] }),
    );
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'auth_key_scope');
  });
});

// ── F-34.2 / AC-183 — the operator overview KPIs ────────────────────────────────
describe('handleRequest — operator overview (F-34.2 / AC-183)', () => {
  const cookie = () => `${SESSION_COOKIE}=${VALID_SESSION_ID}`;

  it('a non-operator session is refused → 403 auth_operator_scope', async () => {
    const res = await handleRequest(
      req('GET', '/v1/admin/overview?window=30d', { headers: { cookie: cookie() } }),
      makeDeps({ pool: validSessionPool('creator@example.com'), operatorEmails: ['op@kychee.com'] }),
    );
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'auth_operator_scope');
  });

  it('an operator gets the overview KPIs + the echoed window → 200', async () => {
    const res = await handleRequest(
      req('GET', '/v1/admin/overview?window=all', { headers: { cookie: cookie() } }),
      makeDeps({
        pool: validSessionPool('op@kychee.com'),
        operatorEmails: ['op@kychee.com'],
        adminCtx: (operator: string) => ({
          pool: createAdminAnalyticsMemoryPool({
            userCredits: [{ email: 'a@x.com', balance_usd_micros: 750000, created_at: '2026-07-10T00:00:00Z' }],
            envelopes: [{ sender_email: 'a@x.com', status: 'completed', created_at: '2026-07-10T00:00:00Z', completed_at: '2026-07-11T00:00:00Z' }],
          }).pool,
          operator,
        }),
      }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      window: string; accountsOpened: number; envelopes: Record<string, number>; credits: unknown; activeUsers: unknown;
    };
    assert.equal(body.window, 'all');
    assert.equal(body.accountsOpened, 1);
    assert.deepEqual(body.envelopes, { created: 1, completed: 1, inProcess: 0 });
    assert.ok(body.credits && body.activeUsers);
  });
});

// ── F-34.3 / AC-184-185 — the operator Accounts page ────────────────────────────
describe('handleRequest — operator accounts (F-34.3 / AC-184, AC-185)', () => {
  const cookie = () => `${SESSION_COOKIE}=${VALID_SESSION_ID}`;

  it('a non-operator session is refused → 403 auth_operator_scope', async () => {
    const res = await handleRequest(
      req('GET', '/v1/admin/accounts?window=all', { headers: { cookie: cookie() } }),
      makeDeps({ pool: validSessionPool('creator@example.com'), operatorEmails: ['op@kychee.com'] }),
    );
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'auth_operator_scope');
  });

  it('an operator gets the classified accounts list → 200', async () => {
    const res = await handleRequest(
      req('GET', '/v1/admin/accounts?window=all', { headers: { cookie: cookie() } }),
      makeDeps({
        pool: validSessionPool('op@kychee.com'),
        operatorEmails: ['op@kychee.com'],
        adminCtx: (operator: string) => ({
          pool: createAdminAnalyticsMemoryPool({
            userCredits: [{ email: 'w@x.com', balance_usd_micros: 250000, created_at: '2026-07-14T00:00:00Z' }],
            envelopes: [{ sender_email: 'w@x.com', status: 'active', created_at: '2026-07-14T00:00:00Z', completed_at: null }],
            creditLedger: [{ email: 'w@x.com', source: 'x402', delta_usd_micros: 250000, created_at: '2026-07-14T00:00:00Z' }],
          }).pool,
          operator,
        }),
      }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { window: string; accounts: Array<{ email: string; kind: string; walletFunded: boolean }> };
    assert.equal(body.window, 'all');
    assert.equal(body.accounts.length, 1);
    assert.equal(body.accounts[0].email, 'w@x.com');
    assert.equal(body.accounts[0].kind, 'agent'); // x402 + no session
    assert.equal(body.accounts[0].walletFunded, true);
  });
});

// ── F-34.4 / AC-186 — the operator Envelopes funnel ─────────────────────────────
describe('handleRequest — operator envelopes funnel (F-34.4 / AC-186)', () => {
  const cookie = () => `${SESSION_COOKIE}=${VALID_SESSION_ID}`;

  it('a non-operator session is refused → 403 auth_operator_scope', async () => {
    const res = await handleRequest(
      req('GET', '/v1/admin/envelopes?window=all', { headers: { cookie: cookie() } }),
      makeDeps({ pool: validSessionPool('creator@example.com'), operatorEmails: ['op@kychee.com'] }),
    );
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'auth_operator_scope');
  });

  it('an operator gets the funnel + drill-down list → 200', async () => {
    const res = await handleRequest(
      req('GET', '/v1/admin/envelopes?window=all', { headers: { cookie: cookie() } }),
      makeDeps({
        pool: validSessionPool('op@kychee.com'),
        operatorEmails: ['op@kychee.com'],
        adminCtx: (operator: string) => ({
          pool: createAdminAnalyticsMemoryPool({
            envelopes: [
              { id: 'e1', sender_email: 'a@x.com', document_name: 'd', status: 'completed', created_at: '2026-07-10T00:00:00Z', completed_at: '2026-07-11T00:00:00Z' },
              { id: 'e2', sender_email: 'a@x.com', document_name: 'd', status: 'active', created_at: '2026-07-15T00:00:00Z', completed_at: null },
            ],
          }).pool,
          operator,
        }),
      }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { window: string; created: number; completed: number; list: unknown[] };
    assert.equal(body.window, 'all');
    assert.equal(body.created, 2);
    assert.equal(body.completed, 1);
    assert.equal(body.list.length, 2);
  });
});

// ── F-34.5 / AC-187 — the operator signals ──────────────────────────────────────
describe('handleRequest — operator signals (F-34.5 / AC-187)', () => {
  const cookie = () => `${SESSION_COOKIE}=${VALID_SESSION_ID}`;

  it('a non-operator session is refused → 403 auth_operator_scope', async () => {
    const res = await handleRequest(
      req('GET', '/v1/admin/signals?window=all', { headers: { cookie: cookie() } }),
      makeDeps({ pool: validSessionPool('creator@example.com'), operatorEmails: ['op@kychee.com'] }),
    );
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'auth_operator_scope');
  });

  it('an operator gets deliverability + agent-adoption → 200', async () => {
    const res = await handleRequest(
      req('GET', '/v1/admin/signals?window=all', { headers: { cookie: cookie() } }),
      makeDeps({
        pool: validSessionPool('op@kychee.com'),
        operatorEmails: ['op@kychee.com'],
        adminCtx: (operator: string) => ({
          pool: createAdminAnalyticsMemoryPool({
            envelopes: [{ id: 'e1', sender_email: 'w@x.com', status: 'active', created_at: '2026-07-14T00:00:00Z' }],
            creditLedger: [{ email: 'w@x.com', source: 'x402', delta_usd_micros: 250000, created_at: '2026-07-14T00:00:00Z' }],
            signers: [{ envelope_id: 'e1', status: 'signed', undeliverable_at: null }],
          }).pool,
          operator,
        }),
      }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { deliverability: { invited: number }; agentAdoption: { walletCreates: number } };
    assert.equal(body.deliverability.invited, 1);
    assert.equal(body.agentAdoption.walletCreates, 1);
  });
});

// ── F-33.3 / AC-180 — the operator reconciliation read ──────────────────────────
// GET /v1/admin/archive-confirmations is operator-gated and returns the outstanding
// (non-clean) archive-confirmation backlog, shaped for the dashboard: envelope +
// signer context, the state (NULL → "unknown"), and the confirmation timestamps.
describe('handleRequest — operator archive-confirmations read (F-33.3 / AC-180)', () => {
  const cookie = () => `${SESSION_COOKIE}=${VALID_SESSION_ID}`;
  const artifactRow = (over: Record<string, unknown> = {}) => ({
    id: 'sa-1', envelope_id: 'env-9', signer_email: 'signer@x.com', sha256_eml: 'a'.repeat(64),
    dkim_domain: 'x.com', dkim_selector: 'sel', archive_confirmation: 'outage', ts_status: 'pending',
    archive_confirmation_checked_at: new Date('2026-07-16T08:00:00Z'), archive_confirmation_healed_at: null,
    created_at: new Date('2026-07-15T08:00:00Z'), updated_at: new Date('2026-07-15T08:00:00Z'), ...over,
  });
  const operatorDepsReturning = (row: Record<string, unknown>) =>
    makeDeps({
      pool: validSessionPool('op@kychee.com'),
      operatorEmails: ['op@kychee.com'],
      adminCtx: (operator: string) => ({
        pool: makePool((text) => (text.includes('created_at DESC') ? [row] : [])).pool,
        operator,
      }),
    });

  it('a non-operator session is refused → 403 auth_operator_scope (the route is operator-gated)', async () => {
    const res = await handleRequest(
      req('GET', '/v1/admin/archive-confirmations', { headers: { cookie: cookie() } }),
      makeDeps({ pool: validSessionPool('creator@example.com'), operatorEmails: ['op@kychee.com'] }),
    );
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'auth_operator_scope');
  });

  it('an operator gets the outstanding artifacts shaped for the dashboard → 200', async () => {
    const res = await handleRequest(
      req('GET', '/v1/admin/archive-confirmations', { headers: { cookie: cookie() } }),
      operatorDepsReturning(artifactRow()),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { outstanding: Array<Record<string, unknown>> };
    assert.equal(body.outstanding.length, 1);
    assert.equal(body.outstanding[0].envelope_id, 'env-9');
    assert.equal(body.outstanding[0].signer_email, 'signer@x.com');
    assert.equal(body.outstanding[0].dkim_domain, 'x.com');
    assert.equal(body.outstanding[0].dkim_selector, 'sel');
    assert.equal(body.outstanding[0].state, 'outage');
    assert.equal(body.outstanding[0].checked_at, '2026-07-16T08:00:00.000Z');
    assert.equal(body.outstanding[0].healed_at, null);
  });

  it('a NULL archive_confirmation surfaces as the "unknown" state', async () => {
    const res = await handleRequest(
      req('GET', '/v1/admin/archive-confirmations', { headers: { cookie: cookie() } }),
      operatorDepsReturning(artifactRow({ archive_confirmation: null, archive_confirmation_checked_at: null })),
    );
    const body = (await res.json()) as { outstanding: Array<{ state: string; checked_at: unknown }> };
    assert.equal(body.outstanding[0].state, 'unknown');
    assert.equal(body.outstanding[0].checked_at, null);
  });
});

// ── F-33.5 / AC-197 — metadata-only operator surface (documents never shown) ────
describe('handleRequest — F-33.5 metadata-only operator surface (AC-197)', () => {
  const cookie = () => `${SESSION_COOKIE}=${VALID_SESSION_ID}`;

  it('the admin-surface inventory is exactly the registered metadata set (drift guard)', () => {
    // Every admin-surface handler invocation flows through `deps.adminCtx(` —
    // the single choke point. A new admin read/write must bump this count AND
    // join the metadata-only sweep below.
    const src = readFileSync(join(import.meta.dirname, 'api.ts'), 'utf8');
    const adminCtxCalls = src.match(/deps\.adminCtx\(/g) ?? [];
    assert.equal(
      adminCtxCalls.length,
      11, // +2 2026-07-19: adminActive + adminSignalRows (F-34.8 tile drill-downs), swept below
      'a NEW admin-surface handler appeared — register it here and cover it in the metadata-only sweep below',
    );
  });

  it('every admin GET returns JSON metadata — never document bytes or base64 payloads', async () => {
    const routes = [
      '/v1/admin/overview?window=all',
      '/v1/admin/accounts?window=all',
      '/v1/admin/envelopes?window=all',
      '/v1/admin/signals?window=all',
      '/v1/admin/ledger?window=all&group=paid_in',
      '/v1/admin/active?window=all',
      '/v1/admin/signal-rows?window=all&group=invited',
      '/v1/admin/archive-confirmations',
      '/v1/admin/allowed-senders',
    ];
    for (const path of routes) {
      const res = await handleRequest(
        req('GET', path, { headers: { cookie: cookie() } }),
        makeDeps({
          pool: validSessionPool('op@kychee.com'),
          operatorEmails: ['op@kychee.com'],
          adminCtx: (operator: string) => ({ pool: makePool(() => []).pool, operator, internalIdentities: [] }),
        }),
      );
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/, `${path}: JSON only`);
      const body = await res.text();
      assert.ok(!body.includes('%PDF-'), `${path}: no PDF bytes`);
      assert.ok(!/base64/i.test(body), `${path}: no base64 payload fields`);
      JSON.parse(body);
    }
  });

  it('operator status opens no document path: the envelope PDF route refuses an operator on a non-owned envelope', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const pool: DbPool = {
      async query(text: string) {
        if (text.includes('FROM auth_sessions')) {
          return {
            rows: [{
              session_id: VALID_SESSION_ID,
              email: 'op@kychee.com',
              run402_access_token: 'a',
              run402_refresh_token: 'r',
              access_token_expires_at: future,
              session_expires_at: future,
              created_at: future,
            }],
            rowCount: 1,
          } as never;
        }
        if (/SELECT \* FROM envelopes WHERE id = \$1/i.test(text)) {
          return {
            rows: [{
              id: 'env-9', sender_email: 'other-creator@x.com', document_name: 'NDA',
              document_hash: 'h', status: 'active', auto_close: true,
              created_at: future, completed_at: null, completion_distributed_at: null,
              expiry_at: null, pdf_deleted_at: null,
            }],
            rowCount: 1,
          } as never;
        }
        return { rows: [], rowCount: 0 } as never;
      },
      async end() {},
    };
    const res = await handleRequest(
      req('GET', '/v1/envelope/env-9/pdf', { headers: { cookie: cookie() } }),
      makeDeps({ pool, operatorEmails: ['op@kychee.com'] }),
    );
    assert.ok(res.status === 403 || res.status === 404, `operator gets no document: ${res.status}`);
    const body = await res.text();
    assert.ok(!body.includes('%PDF-'), 'no document bytes in the refusal');
  });
});
