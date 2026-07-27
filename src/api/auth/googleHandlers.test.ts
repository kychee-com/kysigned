/**
 * googleHandlers.test.ts — F-41's three server doors (DD-58..62):
 *
 *   POST /v1/auth/google/start     (public)  → ceremony row + run402 machine start
 *   POST /v1/auth/google/exchange  (public)  → consume ceremony + code exchange →
 *                                              the SAME session/grant/attribution/
 *                                              telemetry downstream as magic-link,
 *                                              plus the ceremony draft claim
 *   POST /v1/auth/google/link      (session) → intent=link with the session's
 *                                              stored run402 Bearer
 *
 * Fixtures pin run402's REAL wire shapes (read at run402-private@414cc643):
 * start body/authorization_url, `grant_type=authorization_code` + code_verifier,
 * the session envelope with `user.email_verified_at` + `provider:"google"`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DbPool } from '../../db/pool.js';
import { SESSION_COOKIE } from './session.js';
import { pkceChallengeS256 } from '../../db/googleCeremonies.js';
import {
  handleGoogleStart,
  handleGoogleExchange,
  handleGoogleLink,
  handleGoogleDisconnect,
  type GoogleHandlerCtx,
} from './googleHandlers.js';

const CEREMONY_ID = 'gc_00000000-0000-4000-8000-000000000001';
const HANDLE = 'ps_00000000-0000-4000-8000-000000000000.' + 'S'.repeat(43);

interface UpstreamCall {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** run402 fake: captures start + token calls, answers with pinned wire shapes. */
function run402Fake(opts: {
  startStatus?: number;
  tokenStatus?: number;
  emailVerifiedAt?: string | null;
  userEmail?: string;
} = {}) {
  const calls: UpstreamCall[] = [];
  const impl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, body, headers: init?.headers ?? {} });
    if (url.includes('/auth/v1/oauth/google/start')) {
      const status = opts.startStatus ?? 200;
      return {
        status,
        ok: status < 300,
        json: async () =>
          status < 300
            ? { provider: 'google', authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=platform', expires_in: 600 }
            : { error: 'Google OAuth is not configured' },
      };
    }
    if (url.includes('/auth/v1/token')) {
      const status = opts.tokenStatus ?? 200;
      return {
        status,
        ok: status < 300,
        json: async () =>
          status < 300
            ? {
                access_token: 'at-google',
                refresh_token: 'rt-google',
                token_type: 'bearer',
                expires_in: 2700,
                user: {
                  id: 'u_1',
                  email: opts.userEmail ?? 'Fresh.User@gmail.com',
                  email_verified_at: opts.emailVerifiedAt === undefined ? '2026-07-26T10:00:00.000Z' : opts.emailVerifiedAt,
                  display_name: null,
                  avatar_url: null,
                },
                provider: 'google',
              }
            : { error: 'Invalid, expired, or already used authorization code' },
      };
    }
    return { status: 404, ok: false, json: async () => ({}) };
  };
  return { impl, calls };
}

/** Pool fake: ceremony insert/consume + session insert + generic rows. */
function fakePool(opts: { ceremony?: Record<string, unknown> | null } = {}) {
  const sessions: string[] = [];
  const inserted: Array<{ text: string; values: unknown[] }> = [];
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as unknown[];
      if (text.includes('INSERT INTO google_signin_ceremonies')) {
        inserted.push({ text, values: v });
        return { rows: [], rowCount: 1 } as never;
      }
      if (text.startsWith('UPDATE google_signin_ceremonies')) {
        if (opts.ceremony === null) return { rows: [], rowCount: 0 } as never;
        return {
          rows: [{
            id: CEREMONY_ID,
            pkce_verifier: 'v'.repeat(43),
            draft_handle: null,
            gclid: null,
            link_email: null,
            gate_trigger: 'direct',
            created_at: '2026-07-26T10:00:00.000Z',
            expires_at: '2026-07-26T10:10:00.000Z',
            consumed_at: '2026-07-26T10:05:00.000Z',
            ...(opts.ceremony ?? {}),
          }],
          rowCount: 1,
        } as never;
      }
      if (text.includes('INSERT INTO auth_sessions')) {
        sessions.push(v[0] as string);
        return { rows: [], rowCount: 0 } as never;
      }
      if (text.includes('auth_sessions') && text.includes('SELECT')) {
        return { rows: [{ session_id: 'sess-1', email: 'owner@example.com', run402_access_token: 'at-owner', run402_refresh_token: 'rt', access_expires_at: new Date(Date.now() + 3600_000).toISOString() }], rowCount: 1 } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    },
    async end() {},
  };
  return { pool, sessions, inserted };
}

