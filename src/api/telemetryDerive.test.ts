/**
 * telemetryDerive — F-38.5 (spec 0.59.0, DD-50.3/50.4): server-side
 * derivation-then-discard. The browser hands the server derivation riders
 * (referrer, click-id presence); the server buckets and DISCARDS them — the
 * functions here are pure and return only the coarse bucket / country code.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSourceBucket, deriveCountry, deriveDevice } from './telemetryDerive.js';

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

  it('reads the canonical x-run402-country (run402 #609 — minted on BOTH ingress edges)', () => {
    assert.equal(deriveCountry(h({ 'x-run402-country': 'IL' })), 'IL');
    assert.equal(deriveCountry(h({ 'X-Run402-Country': 'de' })), 'DE');
  });

  it('the canonical header wins over the vendor alias when both are present', () => {
    assert.equal(deriveCountry(h({ 'x-run402-country': 'IL', 'cf-ipcountry': 'DE' })), 'IL');
  });

  it('falls back to cf-ipcountry — the documented custom-domain compat alias', () => {
    assert.equal(deriveCountry(h({ 'cf-ipcountry': 'IL' })), 'IL');
    assert.equal(deriveCountry(h({ 'CF-IPCountry': 'de' })), 'DE');
  });

  // run402 #609 blocklists the raw CloudFront header at the gateway on the managed
  // path and translates it to the canonical header, so this vendor header reaching
  // the function can only be a client spoof (a direct-to-ALB caller) — never trusted.
  it('a raw cloudfront-viewer-country is NOT trusted (post-#609 it can only be a spoof)', () => {
    assert.equal(deriveCountry(h({ 'cloudfront-viewer-country': 'US' })), 'unknown');
    assert.equal(deriveCountry(h({ 'x-run402-country': 'IL', 'cloudfront-viewer-country': 'US' })), 'IL');
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

describe('deriveDevice (F-38.9 / DD-54 — coarse class from UA, raw string never kept)', () => {
  const h = (ua?: string) => new Headers(ua !== undefined ? { 'user-agent': ua } : {});

  it('phones → mobile', () => {
    // iPhone (note: the iPhone UA also contains "Mobile")
    assert.equal(deriveDevice(h('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')), 'mobile');
    // Android phone (Android + Mobile token)
    assert.equal(deriveDevice(h('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36')), 'mobile');
    // Windows Phone
    assert.equal(deriveDevice(h('Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1; Microsoft; Lumia 950) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52 Mobile Safari/537.36 Edge/15')), 'mobile');
  });

  it('tablets → tablet (checked before mobile — iPad and Android tablets otherwise read as mobile)', () => {
    // iPad — the classic iPad UA contains "Mobile", so tablet MUST win first
    assert.equal(deriveDevice(h('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')), 'tablet');
    // Android tablet — Android WITHOUT the "Mobile" token
    assert.equal(deriveDevice(h('Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')), 'tablet');
    // Kindle Fire (Silk)
    assert.equal(deriveDevice(h('Mozilla/5.0 (Linux; Android 9; KFMAWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/119.1.1 like Chrome/119.0.0.0 Mobile Safari/537.36')), 'tablet');
  });

  it('desktops → desktop', () => {
    assert.equal(deriveDevice(h('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')), 'desktop');
    assert.equal(deriveDevice(h('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15')), 'desktop');
    assert.equal(deriveDevice(h('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')), 'desktop');
  });

  it('absent / empty / unclassifiable UA → unknown (never a guess)', () => {
    assert.equal(deriveDevice(h()), 'unknown');
    assert.equal(deriveDevice(h('')), 'unknown');
    assert.equal(deriveDevice(h('curl/8.0.1')), 'unknown');
    assert.equal(deriveDevice(h('some random string')), 'unknown');
  });

  it('only ever returns one of the four fixed classes (no raw-UA fragment)', () => {
    const CLASSES = new Set(['mobile', 'desktop', 'tablet', 'unknown']);
    const uas = [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'curl/8.0.1',
      '',
    ];
    for (const ua of uas) {
      assert.ok(CLASSES.has(deriveDevice(h(ua))), `${ua} → not a fixed class`);
    }
  });
});
