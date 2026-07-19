/**
 * authHandlers.test.ts — magic-link cookie-session auth endpoints (F-18.1).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DbPool } from '../../db/pool.js';
import {
  handleAuthMagicLink,
  handleAuthTokenExchange,
  handleAuthUser,
  handleAuthSignout,
  type AuthHandlerCtx,
} from './authHandlers.js';
import { SESSION_COOKIE } from './session.js';
import { emitAppEvent as seamEmitAppEvent } from '../../integrations/appEvents.js';

function fakePool(creatorName: string | null = null) {
  const sessions = new Map<string, true>();
  let lastDelete: string | undefined;
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as unknown[];
      if (text.includes('INSERT INTO auth_sessions')) { sessions.set(v[0] as string, true); return { rows: [], rowCount: 0 } as never; }
      if (text.includes('DELETE FROM auth_sessions')) { lastDelete = v[0] as string; sessions.delete(v[0] as string); return { rows: [], rowCount: 1 } as never; }
      if (text.includes('creator_profiles')) { return { rows: creatorName ? [{ display_name: creatorName }] : [], rowCount: creatorName ? 1 : 0 } as never; }
      return { rows: [], rowCount: 0 } as never;
    },
    async end() {},
  };
  return { pool, sessions, getLastDelete: () => lastDelete };
}

type FImpl = AuthHandlerCtx['session']['fetchImpl'];
function fetchImpl(tokenResp: { status: number; body: unknown }): FImpl {
  return async (url: string) => {
    if (url.includes('/auth/v1/magic-link')) return { status: 200, ok: true, json: async () => ({}) };
    if (url.includes('/auth/v1/token')) return { status: tokenResp.status, ok: tokenResp.status < 300, json: async () => tokenResp.body };
    return { status: 404, ok: false, json: async () => ({}) };
  };
}

function ctx(pool: DbPool, fImpl?: FImpl): AuthHandlerCtx {
  return { pool, appBaseUrl: 'https://kysigned.com', session: { projectAnonKey: 'anon', secure: true, fetchImpl: fImpl } };
}

describe('handleAuthMagicLink', () => {
  it('rejects an invalid email (400)', async () => {
    assert.equal((await handleAuthMagicLink(ctx(fakePool().pool), { email: 'nope' })).status, 400);
  });
  it('always returns 200 for a valid email (anti-enumeration)', async () => {
    const r = await handleAuthMagicLink(ctx(fakePool().pool, fetchImpl({ status: 200, body: {} })), { email: 'Alice@Example.com' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  });
});

describe('handleAuthTokenExchange', () => {
  it('exchanges a valid token → 200 + a session cookie', async () => {
    const { pool, sessions } = fakePool();
    const r = await handleAuthTokenExchange(
      ctx(pool, fetchImpl({ status: 200, body: { access_token: 'at', refresh_token: 'rt', user: { email: 'Alice@x.com' } } })),
      { token: 'magic' },
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, email: 'alice@x.com' });
    assert.equal(sessions.size, 1);
    assert.ok(r.setCookies?.[0]?.includes(SESSION_COOKIE));
  });
  it('rejects a missing token (400) and a failed exchange (401)', async () => {
    assert.equal((await handleAuthTokenExchange(ctx(fakePool().pool), {})).status, 400);
    const r = await handleAuthTokenExchange(ctx(fakePool().pool, fetchImpl({ status: 401, body: { error: 'bad' } })), { token: 'x' });
    assert.equal(r.status, 401);
  });
});

describe('handleAuthTokenExchange — new-account trial credit (F-13.4 / F-18.4)', () => {
  const okExchange = fetchImpl({ status: 200, body: { access_token: 'at', refresh_token: 'rt', user: { email: 'New.User@x.com' } } });

  // A pool that captures the credit_ledger CTE write (the grant) + handles the session insert.
  function grantCapturePool(opts: { throwOnCredit?: boolean } = {}) {
    const credited: Array<{ email: string; delta: string; source: string; external_ref: string }> = [];
    const pool: DbPool = {
      async query(text: string, values?: unknown[]) {
        const v = (values ?? []) as unknown[];
        if (text.includes('INSERT INTO auth_sessions')) return { rows: [], rowCount: 0 } as never;
        if (/WITH new_ledger AS[\s\S]*INSERT INTO credit_ledger/.test(text)) {
          if (opts.throwOnCredit) throw new Error('db down');
          const [email, delta, source, externalRef] = v as [string, string, string, string];
          credited.push({ email, delta, source, external_ref: externalRef });
          return { rows: [{ balance_usd_micros: delta }], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 0 } as never;
      },
      async end() {},
    };
    return { pool, credited };
  }

  it('grants the trial credit on a successful sign-in when configured (amount + normalized-inbox dedupe key)', async () => {
    const { pool, credited } = grantCapturePool();
    const c: AuthHandlerCtx = { pool, appBaseUrl: 'https://kysigned.com', session: { projectAnonKey: 'anon', secure: true, fetchImpl: okExchange }, signupGrantUsdMicros: 1_000_000n };
    const r = await handleAuthTokenExchange(c, { token: 'magic' });
    assert.equal(r.status, 200);
    assert.equal(credited.length, 1, 'one signup_grant credit write');
    assert.equal(credited[0]!.source, 'signup_grant');
    assert.equal(credited[0]!.delta, '1000000');
    assert.equal(credited[0]!.external_ref, 'new.user@x.com', 'external_ref is the normalized inbox');
  });

  it('does NOT grant when unconfigured (forker default → no credit write)', async () => {
    const { pool, credited } = grantCapturePool();
    const r = await handleAuthTokenExchange(ctx(pool, okExchange), { token: 'magic' });
    assert.equal(r.status, 200);
    assert.equal(credited.length, 0, 'no grant when signupGrantUsdMicros unset');
  });

  it('a grant failure never breaks sign-in (best-effort)', async () => {
    const { pool } = grantCapturePool({ throwOnCredit: true });
    const c: AuthHandlerCtx = { pool, appBaseUrl: 'https://kysigned.com', session: { projectAnonKey: 'anon', secure: true, fetchImpl: okExchange }, signupGrantUsdMicros: 1_000_000n };
    const r = await handleAuthTokenExchange(c, { token: 'magic' });
    assert.equal(r.status, 200, 'sign-in still succeeds despite a grant failure');
    assert.deepEqual(r.body, { ok: true, email: 'new.user@x.com' });
  });

  // ── F-36.4 / AC-198 — creator_signed_up (61.1) ──────────────────────────────
  function eventsRecorder() {
    const events: Array<{ type: string; ids: readonly string[]; payload: Record<string, unknown> }> = [];
    return {
      events,
      emitAppEvent: (async (type: string, ids: readonly string[], payload: Record<string, unknown>) => {
        events.push({ type, ids, payload });
      }) as never,
    };
  }

  // Fresh-claim pool: the CTE returns the new ledger row (id + balance).
  function freshGrantPool() {
    const pool: DbPool = {
      async query(text: string) {
        if (text.includes('INSERT INTO auth_sessions')) return { rows: [], rowCount: 0 } as never;
        if (/WITH new_ledger AS[\s\S]*INSERT INTO credit_ledger/.test(text)) {
          return { rows: [{ balance_usd_micros: '1000000', ledger_id: 'cl-42' }], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 0 } as never;
      },
      async end() {},
    };
    return pool;
  }

  it('F-36.4: a fresh grant claim emits exactly one creator_signed_up keyed by the ledger row id — no address anywhere', async () => {
    const e = eventsRecorder();
    const c: AuthHandlerCtx = {
      pool: freshGrantPool(),
      appBaseUrl: 'https://kysigned.com',
      session: { projectAnonKey: 'anon', secure: true, fetchImpl: okExchange },
      signupGrantUsdMicros: 1_000_000n,
      emitAppEvent: e.emitAppEvent,
    };
    const r = await handleAuthTokenExchange(c, { token: 'magic' });
    assert.equal(r.status, 200);
    assert.deepEqual(e.events, [
      {
        type: 'creator_signed_up',
        ids: ['cl-42'],
        payload: { grant_usd_micros: 1_000_000, source: 'magic_link' },
      },
    ]);
  });

  it('F-36.4: already-granted, disabled, and disposable-domain sign-ins emit nothing', async () => {
    // already_granted: the CTE conflicts → 0 rows.
    const e1 = eventsRecorder();
    const dedupPool: DbPool = {
      async query(text: string) {
        if (text.includes('INSERT INTO auth_sessions')) return { rows: [], rowCount: 0 } as never;
        if (/WITH new_ledger AS[\s\S]*INSERT INTO credit_ledger/.test(text)) return { rows: [], rowCount: 0 } as never;
        return { rows: [], rowCount: 0 } as never;
      },
      async end() {},
    };
    const dedupCtx: AuthHandlerCtx = {
      pool: dedupPool,
      appBaseUrl: 'https://kysigned.com',
      session: { projectAnonKey: 'anon', secure: true, fetchImpl: okExchange },
      signupGrantUsdMicros: 1_000_000n,
      emitAppEvent: e1.emitAppEvent,
    };
    assert.equal((await handleAuthTokenExchange(dedupCtx, { token: 'magic' })).status, 200);
    assert.equal(e1.events.length, 0, 'already_granted emits nothing');

    // disabled: no grant config.
    const e2 = eventsRecorder();
    const disabledCtx: AuthHandlerCtx = {
      pool: freshGrantPool(),
      appBaseUrl: 'https://kysigned.com',
      session: { projectAnonKey: 'anon', secure: true, fetchImpl: okExchange },
      emitAppEvent: e2.emitAppEvent,
    };
    assert.equal((await handleAuthTokenExchange(disabledCtx, { token: 'magic' })).status, 200);
    assert.equal(e2.events.length, 0, 'disabled grant emits nothing');

    // disposable domain: grant refused before any DB write.
    const e3 = eventsRecorder();
    const dispExchange = fetchImpl({ status: 200, body: { access_token: 'at', refresh_token: 'rt', user: { email: 'burner@mailinator.com' } } });
    const dispCtx: AuthHandlerCtx = {
      pool: freshGrantPool(),
      appBaseUrl: 'https://kysigned.com',
      session: { projectAnonKey: 'anon', secure: true, fetchImpl: dispExchange },
      signupGrantUsdMicros: 1_000_000n,
      emitAppEvent: e3.emitAppEvent,
    };
    assert.equal((await handleAuthTokenExchange(dispCtx, { token: 'magic' })).status, 200);
    assert.equal(e3.events.length, 0, 'disposable-domain refusal emits nothing');
  });

  it('F-36.4/AC-196 discipline: a failing events surface never breaks the sign-in (real seam)', async () => {
    const logs: string[] = [];
    const failingSeam = (async (type: never, ids: readonly string[], payload: never) =>
      seamEmitAppEvent(
        {
          emitRuntimeEvent: async () => {
            throw Object.assign(new Error('quota'), { code: 'QUOTA_EXCEEDED', status: 403 });
          },
          log: (m: string) => void logs.push(m),
        },
        type,
        ids,
        payload,
      )) as never;
    const c: AuthHandlerCtx = {
      pool: freshGrantPool(),
      appBaseUrl: 'https://kysigned.com',
      session: { projectAnonKey: 'anon', secure: true, fetchImpl: okExchange },
      signupGrantUsdMicros: 1_000_000n,
      emitAppEvent: failingSeam,
    };
    const r = await handleAuthTokenExchange(c, { token: 'magic' });
    assert.equal(r.status, 200, 'sign-in is never gated by an emit failure');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /creator_signed_up/);
  });
});

// ── F-37 / AC-206 — attribution rider + bind-at-establishment (65.3) ─────────
describe('attribution — magic-link rider persists a pending capture', () => {
  const okSend = fetchImpl({ status: 200, body: {} });
  const FRESH_AT = '2026-07-18T09:30:00.000Z';

  function attributionPool() {
    const inserts: unknown[][] = [];
    const pool: DbPool = {
      async query(text: string, values?: unknown[]) {
        if (text.includes('INSERT INTO attribution_captures')) {
          inserts.push((values ?? []) as unknown[]);
          return { rows: [], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 0 } as never;
      },
      async end() {},
    };
    return { pool, inserts };
  }

  it('with the server flag ON, a valid rider is persisted keyed by the normalized inbox (still 200)', async () => {
    const { pool, inserts } = attributionPool();
    const c: AuthHandlerCtx = { ...ctx(pool, okSend), attributionEnabled: true };
    const r = await handleAuthMagicLink(c, {
      email: 'Alice.Smith+promo@GoogleMail.com',
      attribution: { gclid: 'Cj0Kride', captured_at: FRESH_AT, consent: 'granted' },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(inserts.length, 1, 'one pending-capture write');
    assert.equal(inserts[0]![0], 'alicesmith@gmail.com');
    assert.equal(inserts[0]![1], 'Cj0Kride');
  });

  it('with the flag OFF (fresh-fork default), the same rider writes NOTHING', async () => {
    const { pool, inserts } = attributionPool();
    const r = await handleAuthMagicLink(ctx(pool, okSend), {
      email: 'a@x.com',
      attribution: { gclid: 'Cj0Kride', captured_at: FRESH_AT, consent: null },
    });
    assert.equal(r.status, 200);
    assert.equal(inserts.length, 0);
  });

  it('a malformed rider is silently dropped — the anti-enumeration 200 contract holds', async () => {
    const { pool, inserts } = attributionPool();
    const c: AuthHandlerCtx = { ...ctx(pool, okSend), attributionEnabled: true };
    const r = await handleAuthMagicLink(c, { email: 'a@x.com', attribution: { gclid: 'bad space' } });
    assert.equal(r.status, 200);
    assert.equal(inserts.length, 0);
  });

  it('a capture-write failure never breaks the magic-link send (best-effort)', async () => {
    const pool: DbPool = {
      async query(text: string) {
        if (text.includes('INSERT INTO attribution_captures')) throw new Error('db down');
        return { rows: [], rowCount: 0 } as never;
      },
      async end() {},
    };
    const c: AuthHandlerCtx = { ...ctx(pool, okSend), attributionEnabled: true };
    const r = await handleAuthMagicLink(c, {
      email: 'a@x.com',
      attribution: { gclid: 'Cj0Kride', captured_at: FRESH_AT, consent: null },
    });
    assert.equal(r.status, 200);
  });
});

describe('attribution — token exchange binds at establishment', () => {
  const okExchange2 = fetchImpl({ status: 200, body: { access_token: 'at', refresh_token: 'rt', user: { email: 'Bind.Me@x.com' } } });

  function bindObserverPool(opts: { throwOnBind?: boolean } = {}) {
    const stamps: unknown[][] = [];
    const pool: DbPool = {
      async query(text: string, values?: unknown[]) {
        if (text.includes('INSERT INTO auth_sessions')) return { rows: [], rowCount: 0 } as never;
        if (text.includes('SELECT') && text.includes('FROM attribution_captures')) {
          if (opts.throwOnBind) throw new Error('db down');
          return { rows: [{ gclid: 'Cj0Kbind', captured_at: '2026-07-18T09:30:00.000Z', consent_state: null }], rowCount: 1 } as never;
        }
        if (text.includes('INSERT INTO creator_attribution')) {
          stamps.push((values ?? []) as unknown[]);
          return { rows: [], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 0 } as never;
      },
      async end() {},
    };
    return { pool, stamps };
  }

  it('with the flag ON, a confirmed sign-in stamps the establishment with the pending gclid', async () => {
    const { pool, stamps } = bindObserverPool();
    const c: AuthHandlerCtx = { ...ctx(pool, okExchange2), attributionEnabled: true };
    const r = await handleAuthTokenExchange(c, { token: 'magic' });
    assert.equal(r.status, 200);
    assert.equal(stamps.length, 1, 'establishment stamped');
    assert.equal(stamps[0]![0], 'bind.me@x.com');
    assert.equal(stamps[0]![1], 'Cj0Kbind');
  });

  it('with the flag OFF, no attribution query runs at all', async () => {
    const { pool, stamps } = bindObserverPool();
    const r = await handleAuthTokenExchange(ctx(pool, okExchange2), { token: 'magic' });
    assert.equal(r.status, 200);
    assert.equal(stamps.length, 0);
  });

  it('a bind failure never breaks sign-in (best-effort)', async () => {
    const { pool } = bindObserverPool({ throwOnBind: true });
    const c: AuthHandlerCtx = { ...ctx(pool, okExchange2), attributionEnabled: true };
    const r = await handleAuthTokenExchange(c, { token: 'magic' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, email: 'bind.me@x.com' });
  });
});

describe('handleAuthUser', () => {
  it('returns the actor email + saved display name', async () => {
    const r = await handleAuthUser(ctx(fakePool('Alice Smith').pool), { email: 'alice@x.com', sessionId: 's' });
    assert.deepEqual(r.body, { email: 'alice@x.com', display_name: 'Alice Smith' });
  });
  it('omits display_name when none saved', async () => {
    const r = await handleAuthUser(ctx(fakePool(null).pool), { email: 'a@x.com', sessionId: 's' });
    assert.deepEqual(r.body, { email: 'a@x.com', display_name: undefined });
  });
});

describe('handleAuthSignout', () => {
  it('deletes the session + clears the cookie', async () => {
    const { pool, getLastDelete } = fakePool();
    const r = await handleAuthSignout(ctx(pool), { email: 'a@x.com', sessionId: 'sess-9' });
    assert.equal(r.status, 200);
    assert.equal(getLastDelete(), 'sess-9');
    assert.match(r.setCookies![0]!, /Max-Age=0/);
  });
});
