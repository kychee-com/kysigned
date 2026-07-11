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
