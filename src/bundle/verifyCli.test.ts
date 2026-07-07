/**
 * CLI verifier rendering tests — F-10.4 / AC-29. Pure over synthetic verdicts:
 * human-first PROVEN copy + exit 0; FAILED names the broken checks + exit 1; a
 * fingerprint mismatch is surfaced (AC-64). (The engine itself is covered by
 * verify.test.ts; runVerifyCli's integration with it is exercised there + Phase 19.)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatVerdict, exitCodeFor } from './verifyCli.js';
import type { BundleVerdict, SignerVerdict } from './verify.js';

function signer(over: Partial<SignerVerdict> = {}): SignerVerdict {
  return {
    index: over.index ?? 1,
    proven: over.proven ?? true,
    email: over.email ?? 'alice@example.com',
    signingDomain: over.signingDomain ?? 'example.com',
    verbatimIntent: over.verbatimIntent ?? 'I sign this document',
    signingTimeSec: over.signingTimeSec ?? 1_780_000_000,
    checks: over.checks ?? { dkim: true, attachment: true, intent: true, timestamp: true, keyAuthenticity: 'pending-online' },
    bitcoinAnchor: over.bitcoinAnchor ?? { status: 'absent' },
    keyObservedAt: over.keyObservedAt ?? null,
    reasons: over.reasons ?? [],
  };
}

function verdict(over: Partial<BundleVerdict> = {}): BundleVerdict {
  return {
    proven: over.proven ?? true,
    fingerprint: over.fingerprint ?? { computed: 'a'.repeat(64), matchesPrinted: true },
    signers: over.signers ?? [signer()],
    errors: over.errors ?? [],
  };
}

describe('formatVerdict / exitCodeFor — F-10.4 / AC-29', () => {
  it('PROVEN: human-first claim, fingerprint match, exit 0', () => {
    const v = verdict();
    const out = formatVerdict(v);
    assert.match(out, /OVERALL: PROVEN/);
    assert.match(out, /A sender authenticated by example\.com as alice@example\.com sent/);
    assert.match(out, /"I sign this document" with exactly this document attached/);
    assert.match(out, /MATCHES the value printed/);
    assert.equal(exitCodeFor(v), 0);
  });

  it('FAILED: names the broken checks + exit 1', () => {
    const v = verdict({
      proven: false,
      signers: [signer({ proven: false, reasons: ['DKIM invalid_signature', 'attachment modified'] })],
    });
    const out = formatVerdict(v);
    assert.match(out, /Signer 1: FAILED/);
    assert.match(out, /DKIM invalid_signature/);
    assert.match(out, /attachment modified/);
    assert.match(out, /OVERALL: FAILED/);
    assert.match(out, /kysigned is not part of the trust set/);
    assert.equal(exitCodeFor(v), 1);
  });

  it('surfaces a fingerprint mismatch (AC-64)', () => {
    const mismatch = formatVerdict(verdict({ proven: false, fingerprint: { computed: 'b'.repeat(64), matchesPrinted: false } }));
    assert.match(mismatch, /DOES NOT MATCH .* altered after assembly/);
  });

  it('renders the key-archive presence as a distinct line — confirmed with the registration time / pending (F-10.7 / AC-101)', () => {
    const confirmed = formatVerdict(
      verdict({
        signers: [
          signer({
            checks: { dkim: true, attachment: true, intent: true, timestamp: true, keyAuthenticity: 'archive-confirmed' },
            keyObservedAt: '2026-06-29T11:42:02.820Z',
          }),
        ],
      }),
    );
    assert.match(confirmed, /Key archive: confirmed/);
    assert.match(confirmed, /registered 2026-06-29/);

    const pending = formatVerdict(verdict()); // factory default keyAuthenticity = pending-online
    assert.match(pending, /Key archive: pending/);
    assert.doesNotMatch(pending, /Key archive: confirmed/);
  });

  it('reports structural errors (e.g. not a bundle)', () => {
    const out = formatVerdict(verdict({ proven: false, signers: [], errors: ['no signer-<n>.eml evidence found'] }));
    assert.match(out, /STRUCTURAL ERRORS/);
    assert.match(out, /no signer-<n>\.eml evidence found/);
  });
});
