/**
 * authMethods.test.ts — F-41.1/F-41.7 (AC-244, AC-253), the provider-discovery
 * proxy behind the gate's "Continue with Google" button.
 *
 * The SPA never talks to run402 (the anon key stays server-side, the F-18.1
 * posture), so the button's feature detection is a kysigned route proxying
 * run402's `GET /auth/v1/providers`. Invariants:
 *
 *   - google is true ONLY when the platform reports the provider enabled;
 *   - any failure — network, non-200, malformed body — reads as {google:false},
 *     so the gate degrades to the email-only form and never breaks (AC-244's
 *     no-broken-control, AC-253's fork posture);
 *   - the platform answer is cached per warm container for a short TTL, so the
 *     gate render never fans out one upstream call per visitor.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMethodsResolver, METHODS_CACHE_TTL_MS } from './authMethods.js';

/** The REAL run402 providers wire shape (routes/auth.ts:410.., read at 414cc643). */
function providersBody(googleEnabled: boolean) {
  return {
    password: { enabled: true },
    magic_link: { enabled: true },
    password_set: { enabled: false },
    passkey: { enabled: true, resident_key: 'preferred', user_verification: 'required' },
    settings: {
      allow_password_set: false,
      preferred_sign_in_method: null,
      public_signup: 'open',
      require_passkey_for_project_admin: false,
      allowed_email_domains: [],
      test_mode: false,
    },
    oauth: [{ provider: 'google', enabled: googleEnabled, display_name: 'Google' }],
  };
}

function fakeFetch(responses: Array<{ status: number; body: unknown } | Error>) {
  const calls: string[] = [];
  const impl = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push(url);
    const next = responses.shift();
    if (!next) throw new Error('fakeFetch exhausted');
    if (next instanceof Error) throw next;
    void init;
    return { status: next.status, ok: next.status < 300, json: async () => next.body };
  };
  return { impl, calls };
}

const SESSION = { projectAnonKey: 'anon-key-1', run402BaseUrl: 'https://api.example' };

describe('createMethodsResolver', () => {
  it('reports google enabled from the platform providers surface, via the anon key', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: providersBody(true) }]);
    const resolve = createMethodsResolver({ session: { ...SESSION, fetchImpl: impl } });
    assert.deepEqual(await resolve(), { google: true });
    assert.equal(calls[0], 'https://api.example/auth/v1/providers');
  });

  it('reports google false when the platform says disabled', async () => {
    const { impl } = fakeFetch([{ status: 200, body: providersBody(false) }]);
    const resolve = createMethodsResolver({ session: { ...SESSION, fetchImpl: impl } });
    assert.deepEqual(await resolve(), { google: false });
  });

  it('fails to the email-only gate: network error, non-200, and malformed body all read {google:false}', async () => {
    for (const responses of [
      [new Error('offline')],
      [{ status: 503, body: { error: 'nope' } }],
      [{ status: 200, body: { oauth: 'not-an-array' } }],
    ] as Array<Array<{ status: number; body: unknown } | Error>>) {
      const { impl } = fakeFetch(responses);
      const resolve = createMethodsResolver({ session: { ...SESSION, fetchImpl: impl } });
      assert.deepEqual(await resolve(), { google: false });
    }
  });

  it('caches the platform answer for the TTL and refreshes after it', async () => {
    let t = 0;
    const { impl, calls } = fakeFetch([
      { status: 200, body: providersBody(true) },
      { status: 200, body: providersBody(false) },
    ]);
    const resolve = createMethodsResolver({ session: { ...SESSION, fetchImpl: impl }, now: () => t });
    assert.deepEqual(await resolve(), { google: true });
    t += METHODS_CACHE_TTL_MS - 1;
    assert.deepEqual(await resolve(), { google: true }, 'inside the TTL: cached');
    assert.equal(calls.length, 1, 'no second upstream call inside the TTL');
    t += 2;
    assert.deepEqual(await resolve(), { google: false }, 'past the TTL: refreshed');
    assert.equal(calls.length, 2);
  });

  it('a FAILED probe is not cached as gospel: the next call retries upstream', async () => {
    const { impl, calls } = fakeFetch([new Error('offline'), { status: 200, body: providersBody(true) }]);
    const resolve = createMethodsResolver({ session: { ...SESSION, fetchImpl: impl } });
    assert.deepEqual(await resolve(), { google: false });
    assert.deepEqual(await resolve(), { google: true }, 'the outage answer expires immediately');
    assert.equal(calls.length, 2);
  });
});
