/**
 * parity.test.ts (F-10.10 / AC-107) — THREE-WAY parity: the web engine
 * (`verifyWeb.ts`, WebCrypto), the reference CLI engine (`verify.ts`, mailauth), and
 * the INDEPENDENT verification toolkit (`scripts/verification-tools/`) must return
 * the IDENTICAL offline verdict for every committed bundle fixture — same per-signer
 * PROVEN/FAILED, same per-check results, and the same `A`.
 *
 * Web and CLI share most of the core but the DKIM step has two engines (Node mailauth
 * vs browser WebCrypto) held equal by differential tests; the toolkit reproduces the
 * verdict independently (it does NOT import any of the three engines), so its
 * agreement is a genuine cross-implementation check — not the same code run twice.
 *
 * Timestamp is pinned to RFC 3161 ONLY (the offline `.tsr`) in all three so the test
 * is deterministic and network-free; the additive online indicators (Bitcoin anchor,
 * key-archive presence) legitimately differ by reachability and are excluded from the
 * offline parity core (F-10.10).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyBundle, type BundleVerdict } from './verify.js';
import { verifyBundleWeb } from './verifyWeb.js';
import { verifyWith } from '../timestamp/contract.js';
import { createRfc3161Provider } from '../timestamp/rfc3161/provider.js';
// The third surface: the independent toolkit (NOT one of the engines under test).
import { verifyBundleIndependently } from '../../scripts/verification-tools/verify-independent.mjs';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'test-assets');
const load = (n: string) => new Uint8Array(readFileSync(join(ASSETS, n)));

const FIXTURES = [
  'sample-bundle.pdf',
  'sample-bundle-tampered-doc.pdf',
  'sample-bundle-tampered-eml.pdf',
  'sample-bundle-tampered-timestamp.pdf',
  'sample-bundle-tampered-signer-email.pdf',
  'sample-bundle-tampered-rendered-page.pdf',
  'sample-bundle-tampered-cover-substitution.pdf',
  'sample-bundle-l-tag.pdf',
];

// The offline parity core: the verdict fields all three engines must agree on. The
// additive online indicators (bitcoinAnchor, keyAuthenticity) are excluded — they
// differ only by reachability and never gate `proven` (F-10.10).
function core(v: BundleVerdict | Awaited<ReturnType<typeof verifyBundleIndependently>>) {
  return {
    proven: v.proven,
    tier: v.tier, // F-32.1 — all three engines must agree on the tier (offline)
    fingerprint: v.fingerprint.computed,
    matchesPrinted: v.fingerprint.matchesPrinted,
    originalDocSha256: v.originalDocSha256,
    signers: v.signers.map((s) => ({
      index: s.index,
      proven: s.proven,
      tier: s.tier,
      assurance: s.assurance, // key provenance / timestamp durability / key validity states
      originalDocSha256: s.originalDocSha256,
      dkim: s.checks.dkim,
      attachment: s.checks.attachment,
      intent: s.checks.intent,
      timestamp: s.checks.timestamp,
    })),
  };
}

describe('three-way parity: web ≡ CLI ≡ toolkit (F-10.10 / AC-107)', () => {
  const rfc = createRfc3161Provider({});
  const ts = { verifyTimestamp: (p: Parameters<typeof verifyWith>[1], h: Uint8Array) => verifyWith([rfc], p, h) };

  for (const f of FIXTURES) {
    it(`${f}: identical offline verdict across all three engines (+ same A)`, async () => {
      const bundle = load(f);
      const node = core(await verifyBundle(bundle, ts));
      const web = core(await verifyBundleWeb(bundle, ts));
      const tools = core(await verifyBundleIndependently(bundle));
      assert.deepEqual(web, node, `web ≡ node for ${f}`);
      assert.deepEqual(tools, node, `toolkit ≡ node for ${f}`);
    });
  }
});
