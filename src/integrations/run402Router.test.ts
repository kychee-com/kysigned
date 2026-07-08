/**
 * run402Router.test.ts — the run402-function route table + matcher (14.5).
 *
 * Pure path/method → {name, auth, params} matching for the routed-HTTP entry.
 * The route inventory mirrors what the SPA + handlers use (singular /v1/envelope,
 * /v1/documents, /v1/credits/*, /v1/auth/*, signer-token /v1/sign + /v1/envelope/
 * :id/:token/pdf). The entry uses `auth` to pick the gate (session cookie /
 * signer-token / webhook / public) before dispatching to the api handler.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute, API_ROUTES } from './run402Router.js';

describe('matchRoute', () => {
  it('matches an exact public route', () => {
    const m = matchRoute('GET', '/v1/health');
    assert.equal(m?.name, 'health');
    assert.equal(m?.auth, 'public');
    assert.deepEqual(m?.params, {});
  });

  it('extracts a single :id param (session create/get)', () => {
    assert.equal(matchRoute('POST', '/v1/envelope')?.name, 'createEnvelope');
    const get = matchRoute('GET', '/v1/envelope/abc-123');
    assert.equal(get?.name, 'getEnvelope');
    assert.equal(get?.auth, 'session');
    assert.equal(get?.params.id, 'abc-123');
  });

  it('distinguishes the literal sub-routes of /v1/envelope/:id (remind/void/pdf); export removed', () => {
    assert.equal(matchRoute('POST', '/v1/envelope/e1/remind')?.name, 'remindEnvelope');
    assert.equal(matchRoute('POST', '/v1/envelope/e1/void')?.name, 'voidEnvelope');
    assert.equal(matchRoute('GET', '/v1/envelope/e1/pdf')?.name, 'ownerPdf'); // session owner PDF
    assert.equal(matchRoute('GET', '/v1/envelope/e1/export'), null); // export dropped (never in the spec)
  });

  it('matches the signer-token routes (public, 2 params)', () => {
    const info = matchRoute('GET', '/v1/sign/e1/tok9/info');
    assert.equal(info?.name, 'signInfo');
    assert.equal(info?.auth, 'signer-token');
    assert.deepEqual(info?.params, { id: 'e1', token: 'tok9' });

    const pdf = matchRoute('GET', '/v1/envelope/e1/tok9/pdf'); // 5 segments — signer PDF, NOT the owner PDF
    assert.equal(pdf?.name, 'signerPdf');
    assert.equal(pdf?.auth, 'signer-token');
    assert.deepEqual(pdf?.params, { id: 'e1', token: 'tok9' });
  });

  it('has NO inbound webhook route (F-29.6 email trigger); billing routes are NOT public', () => {
    // F-29.6 — inbound MAILBOX email is a run402 email-trigger durable run, not a
    // route the app catches. So there is no `/v1/webhooks/inbound` route anymore.
    assert.equal(matchRoute('POST', '/v1/webhooks/inbound'), null);
    // No service-to-user payment in the forker app: Stripe + credits are
    // kysigned.com-proprietary (the operator's private billing function), not here.
    assert.equal(matchRoute('POST', '/v1/webhooks/stripe'), null);
    assert.equal(matchRoute('GET', '/v1/credits/balance'), null);
    assert.equal(matchRoute('POST', '/v1/credits/checkout'), null);
  });

  it('routes the F-28 test-account reset (public; the secret gate lives in the handler)', () => {
    const m = matchRoute('POST', '/v1/test/reset-user');
    assert.equal(m?.name, 'testResetUser');
    assert.equal(m?.auth, 'public');
  });

  it('routes auth: pre-session is public, user/signout is session', () => {
    assert.equal(matchRoute('POST', '/v1/auth/magic-link')?.auth, 'public');
    assert.equal(matchRoute('POST', '/v1/auth/token')?.auth, 'public');
    assert.equal(matchRoute('GET', '/v1/auth/user')?.auth, 'session');
    assert.equal(matchRoute('POST', '/v1/auth/signout')?.auth, 'session');
  });

  it('routes passkeys: login/* is public, register/list/delete are session', () => {
    // login ceremony IS the auth → public; verify issues the session cookie.
    assert.equal(matchRoute('POST', '/v1/auth/passkeys/login/options')?.name, 'passkeyLoginOptions');
    assert.equal(matchRoute('POST', '/v1/auth/passkeys/login/options')?.auth, 'public');
    assert.equal(matchRoute('POST', '/v1/auth/passkeys/login/verify')?.auth, 'public');
    // management requires a session (the run402 token is the upstream Bearer).
    assert.equal(matchRoute('POST', '/v1/auth/passkeys/register/options')?.auth, 'session');
    assert.equal(matchRoute('POST', '/v1/auth/passkeys/register/verify')?.auth, 'session');
    assert.equal(matchRoute('GET', '/v1/auth/passkeys')?.auth, 'session');
    const del = matchRoute('DELETE', '/v1/auth/passkeys/pk-1');
    assert.equal(del?.name, 'passkeyDelete');
    assert.equal(del?.auth, 'session');
    assert.equal(del?.params.id, 'pk-1');
    // the 4-segment list route is NOT shadowed by user/ and does not capture :id
    assert.equal(matchRoute('GET', '/v1/auth/user')?.name, 'authUser');
  });

  it('normalizes a trailing slash and matches HEAD against GET', () => {
    assert.equal(matchRoute('GET', '/v1/health/')?.name, 'health');
    assert.equal(matchRoute('HEAD', '/v1/health')?.name, 'health');
  });

  it('returns null on method mismatch and unknown paths', () => {
    assert.equal(matchRoute('DELETE', '/v1/health'), null);
    assert.equal(matchRoute('GET', '/v1/nope'), null);
    assert.equal(matchRoute('GET', '/v1/envelope/e1/unknown'), null);
  });

  it('does NOT route a server-side public verify — verification is client-side only', () => {
    // The SPA's static /verify page runs verifyBundleWeb over the PDF the user
    // holds; there is no server-side per-envelope verify handler to dispatch to,
    // so the route is intentionally absent (omitted, never stubbed).
    assert.equal(matchRoute('GET', '/v1/verify/e1'), null);
  });

  it('routes the public key-archive lookup proxy (F-10.8) — the one verify-support route', () => {
    const m = matchRoute('GET', '/v1/key-archive');
    assert.equal(m?.name, 'keyArchive');
    assert.equal(m?.auth, 'public'); // public: it forwards a public DNS lookup
    assert.deepEqual(m?.params, {});
  });

  it('routes the recipient-editing + seal sub-routes (F-23/F-24, session)', () => {
    // add = POST /signers, edit = PATCH /signers, delete = DELETE /signers
    // (same path, method-distinguished); seal = POST /seal. The signer email for
    // edit/delete rides in ?email=, so the path only carries :id.
    const add = matchRoute('POST', '/v1/envelope/e1/signers');
    assert.equal(add?.name, 'addSigner');
    assert.equal(add?.auth, 'session');
    assert.equal(add?.params.id, 'e1');
    assert.equal(matchRoute('PATCH', '/v1/envelope/e1/signers')?.name, 'editSigner');
    assert.equal(matchRoute('DELETE', '/v1/envelope/e1/signers')?.name, 'deleteSigner');
    assert.equal(matchRoute('PATCH', '/v1/envelope/e1/signers')?.auth, 'session');
    const seal = matchRoute('POST', '/v1/envelope/e1/seal');
    assert.equal(seal?.name, 'sealEnvelope');
    assert.equal(seal?.auth, 'session');
    assert.equal(seal?.params.id, 'e1');
  });

  it('routes GET /v1/envelopes — list the creator\'s envelopes (session), distinct from singular /v1/envelope', () => {
    const m = matchRoute('GET', '/v1/envelopes');
    assert.equal(m?.name, 'listEnvelopes');
    assert.equal(m?.auth, 'session');
    assert.deepEqual(m?.params, {});
    // not shadowed by the singular create/get routes
    assert.equal(matchRoute('POST', '/v1/envelope')?.name, 'createEnvelope');
    assert.equal(matchRoute('GET', '/v1/envelope/e1')?.name, 'getEnvelope');
  });

  it('every route has a name + a valid auth mode', () => {
    const modes = new Set(['public', 'session', 'signer-token', 'webhook-stripe']);
    for (const r of API_ROUTES) {
      assert.ok(r.name && r.pattern && r.method, `route incomplete: ${JSON.stringify(r)}`);
      assert.ok(modes.has(r.auth), `bad auth mode: ${r.auth}`);
    }
  });
});

describe('matchRoute — F-30.2 x402 create route (spec 0.39.0)', () => {
  it('maps POST /v1/x402/envelope to x402CreateEnvelope as a PUBLIC route (payment is the authorization)', () => {
    const m = matchRoute('POST', '/v1/x402/envelope');
    assert.equal(m?.name, 'x402CreateEnvelope');
    assert.equal(m?.auth, 'public');
  });
  it('only POST exists on the x402 path — no sibling actions ride the paid route', () => {
    assert.equal(matchRoute('GET', '/v1/x402/envelope'), null);
    assert.equal(matchRoute('DELETE', '/v1/x402/envelope'), null);
    assert.equal(matchRoute('POST', '/v1/x402/envelope/abc'), null);
  });
});
