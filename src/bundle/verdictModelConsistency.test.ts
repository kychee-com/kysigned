/**
 * Verdict-model consistency guard (F-32.5 / AC-161) — the F-019b regression.
 *
 * The 51.8 docs sweep updated four surfaces to the tier model but MISSED the fifth (the
 * independent-toolkit README), which still described the retired pre-F-32 model ("online
 * steps never change the verdict" — false, the archive gate CAN fail it). A code-blind
 * red-team read caught it. This guard makes that class of miss un-shippable: it greps every
 * customer-facing / verify surface for phrasing that ONLY exists in the retired model, and
 * fails the build if any survives. Enumerated by grep, not by a hand-list — which is exactly
 * the discipline whose absence caused F-019b.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Every surface that states the verdict / timestamp / provenance model (AC-161).
const SURFACES = [
  'docs/trust-model.md',
  'docs/test-assets/README.md',
  'src/bundle/verifyReadme.ts',
  'src/timestamp/README.md',
  'src/api/signing/timestampProviders.ts',
  'scripts/verification-tools/README.md',
  'frontend/public/how-it-works-technical.html',
  'frontend/public/how-it-works.html',
  'frontend/public/llms.txt',
];

// Phrases that ONLY exist in the RETIRED (pre-F-32) model — each is a real regression signal.
const FORBIDDEN = [
  { re: /rely on \*?either\*?\b[^.]*\balone/i, why: 'timestamp "rely on either alone" — the durable tier REQUIRES the Bitcoin anchor, not either' },
  { re: /defeat \*?both\*?\b/i, why: 'timestamp "defeat both" framing — superseded by graded durability' },
  { re: /never (?:change|gate)s? the [^.]*\bverdict/i, why: 'archive/Bitcoin described as additive "never changes the verdict" — the provenance gate CAN fail it' },
  { re: /additive online steps/i, why: 'the pre-F-32 "additive online steps" section' },
  // Spec 0.44.0 (#147): the window consumes archive times AS RECORDED — the API exposes
  // no live-vs-GCD label, so a surface claiming live-only semantics overclaims.
  { re: /observed[- ]live window|observed live \(plus/i, why: 'the retired live-only window claim — the window uses the archive times AS RECORDED (F-32.4, spec 0.44.0)' },
  // Spec 0.44.2 (AC-161, Barry 2026-07-15): GCD / recovery-corpus mechanics are an INTERNAL
  // engineering note (keyValidityWindow.ts + the spec), never public trust copy — the public
  // window rule is the plain last-seen upper bound. Forbid the mechanics from leaking into any
  // customer-facing / verify surface (the rotate-and-publish defence is the timestamp bound; the
  // GCD detail defends a corner of a non-event and only reads as doubt in a confidence doc).
  { re: /\bGCD\b|recovery corpus/i, why: 'GCD / recovery-corpus mechanics belong to the internal engineering note, not public trust copy (AC-161, spec 0.44.2) — the public window rule is the plain last-seen upper bound' },
  // Spec 0.46.0 (AC-161/AC-169): FACTUALLY FALSE since the archive team confirmed
  // (2026-07-15, zkemail/archive#46) that the witness/on-chain path was dropped in their
  // rebuild — their records are server-trusted plain JSON. Our own key observation carries
  // its own OTS anchor instead (AC-169). Never let the claim back onto a surface.
  { re: /witness\.co|witness[- ]timestamp|Witness (inclusion|→|Ethereum)|tlsnotary/i, why: 'the archive runs NO witness/on-chain timestamping (dropped in its rebuild; confirmed 2026-07-15 on zkemail/archive#46) — describing its records as chain-anchored is false (AC-161, spec 0.46.0)' },
];

describe('verdict-model consistency across surfaces (AC-161 / F-019b regression)', () => {
  for (const rel of SURFACES) {
    it(`${rel} carries no retired pre-F-32 model phrasing`, () => {
      const text = readFileSync(root + rel, 'utf8');
      for (const { re, why } of FORBIDDEN) {
        const m = re.exec(text);
        assert.equal(m, null, m ? `${rel}: retired-model phrasing found (${why}) → "${m[0]}"` : '');
      }
    });
  }
});
