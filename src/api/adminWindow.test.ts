/**
 * adminWindow.test — F-34.1 / AC-182 operator-console time window.
 *
 * `parseWindow` translates the `?window=` query param into a lower bound the
 * analytics DAOs filter on: a fixed set of windows (24h / 7d / 30d / 365d) map to
 * `now − interval`; `all` removes the bound (since = null); anything absent or
 * unrecognized falls to the 30-day default. `now` is injected so the arithmetic
 * is deterministic under test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseWindow } from './adminWindow.js';

const NOW = new Date('2026-07-17T12:00:00.000Z');
const H = 3_600_000;
const D = 24 * H;

describe('parseWindow — F-34.1 / AC-182', () => {
  it('24h → since = now − 24h', () => {
    const r = parseWindow('24h', NOW);
    assert.equal(r.key, '24h');
    assert.equal(r.since?.toISOString(), new Date(NOW.getTime() - 24 * H).toISOString());
  });

  it('7d → since = now − 7 days', () => {
    const r = parseWindow('7d', NOW);
    assert.equal(r.key, '7d');
    assert.equal(r.since?.toISOString(), new Date(NOW.getTime() - 7 * D).toISOString());
  });

  it('30d → since = now − 30 days', () => {
    const r = parseWindow('30d', NOW);
    assert.equal(r.key, '30d');
    assert.equal(r.since?.toISOString(), new Date(NOW.getTime() - 30 * D).toISOString());
  });

  it('365d → since = now − 365 days', () => {
    const r = parseWindow('365d', NOW);
    assert.equal(r.key, '365d');
    assert.equal(r.since?.toISOString(), new Date(NOW.getTime() - 365 * D).toISOString());
  });

  it('all → no lower bound (since = null)', () => {
    const r = parseWindow('all', NOW);
    assert.equal(r.key, 'all');
    assert.equal(r.since, null);
  });

  it('absent → 30-day default', () => {
    const r = parseWindow(undefined, NOW);
    assert.equal(r.key, '30d');
    assert.equal(r.since?.toISOString(), new Date(NOW.getTime() - 30 * D).toISOString());
  });

  it('unrecognized → 30-day default (fail-safe, never an unbounded scan)', () => {
    const r = parseWindow('garbage', NOW);
    assert.equal(r.key, '30d');
    assert.equal(r.since?.toISOString(), new Date(NOW.getTime() - 30 * D).toISOString());
  });
});
