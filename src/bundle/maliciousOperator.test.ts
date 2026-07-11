/**
 * maliciousOperator.test.ts (F-32.1 / AC-153, #136/#137) — the permanent
 * regression that the #136 forgery cannot buy provider-key assurance from mere
 * internal consistency.
 *
 * A malicious operator mints its OWN keypair, claims the public key belongs to a
 * third-party provider (gmail.com) it does not control, DKIM-signs a fabricated
 * "I sign this document" email with the matching private key, timestamps it, and
 * assembles a self-consistent bundle. The DKIM signature verifies against the
 * bundled (attacker) key, so the offline math is internally valid — but there is
 * no independent provenance that the key was gmail's. The verdict must therefore
 * cap at INTEGRITY VERIFIED (never PROVIDER KEY CONFIRMED or PROVEN (DURABLE)),
 * identically on the Node engine, the browser engine, and the independent toolkit.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { PDFDocument } from 'pdf-lib';
import { dkimSign } from 'mailauth';
import { assembleBundle } from './assembleBundle.js';
import { assembleCanonicalPdf } from '../pdf/assembleCanonicalPdf.js';
import { verifyBundle } from './verify.js';
import { verifyBundleWeb } from './verifyWeb.js';
import { verifyBundleIndependently } from '../../scripts/verification-tools/verify-independent.mjs';
import { createFakeProvider } from '../timestamp/fake.js';
import type { AssembleBundleInput, BundleSignerInput } from './types.js';
import type { TimestampProof, VerifyResult } from '../timestamp/contract.js';

const fake = createFakeProvider({ timeSec: 1_780_000_000 });
const verifyTimestamp = async (p: TimestampProof, h: Uint8Array): Promise<VerifyResult> =>
  fake.verify({ ...p, provider: 'fake' }, h);

let attackerKey = '';
let attackerTxt = '';
let doc: Uint8Array;
let cover: Uint8Array;

async function makeDoc(text: string): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.setCreationDate(new Date('2026-06-14T00:00:00Z'));
  d.setModificationDate(new Date('2026-06-14T00:00:00Z'));
  d.addPage([612, 792]).drawText(text);
  return new Uint8Array(await d.save({ useObjectStreams: false }));
}

function b64(bytes: Uint8Array): string {
  return (Buffer.from(bytes).toString('base64').match(/.{1,64}/g) ?? []).join('\r\n');
}

/** A forwarded "I sign this document" email with the canonical PDF attached. */
function buildForward(from: string, pdf: Uint8Array): string {
  return [
    `From: ${from}`,
    'To: forward-to-sign@kysigned.com',
    'Subject: Re: Please sign',
    `Message-ID: <fwd-${from}@mail>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: text/plain; charset=us-ascii',
    '',
    'I sign this document',
    '',
    '--B',
    'Content-Type: application/pdf; name="d.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="d.pdf"',
    '',
    b64(pdf),
    '--B--',
    '',
  ].join('\r\n');
}

/** DKIM-sign a forward with the ATTACKER key, but under the CLAIMED provider domain. */
async function signAs(from: string, pdf: Uint8Array, claimedDomain: string): Promise<Uint8Array> {
  const raw = buildForward(from, pdf);
  const res = await dkimSign(raw, {
    canonicalization: 'relaxed/relaxed',
    signTime: new Date('2026-06-14T10:00:00Z'),
    signatureData: [{ signingDomain: claimedDomain, selector: 'test', privateKey: attackerKey, algorithm: 'rsa-sha256' }],
  });
  return new Uint8Array(Buffer.from(res.signatures + raw, 'latin1'));
}

before(async () => {
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  attackerKey = kp.privateKey;
  attackerTxt = `v=DKIM1; k=rsa; p=${kp.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')}`;
  doc = await makeDoc('A CONTRACT THE VICTIM NEVER SIGNED');
  cover = await makeDoc('COVER for alice@gmail.com');
});

/** Build the forged bundle: signer claims gmail.com, but the key is the attacker's. */
async function forgedBundle(): Promise<Uint8Array> {
  const eml = await signAs('alice@gmail.com', await assembleCanonicalPdf(cover, doc), 'gmail.com');
  const emlHash = createHash('sha256').update(eml).digest();
  const signer: BundleSignerInput = {
    index: 1,
    name: 'Alice',
    email: 'alice@gmail.com',
    onBehalfOf: null,
    signingDomain: 'gmail.com', // claimed — the operator does not control gmail's DNS
    selector: 'test',
    signedAt: new Date('2026-06-14T10:00:00Z'),
    emlSha256: emlHash.toString('hex'),
    rawEml: eml,
    cover,
    dkimKey: attackerTxt, // the ATTACKER's key, embedded as if it were gmail's
    dkimObservedAt: new Date('2026-06-14T10:00:01Z'),
    archiveStatus: 'archived', // operator-authored — must NOT be treated as evidence
    otsProof: await fake.stamp(emlHash),
    tsaToken: await fake.stamp(emlHash),
    verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' },
  };
  const input: AssembleBundleInput = {
    envelope: {
      id: '11111111-2222-3333-4444-555555555555',
      documentName: 'Forged NDA',
      documentHash: 'd'.repeat(64),
      creatorEmail: 'attacker@evil.example',
      completedAt: new Date('2026-06-14T12:00:00Z'),
    },
    documentOriginal: doc,
    signers: [signer],
    verifierBaseUrl: 'https://kysigned.com',
  };
  return (await assembleBundle(input)).bytes;
}

describe('malicious-operator forgery caps at INTEGRITY VERIFIED (F-32.1 / AC-153)', () => {
  it('is internally self-consistent (DKIM verifies against the embedded self-minted key)', async () => {
    const v = await verifyBundle(await forgedBundle(), { verifyTimestamp });
    // The forgery IS internally valid — that is precisely why the old binary PROVEN was dangerous.
    assert.equal(v.signers[0].checks.dkim, true, 'DKIM verifies against the bundled attacker key');
    assert.equal(v.signers[0].checks.attachment, true);
    assert.equal(v.signers[0].checks.intent, true);
    assert.equal(v.signers[0].checks.timestamp, true);
  });

  it('caps at INTEGRITY VERIFIED (node + web) and never reaches provider-key assurance on ANY surface', async () => {
    const bundle = await forgedBundle();
    const node = await verifyBundle(bundle, { verifyTimestamp });
    const web = await verifyBundleWeb(bundle, { verifyTimestamp });
    // Node + web take the injected timestamp verifier, so EVERY hard check passes —
    // the forgery is fully self-consistent — and it STILL caps at INTEGRITY VERIFIED,
    // because provenance is pending (no independent confirmation the key was gmail's).
    // This is the exact overclaim the old binary PROVEN produced, now fixed.
    for (const [name, v] of [['node', node], ['web', web]] as const) {
      assert.equal(v.tier, 'INTEGRITY_VERIFIED', `${name}: self-consistent forgery caps at INTEGRITY_VERIFIED`);
      assert.equal(v.signers[0].tier, 'INTEGRITY_VERIFIED', `${name}`);
      assert.equal(v.signers[0].assurance.keyProvenance, 'pending', `${name}: provenance never confirmed for a self-minted key`);
    }
    // The independent toolkit uses a real RFC-3161 verifier (no injection — that is
    // its independence), so it cannot verify the fixture's test-fake timestamp and
    // reports FAILED — still below provider-key assurance. The invariant that matters
    // holds on ALL three surfaces: a forgery NEVER reaches PROVIDER KEY CONFIRMED or
    // PROVEN (DURABLE) from internal consistency alone (AC-153).
    const tools = await verifyBundleIndependently(bundle);
    for (const [name, v] of [['node', node], ['web', web], ['toolkit', tools]] as const) {
      assert.notEqual(v.tier, 'PROVIDER_KEY_CONFIRMED', `${name} must not reach PROVIDER KEY CONFIRMED`);
      assert.notEqual(v.tier, 'PROVEN_DURABLE', `${name} must not reach PROVEN (DURABLE)`);
      assert.notEqual(v.signers[0]?.assurance.keyProvenance, 'confirmed', `${name}: provenance never confirmed`);
    }
  });
});
