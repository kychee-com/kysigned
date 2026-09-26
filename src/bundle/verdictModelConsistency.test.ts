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
  // F-47 (spec 0.75.1, BT-36.2): the published verifiers, which describe what offline reports.
  'cli/README.md',
  'cli/src/cli.ts',
  'mcp/README.md',
  'mcp/src/verifyBundle.ts',
  'mcp/src/server.ts',
  'mcp/src/webDocuments.ts',
];

/**
 * A surface's text. TypeScript sources build their copy from adjacent string pieces
 * (`'a ' + 'b'`, or array items joined by line breaks), so a sentence can be split across
 * pieces: join them, and unescape quotes, so a phrase matches wherever the source wraps it.
 */
function readSurface(rel: string): string {
  const text = readFileSync(root + rel, 'utf8');
  if (!rel.endsWith('.ts')) return text;
  return text.replace(/['"`]\s*[,+]?\s*\n\s*['"`]/g, ' ').replace(/\\(['"`])/g, '$1');
}

// Phrases that ONLY exist in the RETIRED (pre-F-32) model — each is a real regression signal.
const FORBIDDEN = [
  { re: /rely on \*?either\*?\b[^.]*\balone/i, why: 'timestamp "rely on either alone" — the durable tier REQUIRES the Bitcoin anchor, not either' },
  { re: /defeat \*?both\*?\b/i, why: 'timestamp "defeat both" framing — superseded by graded durability' },
  { re: /never (?:change|gate)s? the [^.]*\bverdict/i, why: 'archive/Bitcoin described as additive "never changes the verdict" — the provenance gate CAN fail it' },
  { re: /additive online steps/i, why: 'the pre-F-32 "additive online steps" section' },
  // RETIRED ENTRY (spec 0.71.0, #147-A delivered): "observed-live window" was forbidden
  // while the window consumed archive times as recorded (spec 0.44.0 — claiming live-only
  // semantics overclaimed). The archive now exposes per-channel observations and signs
  // only live-DNS ones, and F-32.4 consumes the live channel exclusively — the live-only
  // claim is TRUE, so surfaces may (and should) state it.
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
  // Spec 0.75.1 (BT-36.1/BT-36.2; AC-303, F-47.5, F-10.7): since F-32.9 a bundle can carry the
  // archive's signed statement, which confirms the key archive indicator with NO network
  // request. Offline, only the Bitcoin anchor is always pending; the key archive is pending
  // unless the bundle carries that statement. Copy saying offline leaves both pending, or that
  // going online is what confirms the provider's key, states the pre-F-32.9 model.
  { re: /\b(?:they|which then|both)\s+(?:then\s+)?(?:report|stay|remain)s?\s+pending\b/i, why: "offline described as leaving BOTH indicators pending; a bundle carrying the archive's signed statement confirms the key archive offline (spec 0.75.1, AC-303, F-47.5)" },
  { re: /going online (?:then )?(?:raises a genuine record to PROVIDER KEY CONFIRMED|confirms the provider(?:'|&rsquo;)s key)/i, why: "provider-key confirmation described as online-only; the archive's signed statement confirms it offline (spec 0.75.1, F-10.7, F-32.9)" },
];

describe('verdict-model consistency across surfaces (AC-161 / F-019b regression)', () => {
  for (const rel of SURFACES) {
    it(`${rel} carries no retired pre-F-32 model phrasing`, () => {
      const text = readSurface(rel);
      for (const { re, why } of FORBIDDEN) {
        const m = re.exec(text);
        assert.equal(m, null, m ? `${rel}: retired-model phrasing found (${why}) → "${m[0]}"` : '');
      }
    });
  }
});

// Spec 0.75.1 (AC-303, F-47.5, F-10.7): the page that walks a reader through the tiers states
// the offline rule itself, not only the absence of the old claim.
describe('the technical page states what an offline check leaves pending (spec 0.75.1, BT-36.2)', () => {
  it("frontend/public/how-it-works-technical.html: the Bitcoin anchor pending, the key archive pending unless the bundle carries the archive's signed statement", () => {
    const flat = readSurface('frontend/public/how-it-works-technical.html')
      .replace(/<[^>]+>/g, '')
      .replace(/&rsquo;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ');
    assert.match(flat, /Offline, the Bitcoin anchor reports pending/);
    assert.match(flat, /the key archive reports pending unless the bundle carries the archive's signed statement/);
    assert.match(flat, /PROVIDER KEY CONFIRMED[^.]*with no network request/);
  });
});
