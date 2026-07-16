/**
 * archiveStatementVectors.test.ts (F-32.8 / AC-168) — the committed interop
 * reference vectors round-trip lock.
 *
 * Two locks:
 *   1. OUTCOME (every vector): each committed vector runs through
 *      `verifyArchiveStatement` and must produce its committed `expect` — so a
 *      drifted verifier (a valid vector stops verifying) or a corrupted vector
 *      fails the build. This is what the archive team's prototype signer diffs
 *      against.
 *   2. GENERATOR-REPRODUCES (deterministic subset): re-run the generator's pure
 *      `buildVectors()` and assert the `deterministic: true` (EdDSA — RFC 8032
 *      deterministic) vectors byte-equal the committed file — so a drifted
 *      generator fails the build. ES256 / freshly-minted-stranger vectors are
 *      randomized (`deterministic: false`) and are covered by lock 1 only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyArchiveStatement, type ArchiveJwks } from './archiveStatement.js';
import { buildVectors } from '../../scripts/gen-archive-statement-vectors.mjs';

interface Vector {
  name: string;
  deterministic: boolean;
  jws: string;
  expect:
    | { ok: true; kid: string; domain: string; source: string }
    | { ok: false; reason: string };
}
interface VectorFile { jwks: ArchiveJwks; vectors: Vector[] }

const committed = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../docs/test-assets/archive-statement-vectors.json', import.meta.url)), 'utf8'),
) as VectorFile;

describe('archive-statement vectors — outcome lock (AC-168)', () => {
  assert.ok(committed.vectors.length >= 10, 'the committed kit covers the accept + reject matrix');
  for (const v of committed.vectors) {
    it(`${v.name} → ${v.expect.ok ? 'accept' : `reject:${v.expect.reason}`}`, async () => {
      const r = await verifyArchiveStatement(v.jws, committed.jwks);
      assert.equal(r.ok, v.expect.ok);
      if (r.ok && v.expect.ok) {
        assert.equal(r.kid, v.expect.kid);
        assert.equal(r.record.domain, v.expect.domain);
        assert.equal(r.record.source, v.expect.source);
      } else if (!r.ok && !v.expect.ok) {
        assert.equal(r.reason, v.expect.reason);
      }
    });
  }
});

describe('archive-statement vectors — generator reproduces the committed deterministic subset (AC-168)', () => {
  it('re-running buildVectors() byte-reproduces every deterministic (EdDSA) vector + the JWKS', async () => {
    const fresh = (await buildVectors()) as VectorFile;
    // JWKS is fixed (hardcoded test keys) → must match exactly.
    assert.deepEqual(fresh.jwks, committed.jwks, 'pinned JWKS drifted from the generator');
    const freshByName = new Map(fresh.vectors.map((v) => [v.name, v]));
    for (const v of committed.vectors.filter((x) => x.deterministic)) {
      const f = freshByName.get(v.name);
      assert.ok(f, `generator no longer emits ${v.name}`);
      assert.equal(f.jws, v.jws, `deterministic vector ${v.name} drifted between generator and committed file`);
    }
  });

  it('the non-deterministic vectors are present in both (checked by outcome, not bytes)', async () => {
    const fresh = (await buildVectors()) as VectorFile;
    const freshNames = new Set(fresh.vectors.map((v) => v.name));
    for (const v of committed.vectors.filter((x) => !x.deterministic)) {
      assert.ok(freshNames.has(v.name), `generator no longer emits ${v.name}`);
    }
  });
});
