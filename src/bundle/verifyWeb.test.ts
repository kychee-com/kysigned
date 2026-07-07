/**
 * DIFFERENTIAL test — the browser engine (verifyBundleWeb, WebCrypto) MUST return
 * the IDENTICAL verdict to the Node engine (verifyBundle, mailauth) on a real
 * 2-signer bundle and on every tamper. This is what lets the fully-client-side web
 * verifier (AC-27) sit on the trust boundary: it is provably equivalent to the
 * vetted Node path, both reading the same embedded evidence.
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
import { createFakeProvider } from '../timestamp/fake.js';
import type { BundleVerdict } from './verifyTypes.js';
import type { AssembleBundleInput, BundleSignerInput } from './types.js';
import type { TimestampProof, VerifyResult } from '../timestamp/contract.js';

const FAKE_TIME = 1_780_000_000;
const fake = createFakeProvider({ timeSec: FAKE_TIME });
const verifyTimestamp = async (proof: TimestampProof, hash: Uint8Array): Promise<VerifyResult> =>
  fake.verify({ ...proof, provider: 'fake' }, hash);

let privateKey = '';
let txtRecord = '';
let docA: Uint8Array;
let docB: Uint8Array;
let coverA: Uint8Array; // Family B: a valid per-signer cover PDF

before(async () => {
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKey = kp.privateKey;
  txtRecord = `v=DKIM1; k=rsa; p=${kp.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')}`;
  docA = await makeDoc('DOCUMENT A');
  docB = await makeDoc('DOCUMENT B');
  coverA = await makeDoc('COVER PAGE');
});

/** Family B: the signer signs P = cover ++ D, so their forward attaches P. */
async function emlP(from: string, doc: Uint8Array): Promise<Uint8Array> {
  return signEml(from, await assembleCanonicalPdf(coverA, doc));
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
    `From: ${from}`, 'To: forward-to-sign@kysigned.com', 'Subject: Fwd: sign',
    'Date: Sat, 14 Jun 2026 10:00:00 +0000', `Message-ID: <${from}@x.com>`,
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '',
    '--B', 'Content-Type: text/plain; charset=us-ascii', '', 'I sign this document', '',
    '--B', 'Content-Type: application/pdf; name="d.pdf"', 'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="d.pdf"', '', b64(pdf), '--B--', '',
  ].join('\r\n');
}

async function signEml(from: string, pdf: Uint8Array): Promise<Uint8Array> {
  const res = await dkimSign(buildForward(from, pdf), {
    canonicalization: 'relaxed/relaxed',
    signTime: new Date('2026-06-14T10:00:00Z'),
    signatureData: [{ signingDomain: 'example.com', selector: 'test', privateKey, algorithm: 'rsa-sha256' }],
  });
  return new Uint8Array(Buffer.from(res.signatures + buildForward(from, pdf), 'latin1'));
}

async function makeSigner(index: number, email: string, rawEml: Uint8Array, over: Partial<BundleSignerInput> = {}): Promise<BundleSignerInput> {
  const h = createHash('sha256').update(rawEml).digest();
  return {
    index, name: `Signer ${index}`, email, onBehalfOf: null,
    signingDomain: 'example.com', selector: 'test', signedAt: new Date('2026-06-14T10:00:00Z'),
    emlSha256: createHash('sha256').update(rawEml).digest('hex'), rawEml,
    cover: coverA,
    dkimKey: txtRecord, dkimObservedAt: new Date('2026-06-14T10:00:01Z'), archiveStatus: 'archived',
    otsProof: await fake.stamp(h), tsaToken: await fake.stamp(h),
    verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' }, ...over,
  };
}

function inputFor(doc: Uint8Array, signers: BundleSignerInput[]): AssembleBundleInput {
  return {
    envelope: { id: '18267982-ca76-45dc-a294-e86039a6343d', documentName: 'NDA', documentHash: 'd'.repeat(64), creatorEmail: 'c@acme.com', completedAt: new Date('2026-06-14T12:00:00Z') },
    documentOriginal: doc, signers, verifierBaseUrl: 'https://kysigned.com',
  };
}