function baseCtx(pool: DbPool, fImpl: GoogleHandlerCtx['auth']['session']['fetchImpl'], over: Partial<GoogleHandlerCtx> = {}): GoogleHandlerCtx {
  return {
    auth: { pool, appBaseUrl: 'https://kysigned.com', session: { projectAnonKey: 'anon', secure: true, fetchImpl: fImpl } },
    methods: async () => ({ google: true }),
    ...over,
  };
}

describe('handleGoogleStart (F-41.1/73.3)', () => {
  it('creates the ceremony and starts run402 with S256 challenge, /dashboard redirect and the ceremony id as client_state', async () => {
    const { impl, calls } = run402Fake();
    const { pool, inserted } = fakePool();
    const r = await handleGoogleStart(baseCtx(pool, impl), { draft_id: HANDLE, trigger: 'send' });
    assert.equal(r.status, 200);
    assert.equal((r.body as { authorization_url?: string }).authorization_url, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=platform');

    assert.equal(inserted.length, 1, 'one ceremony row per start');
    const verifier = inserted[0]!.values[1] as string;
    assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/, 'PKCE verifier minted server-side');
    assert.equal(inserted[0]!.values[2], HANDLE, 'the draft handle stays server-side in the ceremony row');
    assert.equal(inserted[0]!.values[5], 'send', 'the gate trigger is recorded for the funnel');

    const start = calls.find((c) => c.url.includes('/auth/v1/oauth/google/start'))!;
    assert.equal(start.body.redirect_url, 'https://kysigned.com/dashboard', 'the GH#20-safe SPA landing');
    assert.equal(start.body.mode, 'redirect');
    assert.equal(start.body.intent, 'signin');
    assert.equal(start.body.code_challenge, pkceChallengeS256(verifier));
    assert.equal(start.body.code_challenge_method, 'S256');
    assert.equal(typeof start.body.client_state, 'string');
    assert.match(start.body.client_state as string, /^gc_/, 'client_state carries ONLY the opaque ceremony id');
    assert.equal(start.headers['apikey'], 'anon');
  });

  it('drops a malformed draft handle instead of storing it', async () => {
    const { impl } = run402Fake();
    const { pool, inserted } = fakePool();
    await handleGoogleStart(baseCtx(pool, impl), { draft_id: 'not-a-handle' });
    assert.equal(inserted[0]!.values[2], null);
  });

  it('answers 503 with a friendly body when the platform reports Google off — and never calls upstream', async () => {
    const { impl, calls } = run402Fake();
    const { pool } = fakePool();
    const r = await handleGoogleStart(baseCtx(pool, impl, { methods: async () => ({ google: false }) }), {});
    assert.equal(r.status, 503);
    assert.equal((r.body as { code?: string }).code, 'auth_google_unavailable');
    assert.equal(calls.length, 0);
  });

  it('maps an upstream refusal to the same friendly 503 (email-only gate unaffected)', async () => {
    const { impl } = run402Fake({ startStatus: 503 });
    const { pool } = fakePool();
    const r = await handleGoogleStart(baseCtx(pool, impl), {});
    assert.equal(r.status, 503);
    assert.equal((r.body as { code?: string }).code, 'auth_google_unavailable');
  });
});

