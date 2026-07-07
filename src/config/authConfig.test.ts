/**
 * authConfig.test.ts — forker auth-config derivation helpers (2F.AUTH6, F2.1.12).
 *
 * `cookieDomain` and `webauthnRpId` derive from the deployment's spaDomain
 * (or operatorDomain — they're the same under DD-73 single-host). Defaults
 * must work for three operator shapes:
 *   1. Two-host operator on owned apex (e.g. app.example.com)
 *   2. Single-host forker on owned apex (Kychee post-DD-73: kysigned.com)
 *   3. Forker on a run402 tenant subdomain (e.g. lawfirmxx-signed.run402.com)
 *
 * The cookieDomain leading dot is the key distinction: it's only safe to
 * use when the operator OWNS the registrable domain. For tenant subdomains
 * sharing a public apex (run402.com), the cookie MUST be host-scoped so it
 * doesn't leak across tenants.
 *
 * webauthnRpId never has a leading dot — WebAuthn forbids it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCookieDomain, deriveWebauthnRpId } from './authConfig.js';

describe('deriveCookieDomain — owned-apex stripping', () => {
  it('strips leftmost label for two-host operator (app.example.com → .example.com)', () => {
    assert.equal(deriveCookieDomain('app.example.com'), '.example.com');
  });

  it('strips leftmost label for forker with own apex (signed.lawfirmxx.com → .lawfirmxx.com)', () => {
    assert.equal(deriveCookieDomain('signed.lawfirmxx.com'), '.lawfirmxx.com');
  });

  it('returns host-scoped (no leading dot) for 2-label apex (kysigned.com → kysigned.com)', () => {
    assert.equal(deriveCookieDomain('kysigned.com'), 'kysigned.com');
  });

  it('returns host-scoped (no leading dot) for forker apex (lawfirmxx.com → lawfirmxx.com)', () => {
    assert.equal(deriveCookieDomain('lawfirmxx.com'), 'lawfirmxx.com');
  });
});

describe('deriveCookieDomain — shared-tenant apex protection', () => {
  it('returns host-scoped for run402 tenant subdomain (must NOT strip to .run402.com)', () => {
    assert.equal(
      deriveCookieDomain('lawfirmxx-signed.run402.com'),
      'lawfirmxx-signed.run402.com',
    );
  });

  it('still returns host-scoped even when the tenant string contains dots', () => {
    // A run402 tenant could conceivably be `lawfirm-xyz.run402.com` (3 labels).
    // Any host whose registrable portion is run402.com stays host-scoped.
    assert.equal(deriveCookieDomain('foo.run402.com'), 'foo.run402.com');
  });
});

describe('deriveCookieDomain — edge cases', () => {
  it('treats localhost as host-scoped (local dev)', () => {
    assert.equal(deriveCookieDomain('localhost'), 'localhost');
  });

  it('treats single-label hostname as host-scoped', () => {
    assert.equal(deriveCookieDomain('intranet'), 'intranet');
  });

  it('strips www. prefix the same way as any other subdomain', () => {
    // www.kysigned.com is unambiguously kysigned-owned; treat as 3-label apex.
    assert.equal(deriveCookieDomain('www.kysigned.com'), '.kysigned.com');
  });

  it('handles uppercase input (DNS is case-insensitive)', () => {
    assert.equal(deriveCookieDomain('APP.EXAMPLE.COM'), '.example.com');
  });
});

describe('deriveWebauthnRpId — registrable domain (no leading dot)', () => {
  it('returns registrable domain for two-host operator (app.example.com → example.com)', () => {
    assert.equal(deriveWebauthnRpId('app.example.com'), 'example.com');
  });

  it('returns registrable domain for forker with own apex', () => {
    assert.equal(deriveWebauthnRpId('signed.lawfirmxx.com'), 'lawfirmxx.com');
  });

  it('returns host as-is for 2-label apex (kysigned.com)', () => {
    assert.equal(deriveWebauthnRpId('kysigned.com'), 'kysigned.com');
  });

  it('returns full host for run402 tenant subdomain (rpId = host, not the public apex)', () => {
    // rpId must be a domain the operator effectively controls; for a run402
    // tenant the full host IS their controlled scope.
    assert.equal(
      deriveWebauthnRpId('lawfirmxx-signed.run402.com'),
      'lawfirmxx-signed.run402.com',
    );
  });

  it('NEVER has a leading dot (WebAuthn forbids it)', () => {
    assert.doesNotMatch(deriveWebauthnRpId('app.example.com'), /^\./);
    assert.doesNotMatch(deriveWebauthnRpId('kysigned.com'), /^\./);
    assert.doesNotMatch(deriveWebauthnRpId('foo.run402.com'), /^\./);
  });

  it('handles uppercase input (DNS is case-insensitive)', () => {
    assert.equal(deriveWebauthnRpId('APP.EXAMPLE.COM'), 'example.com');
  });
});
