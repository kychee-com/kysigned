/**
 * Bundle verifier tests — F-10.3 (AC-27/28/29/59/64), spec v0.4.0.
 *
 * Assembles genuinely DKIM-signed bundles (offline generated key) and runs the
 * verifier on the valid bundle + each tamper class, fully offline (DKIM against the
 * embedded keys.json; timestamps via an injected fake provider). Proves: a valid
 * bundle is PROVEN with the fingerprint matching the printed value; each tamper
 * (document swap / `.eml` byte / timestamp / wrong key) yields FAILED naming the
 * broken check; the verdict is derived from the embedded `.eml` (AC-28e); and the
 * key-authenticity join confirms / rejects on the archive window (AC-59).
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
import { createFakeProvider } from '../timestamp/fake.js';
import type { AssembleBundleInput, BundleSignerInput } from './types.js';
import type { TimestampProof, VerifyResult } from '../timestamp/contract.js';

const FAKE_TIME = 1_780_000_000;
const fake = createFakeProvider({ timeSec: FAKE_TIME });
// Timestamp seam: the engine reconstructs proofs with provider 'ots'/'rfc3161'
// (for real verifyWith routing); the fake provider gates on provider==='fake', so
// this test adapter normalizes it before delegating.
const verifyTimestamp = async (proof: TimestampProof, hash: Uint8Array): Promise<VerifyResult> =>
  fake.verify({ ...proof, provider: 'fake' }, hash);

let privateKey = '';
let txtRecord = '';
let docA: Uint8Array;
let docB: Uint8Array;
let coverA: Uint8Array; // Family B: a valid per-signer cover PDF (page 1 of P_i)

before(async () => {
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKey = kp.privateKey;
  txtRecord = `v=DKIM1; k=rsa; p=${kp.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')}`;
  docA = await makeDoc('DOCUMENT A clause one');
  docB = await makeDoc('DOCUMENT B different');
  coverA = await makeDoc('COVER PAGE for the signer');
});

/** Family B: the signer signs P = cover ++ D, so their forward attaches P (not D). */
async function emlP(email: string, doc: Uint8Array, domain = 'example.com'): Promise<Uint8Array> {
  return signEml(email, await assembleCanonicalPdf(coverA, doc), domain);
}

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

