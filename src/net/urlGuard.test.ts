/**
 * urlGuard tests — SSRF defense for server-side fetches (spec F-16.7 / AC-140).
 *
 * The literal-host block, the resolved-IP block, and the https+host sync guard
 * are shared by the pdf_url create path and the F-30.3 callback webhook.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedHostname, isBlockedIp, validatePublicHttpsUrl, assertResolvesPublic } from './urlGuard.js';

describe('isBlockedHostname (F-16.7)', () => {
  it('blocks loopback / link-local / private literals', () => {
    for (const h of ['localhost', '127.0.0.1', '127.9.9.9', '::1', '10.0.0.5', '192.168.1.4', '172.16.0.9', '172.31.255.1', '169.254.169.254', '0.0.0.0']) {
      assert.equal(isBlockedHostname(h), true, `must block ${h}`);
    }
  });
  it('allows public hostnames + public literals', () => {
    for (const h of ['example.com', 'agent.example.com', '8.8.8.8', '172.15.0.1', '172.32.0.1']) {
      assert.equal(isBlockedHostname(h), false, `must allow ${h}`);
    }
  });
});

describe('isBlockedIp (F-16.7)', () => {
  it('blocks v4 private/loopback/link-local/metadata and v6 loopback/ULA/link-local', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '172.31.9.9', '169.254.169.254', '0.0.0.0', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1']) {
      assert.equal(isBlockedIp(ip), true, `must block ${ip}`);
    }
  });
  it('allows public IPs', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111']) {
      assert.equal(isBlockedIp(ip), false, `must allow ${ip}`);
    }
  });
});

describe('validatePublicHttpsUrl (F-16.7)', () => {
  it('accepts a normal https URL', () => {
    assert.deepEqual(validatePublicHttpsUrl('https://cdn.example.com/doc.pdf'), { ok: true });
  });
  it('rejects http, garbage, and literal private/loopback/metadata hosts', () => {
    for (const bad of ['http://cdn.example.com/x', 'not a url', 'https://localhost/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data/', 'https://10.0.0.5/x', 'ftp://example.com/x']) {
      assert.equal(validatePublicHttpsUrl(bad).ok, false, `must reject ${bad}`);
    }
  });
});

describe('assertResolvesPublic (F-16.7)', () => {
  it('resolves-to-private is rejected; resolves-to-public passes', async () => {
    await assert.rejects(() => assertResolvesPublic('sneaky.example.com', async () => ['10.0.0.5']), /non-public|private/i);
    await assert.rejects(() => assertResolvesPublic('rebind.example.com', async () => ['8.8.8.8', '169.254.169.254']), /non-public|private/i, 'ANY private address is blocked');
    await assert.doesNotReject(() => assertResolvesPublic('good.example.com', async () => ['93.184.216.34']));
  });
});
