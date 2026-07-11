/**
 * assuranceTier tests (F-32.1, #137) — the pure verdict-tier function that
 * replaces the binary `proven` with FAILED / INTEGRITY VERIFIED / PROVIDER KEY
 * CONFIRMED / PROVEN (DURABLE). Pure input→output; no bundle, no crypto.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeSignerTier, type HardChecks, type AssuranceDimensions } from './assuranceTier.js';

const HARD_OK: HardChecks = { dkim: true, attachment: true, intent: true, timestamp: true };
const DIMS_NONE: AssuranceDimensions = {
  keyProvenance: 'pending',
  timestampDurability: 'pending',
  keyValidity: 'inconclusive',
};

describe('computeSignerTier (F-32.1)', () => {
  it('all hard checks pass but every dimension pending/inconclusive → INTEGRITY_VERIFIED (today’s honest state)', () => {
    assert.equal(computeSignerTier(HARD_OK, DIMS_NONE), 'INTEGRITY_VERIFIED');
  });

  it('key provenance confirmed but timestamp not durable → PROVIDER_KEY_CONFIRMED (cannot reach durable)', () => {
    assert.equal(
      computeSignerTier(HARD_OK, { keyProvenance: 'confirmed', timestampDurability: 'pending', keyValidity: 'confirmed' }),
      'PROVIDER_KEY_CONFIRMED',
    );
  });

  it('key provenance confirmed but key validity inconclusive → PROVIDER_KEY_CONFIRMED (no window ⇒ not durable)', () => {
    assert.equal(
      computeSignerTier(HARD_OK, { keyProvenance: 'confirmed', timestampDurability: 'confirmed', keyValidity: 'inconclusive' }),
      'PROVIDER_KEY_CONFIRMED',
    );
  });

  it('all three dimensions confirmed + hard pass → PROVEN_DURABLE', () => {
    assert.equal(
      computeSignerTier(HARD_OK, { keyProvenance: 'confirmed', timestampDurability: 'confirmed', keyValidity: 'confirmed' }),
      'PROVEN_DURABLE',
    );
  });

  it('any hard check false → FAILED regardless of dimensions', () => {
    const allConfirmed: AssuranceDimensions = { keyProvenance: 'confirmed', timestampDurability: 'confirmed', keyValidity: 'confirmed' };
    for (const k of ['dkim', 'attachment', 'intent', 'timestamp'] as const) {
      assert.equal(computeSignerTier({ ...HARD_OK, [k]: false }, allConfirmed), 'FAILED', `hard.${k} false`);
    }
  });

  it('any dimension FAILED (tampered/substituted assurance evidence) → FAILED, never a downgraded tier (AC-154)', () => {
    for (const k of ['keyProvenance', 'timestampDurability', 'keyValidity'] as const) {
      assert.equal(
        computeSignerTier(HARD_OK, { keyProvenance: 'confirmed', timestampDurability: 'confirmed', keyValidity: 'confirmed', [k]: 'failed' }),
        'FAILED',
        `dim ${k} failed`,
      );
    }
  });

  it('the malicious-operator shape — hard-valid under a self-minted key, provenance never confirmed — caps at INTEGRITY_VERIFIED (AC-153)', () => {
    // A self-consistent bundle: dkim verifies against the embedded (attacker) key,
    // attachment/intent/timestamp all pass, but no independent provenance exists.
    assert.equal(
      computeSignerTier(HARD_OK, { keyProvenance: 'pending', timestampDurability: 'confirmed', keyValidity: 'inconclusive' }),
      'INTEGRITY_VERIFIED',
    );
  });
});
