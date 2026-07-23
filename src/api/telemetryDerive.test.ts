/**
 * telemetryDerive — F-38.5 (spec 0.59.0, DD-50.3/50.4): server-side
 * derivation-then-discard. The browser hands the server derivation riders
 * (referrer, click-id presence); the server buckets and DISCARDS them — the
 * functions here are pure and return only the coarse bucket / country code.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSourceBucket, deriveCountry } from './telemetryDerive.js';

describe('deriveSourceBucket (F-38.5)', () => {
  it('an ad click id present → paid, regardless of referrer', () => {
    assert.equal(deriveSourceBucket({ referrer: 'https://www.google.com/', gclidPresent: true, ownHost: 'kysigned.com' }), 'paid');
    assert.equal(deriveSourceBucket({ referrer: null, gclidPresent: true, ownHost: 'kysigned.com' }), 'paid');
  });

  it('search-engine referrer → organic', () => {
    assert.equal(deriveSourceBucket({ referrer: 'https://www.google.com/search?q=x', gclidPresent: false, ownHost: 'kysigned.com' }), 'organic');
    assert.equal(deriveSourceBucket({ referrer: 'https://www.bing.com/search?q=x', gclidPresent: false, ownHost: 'kysigned.com' }), 'organic');
    assert.equal(deriveSourceBucket({ referrer: 'https://duckduckgo.com/', gclidPresent: false, ownHost: 'kysigned.com' }), 'organic');
  });

  it('another site → referral; no referrer → direct', () => {
    assert.equal(deriveSourceBucket({ referrer: 'https://news.ycombinator.com/item?id=1', gclidPresent: false, ownHost: 'kysigned.com' }), 'referral');
    assert.equal(deriveSourceBucket({ referrer: null, gclidPresent: false, ownHost: 'kysigned.com' }), 'direct');
    assert.equal(deriveSourceBucket({ referrer: '', gclidPresent: false, ownHost: 'kysigned.com' }), 'direct');
  });

  it('own-host referrer (internal navigation) → direct', () => {
    assert.equal(deriveSourceBucket({ referrer: 'https://kysigned.com/pricing', gclidPresent: false, ownHost: 'kysigned.com' }), 'direct');
    assert.equal(deriveSourceBucket({ referrer: 'https://KYSIGNED.com/', gclidPresent: false, ownHost: 'kysigned.com' }), 'direct');
  });

  it('a malformed referrer never throws — falls to direct', () => {
    assert.equal(deriveSourceBucket({ referrer: 'not a url %%%', gclidPresent: false, ownHost: 'kysigned.com' }), 'direct');
  });
});

describe('deriveCountry (F-38.5 / DD-50.4 — platform-provided or explicit unknown)', () => {
  const h = (entries: Record<string, string>) => new Headers(entries);

  it('reads cf-ipcountry when Cloudflare stamps it', () => {
    assert.equal(deriveCountry(h({ 'cf-ipcountry': 'IL' })), 'IL');
    assert.equal(deriveCountry(h({ 'CF-IPCountry': 'de' })), 'DE');
  });

  it('falls back to cloudfront-viewer-country (the managed-subdomain edge)', () => {
    assert.equal(deriveCountry(h({ 'cloudfront-viewer-country': 'US' })), 'US');
  });

  it('nothing provided → the explicit unknown, never empty or a guess', () => {
    assert.equal(deriveCountry(h({})), 'unknown');
  });

  it("Cloudflare's non-country sentinels (XX unknown, T1 Tor) → unknown", () => {
    assert.equal(deriveCountry(h({ 'cf-ipcountry': 'XX' })), 'unknown');
    assert.equal(deriveCountry(h({ 'cf-ipcountry': 'T1' })), 'unknown');
  });

  it('garbage header values → unknown (only [A-Z]{2} passes)', () => {
    assert.equal(deriveCountry(h({ 'cf-ipcountry': 'ZZZ' })), 'unknown');
    assert.equal(deriveCountry(h({ 'cf-ipcountry': '<script>' })), 'unknown');
  });
});
