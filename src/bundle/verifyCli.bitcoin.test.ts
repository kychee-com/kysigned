/**
 * CLI Bitcoin-anchor status text — F-10.6 / AC-99.
 *
 * The reference CLI renders each signer's Bitcoin anchor distinctly from the
 * RFC-3161 time: `confirmed (block N, <time>)` / `pending` / (nothing when
 * absent). The Bitcoin status is ADDITIVE — it never changes the exit code.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatVerdict, exitCodeFor } from './verifyCli.js';
import type { BundleVerdict, BitcoinAnchor } from './verifyTypes.js';

function verdict(anchor: BitcoinAnchor, proven = true): BundleVerdict {
  return {
    proven,
    fingerprint: { computed: 'a'.repeat(64), matchesPrinted: true },
    signers: [
      {
        index: 1,
        proven,
        email: 'alice@example.com',
        signingDomain: 'example.com',
        verbatimIntent: 'I sign this document',
        signingTimeSec: 1_780_000_000,
        checks: { dkim: true, attachment: true, intent: true, timestamp: true, keyAuthenticity: 'archive-confirmed' },
        bitcoinAnchor: anchor,
        reasons: [],
      },
    ],
    errors: [],
  };
}

describe('CLI Bitcoin-anchor text (F-10.6 / AC-99)', () => {
  it('renders a confirmed anchor with the block height + time', () => {
    const out = formatVerdict(verdict({ status: 'confirmed', blockHeight: 750000, timeSec: 1_700_000_000 }));
    assert.match(out, /Bitcoin timestamp: confirmed \(block 750000/);
  });

  it('renders a pending anchor', () => {
    assert.match(formatVerdict(verdict({ status: 'pending' })), /Bitcoin timestamp: pending/);
  });

  it('omits the line entirely when there is no OpenTimestamps proof (absent)', () => {
    assert.doesNotMatch(formatVerdict(verdict({ status: 'absent' })), /Bitcoin timestamp/);
  });

  it('the Bitcoin status never changes the exit code (additive)', () => {
    assert.equal(exitCodeFor(verdict({ status: 'pending' })), 0); // PROVEN bundle → exit 0 even with Bitcoin pending
    assert.equal(exitCodeFor(verdict({ status: 'confirmed', blockHeight: 1 })), 0);
  });
});
