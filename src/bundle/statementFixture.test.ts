/**
 * Regression (plan FC36.5, spec 0.75.1; F-10.7, F-47.5, AC-303; F-32.9, AC-267): a
 * genuine bundle that carries the archive's signed observation statement confirms the
 * key archive OFFLINE, with no network request, on both engines, under the verifier's
 * PINNED production statement key (never a test key set).
 *
 * `docs/test-assets/acme-anvil-waiver-signed-bundle-with-statement.pdf` is a real
 * completed record from the live kysigned.com flow (2026-09-26: redteam-pilot@kysigned.com
 * signed the ACME Anvil waiver). Offline its key-archive indicator is confirmed from the
 * embedded statement, so the tier is PROVIDER KEY CONFIRMED, and its Bitcoin anchor stays
 * pending: only an online run can confirm a block. The CLI and the local MCP pin the same
 * fixture under the network guard (`cli/test/local.test.mjs`, `mcp/src/verifyTool.test.ts`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyBundleWeb } from './verifyWeb.js';
import { verifyBundle } from './verify.js';
import { extractEmbeddedFileMapWeb } from './extractWeb.js';
import { createRfc3161Provider } from '../timestamp/rfc3161/provider.js';
import { verifyWith } from '../timestamp/contract.js';
import type { TimestampProof, VerifyResult } from '../timestamp/contract.js';
import type { BundleVerdict } from './verifyTypes.js';

const FIXTURE = fileURLToPath(
  new URL('../../docs/test-assets/acme-anvil-waiver-signed-bundle-with-statement.pdf', import.meta.url),
);
const bundle = new Uint8Array(readFileSync(FIXTURE));

// Offline timestamp: the embedded RFC 3161 token only, as in signedFixture.test.ts.
const rfc3161Only = async (proof: TimestampProof, hash: Uint8Array): Promise<VerifyResult> =>
  verifyWith([createRfc3161Provider({})], proof, hash);

/** Run a verification with every fetch refused and recorded: offline must make none. */
async function withoutNetwork(run: () => Promise<BundleVerdict>): Promise<{ verdict: BundleVerdict; calls: string[] }> {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    throw new TypeError('fetch refused (offline regression test)');
  }) as typeof fetch;
  try {
    return { verdict: await run(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

function assertConfirmedOffline(engine: string, verdict: BundleVerdict, calls: string[]): void {
  assert.deepEqual(calls, [], `${engine}: no network request`);
  assert.equal(verdict.tier, 'PROVIDER_KEY_CONFIRMED', `${engine}: tier`);
  assert.ok(verdict.signers.length >= 1, `${engine}: signers`);
  for (const s of verdict.signers) {
    assert.equal(s.checks.keyAuthenticity, 'archive-confirmed', `${engine}: the key archive confirmed from the statement`);
    assert.equal(s.assurance.keyProvenance, 'confirmed', `${engine}: provider key confirmed`);
    assert.equal(s.bitcoinAnchor.status, 'pending', `${engine}: the Bitcoin anchor stays pending offline`);
  }
}

describe('statement-carrying signed bundle fixture: the key archive confirmed offline from the embedded statement', () => {
  it('the fixture embeds the archive statement for its signer (F-32.9)', async () => {
    const files = await extractEmbeddedFileMapWeb(bundle);
    assert.ok(files.has('proofs/signer-1-statement.jws'), 'the statement is embedded');
  });

  it('web engine (powers /verify): confirmed with no network request, the Bitcoin anchor pending', async () => {
    const { verdict, calls } = await withoutNetwork(() => verifyBundleWeb(bundle));
    assertConfirmedOffline('web', verdict, calls);
  });

  it('Node engine (the CLI and the local MCP): confirmed with no network request, the Bitcoin anchor pending', async () => {
    const { verdict, calls } = await withoutNetwork(() => verifyBundle(bundle, { verifyTimestamp: rfc3161Only }));
    assertConfirmedOffline('node', verdict, calls);
  });
});
