/**
 * testAssets.test.ts — asset-regression for the committed evidence-bundle test
 * assets in `docs/test-assets/` (system-test cycle-1 TR-003 / FC1.3).
 *
 * The Red Team is code-blind and external; it verifies these committed PDFs by
 * dropping them on the deployed `/verify` page (and the CLI verifier). This test
 * is the oracle + the permanent regression net: it runs the REAL verifier engine
 * (verifyBundle with the default real timestamp verification) over each committed
 * asset and asserts the expected verdict — so the assets can never silently drift
 * from the assembler, and a Red Team verdict that disagrees with this file is a
 * real product regression, not a stale fixture.
 *
 * Fully OFFLINE: the embedded RFC-3161 `.tsr` token verifies offline (pkijs, the
 * TSA-signed time needs no network), which satisfies the timestamp check on its
 * own; the key-authenticity join is left `pending-online` (no archive resolver
 * injected), exactly as the offline `/verify` reports it. Regenerate the assets
 * with `node --import tsx scripts/gen-test-assets.mjs` if the bundle format changes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyBundle } from './verify.js';
import { extractEmbeddedFileMap } from './extract.js';
import { checkOriginalInArtifact } from './hashCheck.js';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'test-assets');

function load(name: string): Uint8Array {
  const p = join(ASSETS, name);
  assert.ok(existsSync(p), `missing committed asset ${name} — run scripts/gen-test-assets.mjs`);
  return new Uint8Array(readFileSync(p));
}

describe('committed evidence-bundle test assets (TR-003 / FC1.3)', () => {
  it('sample-bundle.pdf — VALID: PROVEN, fingerprint matches, both signers proven', async () => {
    const v = await verifyBundle(load('sample-bundle.pdf'));
    assert.equal(v.proven, true, `expected PROVEN, reasons: ${JSON.stringify(v.signers.map((s) => s.reasons))}`);
    assert.equal(v.fingerprint.matchesPrinted, true, 'fingerprint must match the printed value');
    assert.equal(v.signers.length, 2, 'two signers');
    for (const s of v.signers) {
      assert.equal(s.proven, true, `signer ${s.index} proven`);
      assert.equal(s.checks.dkim, true);
      assert.equal(s.checks.attachment, true);
      assert.equal(s.checks.intent, true);
      assert.equal(s.checks.timestamp, true, `signer ${s.index} timestamp (.tsr offline)`);
    }
    // Evidence-derived identities (AC-28e): the verdict reads the .eml, not the page.
    assert.equal(v.signers[0].email, 'alice@redteam.kysigned.test');
    assert.equal(v.signers[1].email, 'bob@redteam.kysigned.test');
    assert.equal(v.signers[0].verbatimIntent, 'I sign this document');
  });

  it('sample-bundle-tampered-doc.pdf — FAILED: attachment mismatch (document bytes swapped)', async () => {
    const v = await verifyBundle(load('sample-bundle-tampered-doc.pdf'));
    assert.equal(v.proven, false);
    // Both signers' reconstructions break against the swapped document-original.
    assert.ok(v.signers.some((s) => s.checks.attachment === false));
    assert.ok(v.signers.some((s) => s.reasons.some((r) => /attachment/.test(r))));
  });

  it('sample-bundle-tampered-eml.pdf — FAILED: signer 1 DKIM + timestamp broken (flipped .eml byte)', async () => {
    const v = await verifyBundle(load('sample-bundle-tampered-eml.pdf'));
    assert.equal(v.proven, false);
    // A byte flipped in the DKIM b= value breaks the signature, and sha256(.eml)
    // no longer matches the stamped hash, so the timestamp fails too.
    assert.equal(v.signers[0].checks.dkim, false, 'flipped .eml byte breaks DKIM');
    assert.equal(v.signers[0].checks.timestamp, false, 'sha256(.eml) no longer matches the stamped hash');
  });

  it('sample-bundle-tampered-timestamp.pdf — FAILED: signer 1 timestamp over the wrong hash', async () => {
    const v = await verifyBundle(load('sample-bundle-tampered-timestamp.pdf'));
    assert.equal(v.proven, false);
    assert.equal(v.signers[0].checks.timestamp, false);
  });

  it('sample-bundle-tampered-signer-email.pdf — FAILED: signer 1 key mismatch (DKIM fails)', async () => {
    const v = await verifyBundle(load('sample-bundle-tampered-signer-email.pdf'));
    assert.equal(v.proven, false);
    assert.equal(v.signers[0].checks.dkim, false);
  });

  it('sample-bundle-tampered-rendered-page.pdf — PROVEN: rendered page altered, verdict still from the .eml (AC-28e)', async () => {
    // The displayed name differs, but the embedded .eml/email/intent are unchanged,
    // so the verifier — which reads the evidence, not the page — still PROVES both.
    const v = await verifyBundle(load('sample-bundle-tampered-rendered-page.pdf'));
    assert.equal(v.proven, true, `expected PROVEN, reasons: ${JSON.stringify(v.signers.map((s) => s.reasons))}`);
    assert.equal(v.signers[0].email, 'alice@redteam.kysigned.test', 'identity comes from the .eml');
  });

  it('sample-bundle-tampered-cover-substitution.pdf — FAILED: signer 1 cover substituted (reconstruction mismatch)', async () => {
    const v = await verifyBundle(load('sample-bundle-tampered-cover-substitution.pdf'));
    assert.equal(v.proven, false);
    assert.equal(v.signers[0].checks.attachment, false, 'cover substitution breaks reconstruction (operator-forgery defense)');
  });

  it('sample-bundle-l-tag.pdf — FAILED: signer 1 carries an l= DKIM tag (AC-3)', async () => {
    const v = await verifyBundle(load('sample-bundle-l-tag.pdf'));
    assert.equal(v.proven, false);
    assert.equal(v.signers[0].checks.dkim, false, 'an l= length-limited signature must be rejected');
    assert.ok(
      v.signers[0].reasons.some((r) => /body_length_tag|l=/i.test(r)),
      `expected an l=-tag rejection reason, got: ${JSON.stringify(v.signers[0].reasons)}`,
    );
  });
});

describe('/hashcheck original-document confirmation assets (F-25 / AC-112)', () => {
  it('final package (byte-exact): the standalone original matches the bundle embedded document-original', async () => {
    const r = await checkOriginalInArtifact(
      load('sample-document-original.pdf'),
      load('sample-bundle.pdf'),
      extractEmbeddedFileMap,
    );
    assert.equal(r.kind, 'bundle');
    assert.equal(r.guarantee, 'byte-exact');
    assert.equal(r.match, true, `expected byte-exact match: ${r.reason}`);
    assert.equal(r.originalSha256, r.foundSha256);
  });

  it('final package: a different original does NOT match the genuine bundle', async () => {
    // The tampered-doc bundle embeds a DIFFERENT document D; that D must not match
    // the genuine bundle's embedded document-original.
    const wrong = (await extractEmbeddedFileMap(load('sample-bundle-tampered-doc.pdf'))).get(
      'document-original.pdf',
    );
    assert.ok(wrong, 'tampered-doc bundle must embed a document-original');
    const r = await checkOriginalInArtifact(wrong!, load('sample-bundle.pdf'), extractEmbeddedFileMap);
    assert.equal(r.kind, 'bundle');
    assert.equal(r.match, false);
  });

  it('sign-request (content-level): the original matches the document inside the sign-request PDF', async () => {
    const r = await checkOriginalInArtifact(
      load('sample-document-original.pdf'),
      load('sample-sign-request.pdf'),
      extractEmbeddedFileMap,
    );
    assert.equal(r.kind, 'sign-request');
    assert.equal(r.guarantee, 'content-level');
    assert.equal(r.match, true, `expected content match: ${r.reason}`);
  });

  it('sign-request: a tampered sign-request (different document inside) does NOT match', async () => {
    const r = await checkOriginalInArtifact(
      load('sample-document-original.pdf'),
      load('sample-sign-request-tampered-doc.pdf'),
      extractEmbeddedFileMap,
    );
    assert.equal(r.kind, 'sign-request');
    assert.equal(r.match, false);
  });
});