describe('handleGoogleExchange (F-41.2/73.4) — the magic-link downstream, Google edition', () => {
  it('consumes the ceremony, exchanges the code WITH the stored verifier, and issues the same session cookie', async () => {
    const { impl, calls } = run402Fake();
    const { pool, sessions } = fakePool();
    const r = await handleGoogleExchange(baseCtx(pool, impl), { code: 'authcode-1', ceremony: CEREMONY_ID });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, email: 'fresh.user@gmail.com' });
    assert.equal(sessions.length, 1, 'startSession ran — one kysigned session');
    assert.ok(r.setCookies?.[0]?.includes(SESSION_COOKIE));

    const token = calls.find((c) => c.url.includes('/auth/v1/token'))!;
    assert.ok(token.url.includes('grant_type=authorization_code'), 'the machine-flow code grant');
    assert.equal(token.body.code, 'authcode-1');
    assert.equal(token.body.code_verifier, 'v'.repeat(43), 'PKCE closes: the ceremony-held verifier rides the exchange');
  });

  it('a consumed/expired/unknown ceremony answers the one honest 401 and starts NO session', async () => {
    const { impl, calls } = run402Fake();
    const { pool, sessions } = fakePool({ ceremony: null });
    const r = await handleGoogleExchange(baseCtx(pool, impl), { code: 'authcode-1', ceremony: CEREMONY_ID });
    assert.equal(r.status, 401);
    assert.equal((r.body as { code?: string }).code, 'auth_signin_failed');
    assert.equal(sessions.length, 0);
    assert.equal(calls.length, 0, 'a dead ceremony never reaches run402 (the code may be an attacker replay)');
  });

  it('a refused code answers 401 auth_signin_failed with no session', async () => {
    const { impl } = run402Fake({ tokenStatus: 401 });
    const { pool, sessions } = fakePool();
    const r = await handleGoogleExchange(baseCtx(pool, impl), { code: 'bad', ceremony: CEREMONY_ID });
    assert.equal(r.status, 401);
    assert.equal((r.body as { code?: string }).code, 'auth_signin_failed');
    assert.equal(sessions.length, 0);
  });

  it('records session_created with method google and passes google_verified proof to the grant', async () => {
    const { impl } = run402Fake();
    const { pool } = fakePool();
    const steps: Array<{ event: string; method?: string }> = [];
    const grants: Array<{ email: string; proof?: string }> = [];
    const ctx = baseCtx(pool, impl);
    ctx.auth.telemetryStep = async (event, opts) => { steps.push({ event, method: opts?.method }); };
    ctx.grantSignupCredit = async (email, cfg) => { grants.push({ email, proof: cfg.proof }); return { granted: true, reason: 'granted', ledgerId: 'led-1' }; };
    ctx.auth.signupGrantUsdMicros = 1_000_000n;
    const events: Array<{ type: string; meta?: Record<string, unknown> }> = [];
    ctx.auth.emitAppEvent = async (type, _ids, meta) => { events.push({ type, meta }); };

    await handleGoogleExchange(ctx, { code: 'authcode-1', ceremony: CEREMONY_ID });
    assert.deepEqual(steps, [{ event: 'session_created', method: 'google' }]);
    assert.deepEqual(grants, [{ email: 'fresh.user@gmail.com', proof: 'google_verified' }]);
    // The inventory lock (appEventsInventory.test.ts) requires each emit site's
    // own suite to deepEqual the exact ids-only payload.
    assert.deepEqual(events, [
      { type: 'creator_signed_up', meta: { grant_usd_micros: 1_000_000, source: 'google' } },
    ]);
  });

  it('an email Google does not attest verified passes google_unverified (account yes, freebie no)', async () => {
    const { impl } = run402Fake({ emailVerifiedAt: null });
    const { pool } = fakePool();
    const grants: Array<{ proof?: string }> = [];
    const ctx = baseCtx(pool, impl);
    ctx.grantSignupCredit = async (_email, cfg) => { grants.push({ proof: cfg.proof }); return { granted: false, reason: 'unverified_email' }; };
    ctx.auth.signupGrantUsdMicros = 1_000_000n;
    const r = await handleGoogleExchange(ctx, { code: 'authcode-1', ceremony: CEREMONY_ID });
    assert.equal(r.status, 200, 'sign-in itself succeeds');
    assert.deepEqual(grants, [{ proof: 'google_unverified' }]);
  });

  it('claims the ceremony-held draft: the envelope outcome rides the response (AC-251)', async () => {
    const { impl } = run402Fake();
    const { pool } = fakePool({ ceremony: { draft_handle: HANDLE } });
    const claims: Array<{ handle: string; email: string }> = [];
    const ctx = baseCtx(pool, impl);
    ctx.claimCeremonyDraft = async (handle, email) => {
      claims.push({ handle, email });
      return { status: 200, body: { envelope_id: 'env-9' } };
    };
    const r = await handleGoogleExchange(ctx, { code: 'authcode-1', ceremony: CEREMONY_ID });
    assert.equal(r.status, 200);
    assert.deepEqual(claims, [{ handle: HANDLE, email: 'fresh.user@gmail.com' }]);
    assert.deepEqual(r.body, { ok: true, email: 'fresh.user@gmail.com', claim: { status: 200, envelope_id: 'env-9' } });
  });

  it('a claim REFUSAL (no credit) still signs the visitor in and reports the refusal (F-39.4)', async () => {
    const { impl } = run402Fake();
    const { pool, sessions } = fakePool({ ceremony: { draft_handle: HANDLE } });
    const ctx = baseCtx(pool, impl);
    ctx.claimCeremonyDraft = async () => ({ status: 402, body: { error: 'You need credits', code: 'payment_insufficient_credit' } });
    const r = await handleGoogleExchange(ctx, { code: 'authcode-1', ceremony: CEREMONY_ID });
    assert.equal(r.status, 200);
    assert.equal(sessions.length, 1);
    const claim = (r.body as { claim?: { status: number; code?: string } }).claim;
    assert.equal(claim?.status, 402);
    assert.equal(claim?.code, 'payment_insufficient_credit');
  });

  it('binds a ceremony-held attribution rider at establishment (AC-249): capture recorded, bind attempted', async () => {
    const { impl } = run402Fake();
    const rider = { gclid: 'Cj0Test', captured_at: new Date(Date.now() - 60_000).toISOString(), consent: 'unknown' };
    const { pool } = fakePool({ ceremony: { gclid: rider } });
    const recorded: string[] = [];
    const bound: string[] = [];
    const ctx = baseCtx(pool, impl);
    ctx.auth.attributionEnabled = true;
    ctx.attribution = {
      record: async (email, submission) => { recorded.push(`${email}:${(submission as { gclid: string }).gclid}`); },
      bind: async (email) => { bound.push(email); return { bound: true, gclid: 'Cj0Test' } as never; },
    };
    await handleGoogleExchange(ctx, { code: 'authcode-1', ceremony: CEREMONY_ID });
    assert.deepEqual(recorded, ['fresh.user@gmail.com:Cj0Test']);
    assert.deepEqual(bound, ['fresh.user@gmail.com']);
  });

  it('a LINK ceremony attaches, never signs in: no new cookie, no grant, linked:true', async () => {
    const { impl } = run402Fake({ userEmail: 'owner@example.com' });
    const { pool, sessions } = fakePool({ ceremony: { link_email: 'owner@example.com' } });
    const grants: unknown[] = [];
    const ctx = baseCtx(pool, impl);
    ctx.grantSignupCredit = async () => { grants.push(1); return { granted: false, reason: 'disabled' }; };
    const r = await handleGoogleExchange(ctx, { code: 'authcode-1', ceremony: CEREMONY_ID });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, linked: true, email: 'owner@example.com' });
    assert.equal(sessions.length, 0, 'the caller keeps their existing session');
    assert.equal(r.setCookies, undefined);
    assert.equal(grants.length, 0);
  });

  it('a LINK ceremony whose exchange resolves a DIFFERENT user is refused in plain words', async () => {
    const { impl } = run402Fake({ userEmail: 'somebody.else@example.com' });
    const { pool, sessions } = fakePool({ ceremony: { link_email: 'owner@example.com' } });
    const r = await handleGoogleExchange(baseCtx(pool, impl), { code: 'authcode-1', ceremony: CEREMONY_ID });
    assert.equal(r.status, 409);
    assert.equal((r.body as { code?: string }).code, 'auth_google_link_mismatch');
    assert.equal(sessions.length, 0);
  });
});

