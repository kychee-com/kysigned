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
import type pg from 'pg';
import { handleRequest, type RequestDeps } from './api.js';
import type { AppDeps } from './config.js';
import type { DbPool } from '../db/pool.js';
import { CSRF_HEADER, SESSION_COOKIE } from '../api/auth/session.js';

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

  it('dispatches a public route (health) with no auth', async () => {
    const res = await handleRequest(req('GET', '/v1/health'), makeDeps());
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; service: string };
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'kysigned');
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
  it('POST /v1/test/reset-user with the secret + a matched identity → 200 (five DELETEs)', async () => {
    const { pool, queries } = makePool(() => []);
    const res = await handleRequest(
      req('POST', '/v1/test/reset-user', {
        headers: { 'content-type': 'application/json', 'x-test-reset-secret': 'S3CRET' },
        body: JSON.stringify({ email: 'redteam@kysigned.com' }),
      }),
      makeDeps({ pool, testResetSecret: 'S3CRET', testResetPattern: /^redteam.*@kysigned\.com$/ }),
    );
    assert.equal(res.status, 200);
    // signature_artifacts (FK-uncascaded) + envelopes + auth_sessions + user_credits + credit_ledger
    assert.equal(queries.filter((q) => /^DELETE FROM/.test(q.text.trim())).length, 5);
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

  it('an unsafe (POST) route with a valid bearer key and NO CSRF header is CSRF-EXEMPT (no 403)', async () => {
    const { pool } = keyPool();
    // remindEnvelope hits reminderSendCtx (a thrower in makeDeps) AFTER the gate —
    // reaching the thrower proves the gate passed; a 401/403 means it did not.
    await assert.rejects(
      handleRequest(
        req('POST', '/v1/envelope/env-1/remind', { headers: { authorization: `Bearer ${RAW_KEY}` } }),
        makeDeps({ pool }),
      ),
      /unexpected ctx build: reminderSendCtx/,
      'gate must pass the bearer POST through to dispatch (CSRF-exempt)',
    );
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