/** Assert the browser + Node engines agree on the substantive verdict. */
function sameVerdict(node: BundleVerdict, web: BundleVerdict): void {
  assert.equal(web.proven, node.proven, 'overall proven must match');
  assert.equal(web.fingerprint.computed, node.fingerprint.computed, 'fingerprint must match');
  assert.equal(web.fingerprint.matchesPrinted, node.fingerprint.matchesPrinted);
  assert.equal(web.signers.length, node.signers.length);
  assert.deepEqual(web.errors, node.errors);
  for (let i = 0; i < node.signers.length; i++) {
    assert.deepEqual(web.signers[i].checks, node.signers[i].checks, `signer ${i} checks must match`);
    assert.equal(web.signers[i].proven, node.signers[i].proven);
    assert.equal(web.signers[i].email, node.signers[i].email);
    assert.equal(web.signers[i].signingDomain, node.signers[i].signingDomain);
    assert.equal(web.signers[i].verbatimIntent, node.signers[i].verbatimIntent);
    assert.equal(web.signers[i].signingTimeSec, node.signers[i].signingTimeSec);
  }
}

async function both(bytes: Uint8Array, extra: Parameters<typeof verifyBundle>[1] = {}) {
  const deps = { verifyTimestamp, ...extra };
  return { node: await verifyBundle(bytes, deps), web: await verifyBundleWeb(bytes, deps) };
}

describe('verifyBundleWeb agrees with verifyBundle (Node/mailauth) — F-10.1 / AC-27', () => {
  it('valid 2-signer bundle → both PROVEN, identical verdict', async () => {
    const e1 = await emlP('alice@example.com', docA);
    const e2 = await emlP('bob@example.com', docA);
    const { bytes } = await assembleBundle(inputFor(docA, [await makeSigner(1, 'alice@example.com', e1), await makeSigner(2, 'bob@example.com', e2)]));
    const { node, web } = await both(bytes);
    assert.equal(node.proven, true);
    assert.equal(web.proven, true);
    sameVerdict(node, web);
  });

  it('document swap → both FAILED (attachment), identical', async () => {
    const e1 = await emlP('alice@example.com', docA);
    const { bytes } = await assembleBundle(inputFor(docB, [await makeSigner(1, 'alice@example.com', e1)]));
    const { node, web } = await both(bytes);
    assert.equal(web.proven, false);
    assert.equal(web.signers[0].checks.attachment, false);
    sameVerdict(node, web);
  });

  it('flipped .eml byte → both FAILED (DKIM), identical', async () => {
    const e1 = await emlP('alice@example.com', docA);
    // Flip a byte in the DKIM-signed body (the intent line) → body-hash mismatch,
    // breaking DKIM cleanly without corrupting the base64 attachment.
    e1[Buffer.from(e1).indexOf('I sign this document') + 2] ^= 0x01;
    const { bytes } = await assembleBundle(inputFor(docA, [await makeSigner(1, 'alice@example.com', e1)]));
    const { node, web } = await both(bytes);
    assert.equal(web.signers[0].checks.dkim, false);
    sameVerdict(node, web);
  });

  it('wrong key in keys.json → both FAILED (DKIM), identical', async () => {
    const e1 = await emlP('alice@example.com', docA);
    const { bytes } = await assembleBundle(inputFor(docA, [await makeSigner(1, 'alice@example.com', e1, { dkimKey: 'v=DKIM1; k=rsa; p=WRONGAAAB' })]));
    const { node, web } = await both(bytes);
    assert.equal(web.signers[0].checks.dkim, false);
    sameVerdict(node, web);
  });

  it('the key check is pending-online offline and identical across engines (DD-16: presence, no window)', async () => {
    const e1 = await emlP('alice@example.com', docA);
    const { bytes } = await assembleBundle(inputFor(docA, [await makeSigner(1, 'alice@example.com', e1)]));
    const { node, web } = await both(bytes);
    assert.equal(web.signers[0].checks.keyAuthenticity, 'pending-online');
    assert.equal(node.signers[0].checks.keyAuthenticity, 'pending-online');
    sameVerdict(node, web);
  });
});