function buildForward(from: string, pdf: Uint8Array): string {
  return [
    `From: ${from}`,
    'To: forward-to-sign@kysigned.com',
    'Subject: Fwd: Please sign',
    'Date: Sat, 14 Jun 2026 10:00:00 +0000',
    `Message-ID: <fwd-${from}@example.com>`,
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

async function signEml(from: string, pdf: Uint8Array, domain = 'example.com'): Promise<Uint8Array> {
  const raw = buildForward(from, pdf);
  const res = await dkimSign(raw, {
    canonicalization: 'relaxed/relaxed',
    signTime: new Date('2026-06-14T10:00:00Z'),
    signatureData: [{ signingDomain: domain, selector: 'test', privateKey, algorithm: 'rsa-sha256' }],
  });
  return new Uint8Array(Buffer.from(res.signatures + raw, 'latin1'));
}

async function makeSigner(
  index: number,
  email: string,
  rawEml: Uint8Array,
  over: Partial<BundleSignerInput> = {},
): Promise<BundleSignerInput> {
  const tsHash = over.emlSha256
    ? Buffer.from(over.emlSha256, 'hex')
    : createHash('sha256').update(rawEml).digest();
  return {
    index,
    name: `Signer ${index}`,
    email,
    onBehalfOf: null,
    signingDomain: 'example.com',
    selector: 'test',
    signedAt: new Date('2026-06-14T10:00:00Z'),
    emlSha256: createHash('sha256').update(rawEml).digest('hex'),
    rawEml,
    cover: coverA,
    dkimKey: txtRecord,
    dkimObservedAt: new Date('2026-06-14T10:00:01Z'),
    archiveStatus: 'archived',
    otsProof: await fake.stamp(tsHash),
    tsaToken: await fake.stamp(tsHash),
    verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' },
    ...over,
  };
}

function inputFor(documentOriginal: Uint8Array, signers: BundleSignerInput[]): AssembleBundleInput {
  return {
    envelope: {
      id: '18267982-ca76-45dc-a294-e86039a6343d',
      documentName: 'NDA',
      documentHash: 'd'.repeat(64),
      creatorEmail: 'creator@acme.com',
      completedAt: new Date('2026-06-14T12:00:00Z'),
    },
    documentOriginal,
    signers,
    verifierBaseUrl: 'https://kysigned.com',
  };
}

describe('verifyBundle — valid bundle (AC-27/29/64)', () => {
  it('returns PROVEN with the fingerprint matching the printed value, verdict from the .eml', async () => {
    const eml = await emlP('alice@example.com', docA);
    const { bytes } = await assembleBundle(inputFor(docA, [await makeSigner(1, 'alice@example.com', eml)]));

    const v = await verifyBundle(bytes, { verifyTimestamp });
    assert.equal(v.proven, true);
    assert.equal(v.fingerprint.matchesPrinted, true, 'recomputed fingerprint matches the printed one (AC-64)');
    assert.equal(v.signers.length, 1);
    const s = v.signers[0];
    assert.equal(s.proven, true);
    assert.deepEqual(s.checks, { dkim: true, attachment: true, intent: true, timestamp: true, keyAuthenticity: 'pending-online' });
    // Verdict derived from the embedded evidence, not the rendered page (AC-28e).
    assert.equal(s.email, 'alice@example.com');
    assert.equal(s.signingDomain, 'example.com');
    assert.equal(s.verbatimIntent, 'I sign this document');
  });
});

describe('verifyBundle — assurance tiers (F-32.1, #137)', () => {
  it('a valid bundle with no independent provenance + a non-durable timestamp lands at INTEGRITY_VERIFIED, not the top tier', async () => {
    const eml = await emlP('alice@example.com', docA);
    const { bytes } = await assembleBundle(inputFor(docA, [await makeSigner(1, 'alice@example.com', eml)]));
    const v = await verifyBundle(bytes, { verifyTimestamp });
    // proven (integrity) still true — but the honest tier is INTEGRITY_VERIFIED.
    assert.equal(v.proven, true);
    assert.equal(v.tier, 'INTEGRITY_VERIFIED');
    const s = v.signers[0];
    assert.equal(s.tier, 'INTEGRITY_VERIFIED');
    // The tier caps at INTEGRITY_VERIFIED: no independent key provenance (Phase C),
    // no authenticated validity window (Phase D), and durability is pending because
    // the fixture's fake OTS is not block-anchored (F-32.2 requires a real Bitcoin
    // block for durable) — the honest fix for the #137 over-claim.
    assert.deepEqual(s.assurance, {
      keyProvenance: 'pending',
      timestampDurability: 'pending', // fake OTS has no Bitcoin block → provisional, not durable
      keyValidity: 'inconclusive',
    });
  });

  it('any hard-check tamper drives the tier to FAILED (never a downgraded tier)', async () => {
    const eml = await emlP('alice@example.com', docA);
    const { bytes } = await assembleBundle(inputFor(docB, [await makeSigner(1, 'alice@example.com', eml)])); // doc swap
    const v = await verifyBundle(bytes, { verifyTimestamp });
    assert.equal(v.tier, 'FAILED');
    assert.equal(v.signers[0].tier, 'FAILED');
    assert.equal(v.proven, false);
  });
});

describe('verifyBundle — tamper matrix (AC-28/29)', () => {
  it('(a) document swapped: attachment no longer matches → FAILED', async () => {
    const eml = await emlP('alice@example.com', docA); // .eml attached docA
    const { bytes } = await assembleBundle(inputFor(docB, [await makeSigner(1, 'alice@example.com', eml)])); // bundle ships docB
    const v = await verifyBundle(bytes, { verifyTimestamp });
    assert.equal(v.proven, false);
    assert.equal(v.signers[0].checks.attachment, false);
    assert.ok(v.signers[0].reasons.some((r) => /attachment/.test(r)));
  });

  it('(b) a flipped .eml byte breaks DKIM and the timestamp → FAILED', async () => {
    const eml = await emlP('alice@example.com', docA);
    const tampered = new Uint8Array(eml);
    tampered[tampered.length - 5] ^= 0x01;
    const { bytes } = await assembleBundle(inputFor(docA, [await makeSigner(1, 'alice@example.com', tampered)]));
    const v = await verifyBundle(bytes, { verifyTimestamp });
    assert.equal(v.proven, false);
    assert.equal(v.signers[0].checks.dkim, false);
  });

  it('(c) a timestamp proof over the wrong hash → timestamp FAILED', async () => {
    const eml = await emlP('alice@example.com', docA);
    // Stamp the proofs over a DIFFERENT hash than sha256(.eml).
    const wrong = await makeSigner(1, 'alice@example.com', eml, { emlSha256: 'b'.repeat(64) });
    const { bytes } = await assembleBundle(inputFor(docA, [wrong]));
    const v = await verifyBundle(bytes, { verifyTimestamp });
    assert.equal(v.signers[0].checks.timestamp, false);
    assert.equal(v.proven, false);
  });

  it('(d) wrong key in keys.json → DKIM FAILED', async () => {
    const eml = await emlP('alice@example.com', docA);
    const badKey = await makeSigner(1, 'alice@example.com', eml, { dkimKey: 'v=DKIM1; k=rsa; p=WRONGKEYAAAB' });
    const { bytes } = await assembleBundle(inputFor(docA, [badKey]));
    const v = await verifyBundle(bytes, { verifyTimestamp });
    assert.equal(v.signers[0].checks.dkim, false);
    assert.equal(v.proven, false);
  });

  it('(e) Family B: a tampered cover breaks reconstruction → attachment FAILED', async () => {
    // The signer signed P = coverA ++ docA, but the bundle ships a DIFFERENT cover
    // → reconstruct(tamperedCover ++ docA) ≠ the .eml attachment → FAILED. This is
    // the operator-forgery defense: you cannot show one signer a different cover.
    const eml = await emlP('alice@example.com', docA);
    const tamperedCover = await makeDoc('A DIFFERENT COVER');
    const { bytes } = await assembleBundle(inputFor(docA, [await makeSigner(1, 'alice@example.com', eml, { cover: tamperedCover })]));
    const v = await verifyBundle(bytes, { verifyTimestamp });
    assert.equal(v.proven, false);
    assert.equal(v.signers[0].checks.attachment, false);
  });
});

describe('verifyBundle — key-archive presence (F-10.7, DD-16): additive, never gates proven', () => {
  it('an unconfirmed / absent key is pending-online and NEVER fails the bundle (no red key state)', async () => {
    const eml = await emlP('alice@example.com', docA);
    const { bytes } = await assembleBundle(inputFor(docA, [await makeSigner(1, 'alice@example.com', eml)]));
    // Offline (no online archive lookup) a valid bundle is PROVEN and the key check
    // is `pending-online` — never `failed`. DD-16: presence-not-window; the archive
    // check is the online step's job (confirmKeyArchive) and never gates the verdict.
    const v = await verifyBundle(bytes, { verifyTimestamp });
    assert.equal(v.signers[0].checks.keyAuthenticity, 'pending-online');
    assert.equal(v.signers[0].proven, true);
    assert.equal(v.proven, true);
  });
});
