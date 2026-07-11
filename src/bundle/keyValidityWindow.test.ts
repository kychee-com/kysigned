/**
 * keyValidityWindow tests (F-32.4 / AC-159/160, #139) — the anchored-time
 * upper-bound rule that defeats the retired-key / rotate-and-publish forgery.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validityFromWindow, KEY_VALIDITY_GRACE_SEC } from './keyValidityWindow.js';

const T = 1_780_000_000;
const iso = (sec: number) => new Date(sec * 1000).toISOString();

describe('validityFromWindow (F-32.4)', () => {
  it('provenance not confirmed → inconclusive (validity is only meaningful once the key is provider-confirmed)', () => {
    assert.equal(validityFromWindow(T, iso(T + 100), 'pending'), 'inconclusive');
    assert.equal(validityFromWindow(T, iso(T + 100), 'failed'), 'inconclusive');
  });

  it('signing time at/within the last-observed-live window → confirmed', () => {
    assert.equal(validityFromWindow(T, iso(T), 'confirmed'), 'confirmed'); // exactly at last-seen
    assert.equal(validityFromWindow(T, iso(T + 1000), 'confirmed'), 'confirmed'); // before last-seen
    assert.equal(validityFromWindow(T, iso(T - KEY_VALIDITY_GRACE_SEC + 10), 'confirmed'), 'confirmed'); // within grace
  });

  it('signing time AFTER last-observed-live + grace → inconclusive (retired-key forgery capped, never durable)', () => {
    assert.equal(validityFromWindow(T, iso(T - KEY_VALIDITY_GRACE_SEC - 10), 'confirmed'), 'inconclusive');
  });

  it('the LOWER bound is NOT required — a signing time BEFORE first/last-seen still passes (contribute-at-signing; the DD-16 trap)', () => {
    // last-seen well AFTER signing (key kept being observed) → still within the upper bound.
    assert.equal(validityFromWindow(T, iso(T + 10 * KEY_VALIDITY_GRACE_SEC), 'confirmed'), 'confirmed');
  });

  it('missing signing time, missing last-seen, or unparseable date → inconclusive (never a false confirm)', () => {
    assert.equal(validityFromWindow(null, iso(T), 'confirmed'), 'inconclusive');
    assert.equal(validityFromWindow(T, null, 'confirmed'), 'inconclusive');
    assert.equal(validityFromWindow(T, 'not-a-date', 'confirmed'), 'inconclusive');
  });
});