describe('handleGoogleLink (F-41.4/73.5) — Connect Google from a signed-in session', () => {
  it('starts intent=link with the SESSION\'s stored run402 Bearer and a linkEmail ceremony', async () => {
    const { impl, calls } = run402Fake();
    const { pool, inserted } = fakePool();
    const r = await handleGoogleLink(
      baseCtx(pool, impl),
      { email: 'owner@example.com', sessionId: 'sess-1' },
    );
    assert.equal(r.status, 200);
    assert.ok((r.body as { authorization_url?: string }).authorization_url);
    const start = calls.find((c) => c.url.includes('/auth/v1/oauth/google/start'))!;
    assert.equal(start.body.intent, 'link');
    assert.equal(start.headers['Authorization'], 'Bearer at-owner', 'the server-held run402 token, never exposed to the browser');
    assert.equal(inserted[0]!.values[4], 'owner@example.com', 'the ceremony records WHO is linking');
  });

  it('answers the friendly 503 when Google is off', async () => {
    const { impl } = run402Fake();
    const { pool } = fakePool();
    const r = await handleGoogleLink(
      baseCtx(pool, impl, { methods: async () => ({ google: false }) }),
      { email: 'owner@example.com', sessionId: 'sess-1' },
    );
    assert.equal(r.status, 503);
  });
});

