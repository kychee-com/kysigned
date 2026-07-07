/**
 * F-3.5 — bundle-size guard tests (AC-7).
 *
 * AC-7: an envelope whose estimated bundle exceeds the ceiling is rejected at
 * creation with an error naming document size, signer count, estimated bundle
 * size, and the ceiling.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateBundleSize,
  sizeRejectionMessage,
  SIZE_GUARD_DEFAULTS,
} from './sizeGuard.ts';

const MiB = 1024 * 1024;

describe('estimateBundleSize — F-3.5 / AC-7', () => {
  it('default ceiling is 15 MiB (F-3.5)', () => {
    assert.equal(SIZE_GUARD_DEFAULTS.ceilingBytes, 15 * MiB);
  });

  it('a small document with a few signers fits', () => {
    const est = estimateBundleSize(500_000, 2); // 0.5 MB, 2 signers
    assert.equal(est.ok, true);
    assert.ok(est.estimatedBundleBytes > 500_000, 'estimate exceeds the bare document');
    assert.equal(est.documentBytes, 500_000);
    assert.equal(est.signerCount, 2);
  });

  it('a very large document is rejected (over the ceiling)', () => {
    const est = estimateBundleSize(10 * MiB, 2); // 10 MB doc → bundle far over 15 MB
    assert.equal(est.ok, false);
    assert.ok(est.estimatedBundleBytes > est.ceilingBytes);
  });

  it('estimate grows with signer count (each signer re-attaches the canonical PDF)', () => {
    const one = estimateBundleSize(1 * MiB, 1).estimatedBundleBytes;
    const five = estimateBundleSize(1 * MiB, 5).estimatedBundleBytes;
    assert.ok(five > one, 'more signers → larger estimated bundle');
  });

  it('enough signers push an otherwise-fine document over the ceiling', () => {
    assert.equal(estimateBundleSize(2 * MiB, 1).ok, true);
    assert.equal(estimateBundleSize(2 * MiB, 8).ok, false, '8 signers of a 2 MB doc exceed 15 MB');
  });

  it('honors a ceiling override', () => {
    const big = estimateBundleSize(1 * MiB, 1, { ceilingBytes: 100 * MiB });
    assert.equal(big.ok, true);
    const tiny = estimateBundleSize(1 * MiB, 1, { ceilingBytes: 1 * MiB });
    assert.equal(tiny.ok, false);
    assert.equal(tiny.ceilingBytes, 1 * MiB);
  });

  it('boundary: an estimate exactly at the ceiling is allowed (<=)', () => {
    const probe = estimateBundleSize(1 * MiB, 2);
    const exact = estimateBundleSize(1 * MiB, 2, { ceilingBytes: probe.estimatedBundleBytes });
    assert.equal(exact.ok, true);
    const justUnder = estimateBundleSize(1 * MiB, 2, { ceilingBytes: probe.estimatedBundleBytes - 1 });
    assert.equal(justUnder.ok, false);
  });
});

describe('sizeRejectionMessage — AC-7 names all four quantities', () => {
  it('includes document size, signer count, estimated bundle size, and the ceiling', () => {
    const est = estimateBundleSize(12 * MiB, 3);
    assert.equal(est.ok, false);
    const msg = sizeRejectionMessage(est);
    assert.match(msg, /12\.0 MB/, 'document size');
    assert.match(msg, /3 signers/, 'signer count');
    assert.match(msg, /15\.0 MB limit/, 'ceiling');
    // estimated bundle size appears as an MB figure distinct from doc/ceiling
    assert.match(msg, /estimated [\d.]+ MB signing record/, 'estimated signing-record size');
  });

  it('uses the singular "signer" for a 1-signer envelope', () => {
    const est = estimateBundleSize(20 * MiB, 1);
    assert.match(sizeRejectionMessage(est), /1 signer\b/);
  });
});
