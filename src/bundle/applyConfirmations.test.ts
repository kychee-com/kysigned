/**
 * applyOnlineConfirmations tests (F-32.3/F-32.4 / AC-152/157/158/159/160, #136/#139) —
 * the online provenance GATE + validity window + deterministic tier upgrade.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyOnlineConfirmations } from './applyConfirmations.js';
import { KEY_VALIDITY_GRACE_SEC } from './keyValidityWindow.js';
import type { BundleVerdict, SignerVerdict } from './verifyTypes.js';
import type { KeyArchiveConfirmation } from './confirmKeyArchive.js';

const SIGN_SEC = 1_780_000_000;

// A genuine offline verdict: integrity-verified, all online-only dimensions pending.
function baseSigner(over: Partial<SignerVerdict> = {}): SignerVerdict {
  return {
    index: 1,
    proven: true,
    tier: 'INTEGRITY_VERIFIED',
    assurance: { keyProvenance: 'pending', timestampDurability: 'pending', keyValidity: 'pending' },
    email: 'alice@gmail.com',
    signingDomain: 'gmail.com',
    verbatimIntent: 'I sign this document',
    signingTimeSec: SIGN_SEC,
    originalDocSha256: 'd'.repeat(64),
    checks: { dkim: true, attachment: true, intent: true, timestamp: true, keyAuthenticity: 'pending-online' },
    bitcoinAnchor: { status: 'pending' },
    keyObservedAt: null,
    reasons: [],
    ...over,
  };
}

function baseVerdict(over: Partial<BundleVerdict> = {}): BundleVerdict {
  return {
    proven: true,
    tier: 'INTEGRITY_VERIFIED',
    fingerprint: { computed: 'a'.repeat(64), matchesPrinted: true },
    originalDocSha256: 'd'.repeat(64),
    signers: [baseSigner()],
    errors: [],
    ...over,
  };
}

const iso = (sec: number) => new Date(sec * 1000).toISOString();
function ka(over: Partial<KeyArchiveConfirmation>): KeyArchiveConfirmation {
  return { keyAuthenticity: 'pending-online', keyProvenance: 'pending', observedAt: null, lastSeenAt: null, ...over };
}

describe('applyOnlineConfirmations — provenance gate + window + upgrade', () => {
  it('exact-key confirm within the observed-live window + Bitcoin confirmed → PROVEN (DURABLE) (AC-152/159)', () => {
    const v = applyOnlineConfirmations(baseVerdict(), {
      bitcoin: { 1: { status: 'confirmed', blockHeight: 800000, timeSec: SIGN_SEC + 3600 } },
      keyArchive: { 1: ka({ keyAuthenticity: 'archive-confirmed', keyProvenance: 'confirmed', observedAt: iso(SIGN_SEC), lastSeenAt: iso(SIGN_SEC + 100) }) },
    });
    assert.equal(v.tier, 'PROVEN_DURABLE');
    assert.equal(v.signers[0].assurance.keyProvenance, 'confirmed');
    assert.equal(v.signers[0].assurance.timestampDurability, 'confirmed');
    assert.equal(v.signers[0].assurance.keyValidity, 'confirmed');
  });

  it('exact-key confirm but Bitcoin still pending → PROVIDER KEY CONFIRMED (durable needs the anchor)', () => {
    const v = applyOnlineConfirmations(baseVerdict(), {
      keyArchive: { 1: ka({ keyAuthenticity: 'archive-confirmed', keyProvenance: 'confirmed', lastSeenAt: iso(SIGN_SEC + 100) }) },
    });
    assert.equal(v.tier, 'PROVIDER_KEY_CONFIRMED');
    assert.equal(v.signers[0].assurance.timestampDurability, 'pending');
  });

  it('a DIFFERENT key registered for the domain/selector → keyProvenance failed → verdict FAILED with a reason (AC-157/158)', () => {
    const v = applyOnlineConfirmations(baseVerdict(), { keyArchive: { 1: ka({ keyProvenance: 'failed' }) } });
    assert.equal(v.tier, 'FAILED');
    assert.equal(v.signers[0].tier, 'FAILED');
    assert.ok(v.signers[0].reasons.some((r) => /provider key mismatch/i.test(r)));
  });

  it('archive absent/unreachable (pending) → stays INTEGRITY VERIFIED, never FAILED (AC-158)', () => {
    const v = applyOnlineConfirmations(baseVerdict(), { keyArchive: { 1: ka({ keyProvenance: 'pending' }) } });
    assert.equal(v.tier, 'INTEGRITY_VERIFIED');
  });

  it('Bitcoin confirmed but NO provenance → durable timestamp yet still INTEGRITY VERIFIED (provenance gates above integrity)', () => {
    const v = applyOnlineConfirmations(baseVerdict(), {
      bitcoin: { 1: { status: 'confirmed', blockHeight: 800000, timeSec: SIGN_SEC + 3600 } },
    });
    assert.equal(v.signers[0].assurance.timestampDurability, 'confirmed');
    assert.equal(v.tier, 'INTEGRITY_VERIFIED');
  });

  it('exact-key confirm but signing time AFTER the last-observed-live window → caps at PROVIDER KEY CONFIRMED, never PROVEN (DURABLE) (AC-160 retired-key)', () => {
    const v = applyOnlineConfirmations(baseVerdict(), {
      bitcoin: { 1: { status: 'confirmed', blockHeight: 800000, timeSec: SIGN_SEC + 3600 } },
      // key last seen live LONG before this signature was anchored → out of window
      keyArchive: { 1: ka({ keyAuthenticity: 'archive-confirmed', keyProvenance: 'confirmed', lastSeenAt: iso(SIGN_SEC - KEY_VALIDITY_GRACE_SEC - 10000) }) },
    });
    assert.equal(v.signers[0].assurance.keyValidity, 'inconclusive');
    assert.equal(v.tier, 'PROVIDER_KEY_CONFIRMED');
    assert.notEqual(v.tier, 'PROVEN_DURABLE');
  });

  it('a structurally-FAILED verdict stays FAILED regardless of confirmations', () => {
    const v = applyOnlineConfirmations(
      baseVerdict({ fingerprint: { computed: 'b'.repeat(64), matchesPrinted: false } }),
      { keyArchive: { 1: ka({ keyProvenance: 'confirmed', lastSeenAt: iso(SIGN_SEC + 100) }) } },
    );
    assert.equal(v.tier, 'FAILED');
  });
});
