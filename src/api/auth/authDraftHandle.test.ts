/**
 * authDraftHandle.test.ts — F-40 / DD-57: the pending-send handle crosses the
 * email round trip on TWO rails, because only one of them survives a failure.
 *
 * `client_state` is run402's own carry-context field (≤2048 bytes, returned as
 * `magic_link.client_state` on a verified exchange) and is the better SUCCESS
 * channel: server-bound to the token, never in a URL. But an expired or already
 * used token verifies to nothing, so a FAILED exchange returns no client_state at
 * all — and AC-240 needs the handle exactly then, to put the visitor back in
 * front of their own filled-in document. So the handle also rides the redirect
 * URL, which survives any outcome.
 *
 * Platform contract this rests on (read at run402-private@414cc643):
 * `routes/auth.ts:1204` builds the link as
 * `redirect_url + (redirect_url.includes("?") ? "&" : "?") + token=…`, so our own
 * query survives; `auth.ts:1169` accepts client_state; `auth.ts:863` returns it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DbPool } from '../../db/pool.js';
import { handleAuthMagicLink, handleAuthTokenExchange, type AuthHandlerCtx } from './authHandlers.js';

function pool(): DbPool {
  return {
    async query() {
      return { rows: [], rowCount: 0 } as never;
    },
    async end() {},
  };
}

type FImpl = AuthHandlerCtx['session']['fetchImpl'];

function recordingFetch(tokenBody: unknown, tokenStatus = 200) {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const impl: FImpl = async (url: string, init?: { body?: string }) => {
    sent.push({ url, body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} });
    if (url.includes('/auth/v1/magic-link')) return { status: 200, ok: true, json: async () => ({}) };
    return { status: tokenStatus, ok: tokenStatus < 300, json: async () => tokenBody };
  };
  return { impl, sent };
}

function ctx(fImpl: FImpl): AuthHandlerCtx {
  return { pool: pool(), appBaseUrl: 'https://kysigned.com', session: { projectAnonKey: 'anon', secure: true, fetchImpl: fImpl } };
}

const OK_EXCHANGE = {
  access_token: 'at',
  refresh_token: 'rt',
  user: { email: 'Creator@Example.com' },
  magic_link: { intent: 'signin', client_state: '{"draft_id":"ps_3f2a9c14-8b7e-4d1a-9f60-5c2e7a1b8d34.the-secret-half-abcdef"}', state_source: 'anonymous', state_trusted: false },
};

describe('the magic-link request carries the handle both ways (DD-57)', () => {
  it('puts the handle in the redirect URL AND in client_state', async () => {
    const { impl, sent } = recordingFetch({});
    await handleAuthMagicLink(ctx(impl), { email: 'creator@example.com', draft_id: 'ps_3f2a9c14-8b7e-4d1a-9f60-5c2e7a1b8d34.the-secret-half-abcdef' });
    const req = sent.find((s) => s.url.includes('/auth/v1/magic-link'))!;
    assert.equal(
      req.body.redirect_url,
      'https://kysigned.com/dashboard?draft=ps_3f2a9c14-8b7e-4d1a-9f60-5c2e7a1b8d34.the-secret-half-abcdef',
      'the query copy is what survives a FAILED exchange',
    );
    assert.equal(
      req.body.client_state,
      JSON.stringify({ draft_id: 'ps_3f2a9c14-8b7e-4d1a-9f60-5c2e7a1b8d34.the-secret-half-abcdef' }),
      'the bound copy is what a SUCCESSFUL exchange returns',
    );
  });

  it('leaves the link byte-identical when there is no draft (a plain sign-in)', async () => {
    const { impl, sent } = recordingFetch({});
    await handleAuthMagicLink(ctx(impl), { email: 'creator@example.com' });
    const req = sent.find((s) => s.url.includes('/auth/v1/magic-link'))!;
    assert.equal(req.body.redirect_url, 'https://kysigned.com/dashboard');
    assert.equal(req.body.client_state, undefined, 'no empty state field on an ordinary sign-in');
  });

  it('ignores a malformed handle rather than building a broken link', async () => {
    const { impl, sent } = recordingFetch({});
    await handleAuthMagicLink(ctx(impl), { email: 'creator@example.com', draft_id: 'not a handle!' });
    const req = sent.find((s) => s.url.includes('/auth/v1/magic-link'))!;
    assert.equal(req.body.redirect_url, 'https://kysigned.com/dashboard');
    assert.equal(req.body.client_state, undefined);
  });

  it('still answers 200 (anti-enumeration) whatever the handle was', async () => {
    const { impl } = recordingFetch({});
    const r = await handleAuthMagicLink(ctx(impl), { email: 'creator@example.com', draft_id: 'ps_3f2a9c14-8b7e-4d1a-9f60-5c2e7a1b8d34.the-secret-half-abcdef' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  });
});

describe('the token exchange hands the handle back (DD-57)', () => {
  it('surfaces the draft handle from client_state on success', async () => {
    const { impl } = recordingFetch(OK_EXCHANGE);
    const r = await handleAuthTokenExchange(ctx(impl), { token: 'tok' });
    assert.equal(r.status, 200);
    assert.equal((r.body as { draft_id?: string }).draft_id, 'ps_3f2a9c14-8b7e-4d1a-9f60-5c2e7a1b8d34.the-secret-half-abcdef');
    assert.equal((r.body as { email: string }).email, 'creator@example.com');
  });

  it('omits the handle when the link carried none', async () => {
    const { impl } = recordingFetch({ access_token: 'at', refresh_token: 'rt', user: { email: 'a@b.com' } });
    const r = await handleAuthTokenExchange(ctx(impl), { token: 'tok' });
    assert.equal((r.body as { draft_id?: string }).draft_id, undefined);
  });

  it('never lets a malformed client_state break sign-in', async () => {
    const { impl } = recordingFetch({
      ...OK_EXCHANGE,
      magic_link: { client_state: 'this is not json' },
    });
    const r = await handleAuthTokenExchange(ctx(impl), { token: 'tok' });
    assert.equal(r.status, 200, 'the session is the point; the handle is a convenience');
    assert.equal((r.body as { draft_id?: string }).draft_id, undefined);
  });

  it('a FAILED exchange returns no handle at all — which is why the URL copy exists', async () => {
    const { impl } = recordingFetch({ error: 'Invalid, expired, or already used magic link token' }, 401);
    const r = await handleAuthTokenExchange(ctx(impl), { token: 'stale' });
    assert.equal(r.status, 401);
    assert.equal((r.body as { draft_id?: string }).draft_id, undefined);
  });
});

// ── F-027 (red team cycle 22, P1) ───────────────────────────────────────────
// The platform caps sign-in emails at 5 per address per hour
// (run402-private@414cc643 `services/magic-link.ts` PER_EMAIL_LIMIT) and refuses
// with a 429. This handler swallowed that whole and still answered a bare
// `{ok:true}`, so the visitor got a "check your email" state for an email that
// was never sent — which is exactly what the red team observed as "unreliable
// delivery" after hammering two test addresses.
describe('a refused send says so (F-027)', () => {
  it('marks a 429 as throttled, while still answering 200 (anti-enumeration)', async () => {
    const impl: FImpl = async (url: string) =>
      url.includes('/auth/v1/magic-link')
        ? { status: 429, ok: false, json: async () => ({ error: 'Too many magic link requests' }) }
        : { status: 404, ok: false, json: async () => ({}) };
    const r = await handleAuthMagicLink(ctx(impl), { email: 'creator@example.com' });
    assert.equal(r.status, 200, 'still 200 — account existence is never revealed');
    assert.equal((r.body as { throttled?: boolean }).throttled, true);
  });

  it('does NOT mark an ordinary success', async () => {
    const { impl } = recordingFetch({});
    const r = await handleAuthMagicLink(ctx(impl), { email: 'creator@example.com' });
    assert.deepEqual(r.body, { ok: true }, 'the happy path shape is byte-identical');
  });

  it('does not mark OTHER upstream failures — only the refusal we can explain', async () => {
    const impl: FImpl = async (url: string) =>
      url.includes('/auth/v1/magic-link')
        ? { status: 503, ok: false, json: async () => ({ error: 'upstream down' }) }
        : { status: 404, ok: false, json: async () => ({}) };
    const r = await handleAuthMagicLink(ctx(impl), { email: 'creator@example.com' });
    assert.equal((r.body as { throttled?: boolean }).throttled, undefined);
  });
});