describe('the LINK ceremony must return somewhere that can SHOW the outcome (AC-248)', () => {
  // Barry, walk 5: connecting an identity already linked to another account was
  // correctly REFUSED by the platform, and he was shown nothing at all — he had
  // to inspect Sign-in methods to guess what happened, and initially concluded
  // he HAD connected it. The link round trip returned to /dashboard, where a
  // signed-in visitor renders the dashboard and the result-reading code (which
  // lives on the sign-in screen) never runs. A link ceremony is always started
  // by a signed-in user, so /dashboard can never report it: it must come back to
  // the page the visitor started from.
  it('starts the link ceremony with the Sign-in methods page as its return, not the dashboard', async () => {
    const { impl, calls } = run402Fake();
    const { pool } = fakePool();
    await handleGoogleLink(baseCtx(pool, impl), { email: 'owner@example.com', sessionId: 'sess-1' });
    const start = calls.find((c) => c.url.includes('/auth/v1/oauth/google/start'))!;
    assert.equal(start.body.redirect_url, 'https://kysigned.com/account/passkeys');
  });

  it('an ordinary sign-in ceremony still returns to the SPA-served dashboard landing (GH#20)', async () => {
    const { impl, calls } = run402Fake();
    const { pool } = fakePool();
    await handleGoogleStart(baseCtx(pool, impl), {});
    const start = calls.find((c) => c.url.includes('/auth/v1/oauth/google/start'))!;
    assert.equal(start.body.redirect_url, 'https://kysigned.com/dashboard');
  });
});

describe('handleGoogleDisconnect (F-41.8 / AC-254) — reverse the link, server-side', () => {
  /** run402 fake for the identity routes: list → unlink, with a freshness gate. */
  function identityFake(opts: { fresh?: boolean; identities?: unknown[] } = {}) {
    const calls: UpstreamCall[] = [];
    const impl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      calls.push({ url, body, headers: init?.headers ?? {} });
      if (url.includes('/auth/v1/account/identities/unlink')) {
        // The platform refuses unless the actor authenticated recently, and a
        // refreshed token keeps the ORIGINAL auth_time — so this is the normal
        // answer for a long-lived session, not an edge case.
        if (!opts.fresh) {
          return {
            status: 401,
            ok: false,
            json: async () => ({
              error: 'Re-authentication required to unlink an identity.',
              code: 'R402_AUTH_FRESHNESS_REQUIRED',
              details: { max_age: '5m' },
            }),
          };
        }
        return { status: 200, ok: true, json: async () => ({ ok: true, unlinked: true }) };
      }
      if (url.includes('/auth/v1/account/identities')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            identities: opts.identities ?? [
              { provider: 'google', provider_sub: 'g-sub-123', provider_email: 'owner@gmail.com' },
            ],
          }),
        };
      }
      return { status: 404, ok: false, json: async () => ({}) };
    };
    return { impl, calls };
  }

  const ACTOR = { email: 'owner@example.com', sessionId: 'sess-1' };

  it('finds the google identity and unlinks it by its provider_sub, with the session Bearer', async () => {
    const { impl, calls } = identityFake({ fresh: true });
    const { pool } = fakePool();
    const r = await handleGoogleDisconnect(baseCtx(pool, impl), ACTOR);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, disconnected: true });
    const unlink = calls.find((c) => c.url.includes('/identities/unlink'))!;
    assert.equal(unlink.body.provider, 'google');
    assert.equal(unlink.body.subject, 'g-sub-123', 'subject is the provider_sub, not the user id');
    assert.equal(unlink.headers['Authorization'], 'Bearer at-owner', 'the server-held token, never the browser');
    assert.equal(unlink.headers['apikey'], 'anon');
  });

  it('maps the platform freshness refusal to a re-auth instruction, NOT an error', async () => {
    const { impl } = identityFake({ fresh: false });
    const { pool } = fakePool();
    const r = await handleGoogleDisconnect(baseCtx(pool, impl), ACTOR);
    assert.equal(r.status, 401);
    assert.equal((r.body as { code?: string }).code, 'auth_reauth_required');
    const text = JSON.stringify(r.body);
    assert.ok(!/R402_|401|run402/.test(text), 'no platform code or vendor string reaches the creator');
  });

  it('an account with no google identity answers cleanly instead of calling unlink', async () => {
    const { impl, calls } = identityFake({ fresh: true, identities: [] });
    const { pool } = fakePool();
    const r = await handleGoogleDisconnect(baseCtx(pool, impl), ACTOR);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, disconnected: false });
    assert.equal(calls.filter((c) => c.url.includes('/identities/unlink')).length, 0);
  });

  it('refuses when the session carries no platform token', async () => {
    const { impl } = identityFake({ fresh: true });
    const pool: DbPool = { async query() { return { rows: [], rowCount: 0 } as never; }, async end() {} };
    const r = await handleGoogleDisconnect(baseCtx(pool, impl), ACTOR);
    assert.equal(r.status, 401);
  });
});
