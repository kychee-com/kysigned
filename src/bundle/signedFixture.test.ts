/**
 * Regression: the committed real signed bundle must stay PROVEN, fully offline
 * (AC-27), on BOTH verify engines.
 *
 * `docs/test-assets/acme-anvil-waiver-signed-bundle.pdf` is a genuine Amazon-SES-signed
 * bundle (info@kysigned.com signed the acme-anvil-waiver trial document via the live
 * flow), produced by `the operator's private fixture builder`. Because
 * it is real SES mail it carries TWO DKIM signatures — the sending-domain key
 * (d=kysigned.com, From-aligned) AND Amazon's own d=amazonses.com co-signature, whose
 * key is absent from keys.json. A single-signature web verifier latched onto the
 * amazonses one and reported `missing_key` (live /verify showed FAILED while the Node
 * CLI showed PROVEN); this fixture pins the web/Node verdicts together on real
 * multi-signature mail so that divergence can't come back.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyBundleWeb } from './verifyWeb.js';
import { verifyBundle } from './verify.js';
import { runVerifyCli } from './verifyCli.js';
import { extractEmbeddedFileMapWeb } from './extractWeb.js';
import { createRfc3161Provider } from '../timestamp/rfc3161/provider.js';
import { verifyWith } from '../timestamp/contract.js';
import type { TimestampProof, VerifyResult } from '../timestamp/contract.js';

const FIXTURE = fileURLToPath(new URL('../../docs/test-assets/acme-anvil-waiver-signed-bundle.pdf', import.meta.url));
const bundle = new Uint8Array(readFileSync(FIXTURE));

// Offline timestamp: verify the embedded RFC 3161 `.tsr` only (no OTS/Bitcoin
// network), matching the browser engine's default — keeps the test hermetic.
const rfc3161Only = async (proof: TimestampProof, hash: Uint8Array): Promise<VerifyResult> =>
  verifyWith([createRfc3161Provider({})], proof, hash);

describe('signed bundle fixture — stays PROVEN offline on both engines', () => {
  it('web engine (powers /verify): PROVEN despite the d=amazonses.com co-signature', async () => {
    const v = await verifyBundleWeb(bundle);
    assert.equal(v.proven, true, `web reasons: ${JSON.stringify(v.signers?.[0]?.reasons)}`);
    assert.equal(v.signers[0].checks.dkim, true, 'DKIM must verify via the aligned kysigned.com signature');
    assert.equal(v.signers[0].signingDomain, 'kysigned.com');
    assert.equal(v.signers[0].email, 'info@kysigned.com');
    assert.equal(v.fingerprint.matchesPrinted, true);
  });

  it('Node engine: identical PROVEN verdict (web/Node parity on a real SES bundle)', async () => {
    const v = await verifyBundle(bundle, { verifyTimestamp: rfc3161Only });
    assert.equal(v.proven, true, `node reasons: ${JSON.stringify(v.signers?.[0]?.reasons)}`);
    assert.equal(v.signers[0].checks.dkim, true);
    assert.equal(v.signers[0].signingDomain, 'kysigned.com');
  });

  it('CLI --offline: INTEGRITY VERIFIED (exit 0) with the Bitcoin anchor + key archive reported pending', async () => {
    const { exitCode, report } = await runVerifyCli(bundle, { offline: true });
    assert.equal(exitCode, 0, report);
    // Offline the honest tier is INTEGRITY VERIFIED: provenance pending (archive gate
    // is online, 51.6) and durability pending (Bitcoin confirmed online). Still exit 0.
    assert.match(report, /OVERALL: INTEGRITY VERIFIED/);
    assert.match(report, /Bitcoin timestamp: pending/);
    assert.match(report, /Key archive: pending/); // offline → no archive lookup
  });

  it('CLI online: a key present in the archive → "Key archive: confirmed"; Bitcoin stubbed pending (additive, hermetic)', async () => {
    // The fixture's key (kysigned.com) IS in the live archive; a fake archive returning
    // the EXACT embedded key + a failing Bitcoin source keep this hermetic (no real
    // network). `offline` is unset, so BOTH online steps run — here against fakes.
    const files = await extractEmbeddedFileMapWeb(bundle);
    const keysJson = JSON.parse(new TextDecoder().decode(files.get('keys.json')!)) as { keys: { record: string }[] };
    const embeddedKey = keysJson.keys[0].record;
    const fakeArchive = (async () => ({
      ok: true,
      status: 200,
      json: async () => [{ domain: 'kysigned.com', selector: 'x', value: embeddedKey, firstSeenAt: '2026-06-29T11:42:02.820Z' }],
    })) as unknown as typeof fetch;
    const failFetch = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    const { exitCode, report } = await runVerifyCli(bundle, {
      archiveDeps: { fetchFn: fakeArchive },
      // No calendar upgrade + a throwing header source → the embedded proof stays pending, no network.
      bitcoinDeps: { fetchFn: failFetch, headerSource: { getBlockHeader: async () => { throw new Error('offline'); } } },
    });
    assert.equal(exitCode, 0, report);
    assert.match(report, /Key archive: confirmed/);
    assert.match(report, /registered 2026-06-29/);
    assert.match(report, /Bitcoin timestamp: pending/);
  });
});

// LIVE (gated): the CLI, online with NO fakes, must confirm BOTH the key archive and
// the Bitcoin anchor over the real fixture — proving web ≡ CLI (the verify page already
// shows both green). Hits archive.prove.email + the OTS calendars + a Bitcoin block.
const ONLINE = process.env.KYSIGNED_ONLINE_E2E === '1';
describe('signed bundle fixture — LIVE CLI online (gated; real archive + real Bitcoin)', () => {
  it(
    'web ≡ CLI: runVerifyCli (online) confirms BOTH the key archive AND the Bitcoin anchor',
    { skip: ONLINE ? false : 'set KYSIGNED_ONLINE_E2E=1 to run (hits archive.prove.email + OTS/Bitcoin)' },
    async () => {
      const { exitCode, report } = await runVerifyCli(bundle); // online, no fakes
      assert.equal(exitCode, 0, report);
      // Phase A/B: the online step confirms the archive-presence + Bitcoin badges, but
      // the tier stays INTEGRITY VERIFIED until the provenance GATE (51.6) + validity
      // window (51.7) recompute it online — they will raise this to PROVIDER KEY
      // CONFIRMED / PROVEN (DURABLE).
      assert.match(report, /OVERALL: INTEGRITY VERIFIED/, report);
      assert.match(report, /Key archive: confirmed/, report);
      assert.match(report, /Bitcoin timestamp: confirmed \(block \d+/, report);
    },
  );
});
