/**
 * Bitcoin-anchor verdict field — F-10.6 / AC-99, AC-100.
 *
 * The verifier surfaces the OpenTimestamps Bitcoin anchor as a distinct field on
 * each SignerVerdict, ADDITIVE: a pending / absent / failed Bitcoin status NEVER
 * changes `proven`. The Node engine confirms online by default (confirmed /
 * pending / absent with the block height + time). The browser engine is
 * offline-first — it returns `pending` until the user explicitly confirms (26.3),
 * so `verifyBundleWeb` itself never returns `confirmed`.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { dkimSign } from 'mailauth';
import { assembleBundle } from './assembleBundle.js';
import { assembleCanonicalPdf } from '../pdf/assembleCanonicalPdf.js';
import { verifyBundle } from './verify.js';
import { verifyBundleWeb } from './verifyWeb.js';
import { createFakeProvider } from '../timestamp/fake.js';
import type { TimestampProof, VerifyResult } from '../timestamp/contract.js';
import type { AssembleBundleInput, BundleSignerInput } from './types.js';

const fake = createFakeProvider({ timeSec: 1_700_000_000 });
// The engine reconstructs proofs with provider 'ots'/'rfc3161'; normalize to the fake.
const fakeVerify = (proof: TimestampProof, hash: Uint8Array) => fake.verify({ ...proof, provider: 'fake' }, hash);

let privateKey = '';
let txtRecord = '';
let docA: Uint8Array;
let coverA: Uint8Array;

before(async () => {
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKey = kp.privateKey;
  txtRecord = `v=DKIM1; k=rsa; p=${kp.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')}`;
  docA = await makeDoc('DOC A');
  coverA = await makeDoc('COVER');
});

async function makeDoc(text: string): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.setCreationDate(new Date('2026-06-14T00:00:00Z'));
  d.setModificationDate(new Date('2026-06-14T00:00:00Z'));
  d.addPage([612, 792]).drawText(text);
  return new Uint8Array(await d.save({ useObjectStreams: false }));
}

function b64(b: Uint8Array): string {
  return (Buffer.from(b).toString('base64').match(/.{1,64}/g) ?? []).join('\r\n');
}

async function signedEml(pdf: Uint8Array): Promise<Uint8Array> {
  const raw = [
    'From: alice@example.com',
    'To: forward-to-sign@kysigned.com',
    'Subject: Fwd: sign',
    'Date: Sat, 14 Jun 2026 10:00:00 +0000',
    'Message-ID: <m@example.com>',
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
  const res = await dkimSign(raw, {
    canonicalization: 'relaxed/relaxed',
    signTime: new Date('2026-06-14T10:00:00Z'),
    signatureData: [{ signingDomain: 'example.com', selector: 'test', privateKey, algorithm: 'rsa-sha256' }],
  });
  return new Uint8Array(Buffer.from(res.signatures + raw, 'latin1'));
}

async function makeBundle(over: Partial<BundleSignerInput> = {}): Promise<Uint8Array> {
  const pi = await assembleCanonicalPdf(coverA, docA); // P_i = cover ++ D (what the signer attaches)
  const eml = await signedEml(pi);
  const tsHash = createHash('sha256').update(eml).digest();
  const signer: BundleSignerInput = {
    index: 1,
    name: 'Alice',
    email: 'alice@example.com',
    onBehalfOf: null,
    signingDomain: 'example.com',
    selector: 'test',
    signedAt: new Date('2026-06-14T10:00:00Z'),
    emlSha256: createHash('sha256').update(eml).digest('hex'),
    rawEml: eml,
    cover: coverA,
    dkimKey: txtRecord,
    dkimObservedAt: new Date('2026-06-14T10:00:01Z'),
    archiveStatus: 'archived',
    otsProof: await fake.stamp(tsHash),
    tsaToken: await fake.stamp(tsHash),
    verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' },
    ...over,
  };
  const input: AssembleBundleInput = {
    envelope: {
      id: '18267982-ca76-45dc-a294-e86039a6343d',
      documentName: 'NDA',
      documentHash: 'd'.repeat(64),
      creatorEmail: 'creator@acme.com',
      completedAt: new Date('2026-06-14T12:00:00Z'),
    },
    documentOriginal: docA,
    signers: [signer],
    verifierBaseUrl: 'https://kysigned.com',
  };
  return (await assembleBundle(input)).bytes;
}

describe('Bitcoin-anchor verdict field (F-10.6 / AC-99, AC-100)', () => {
  it('Node: a verifying but NOT block-anchored .ots stays bitcoinAnchor pending (durable needs a real Bitcoin block, F-32.2); proven unaffected', async () => {
    // The fake OTS verifies (ok) but carries no `bitcoin:block:*` anchor, so it is
    // a calendar/provisional proof, not block-confirmed → pending (not confirmed).
    const v = await verifyBundle(await makeBundle(), { verifyTimestamp: fakeVerify });
    assert.equal(v.proven, true);
    assert.equal(v.signers[0].bitcoinAnchor.status, 'pending');
    assert.equal(v.signers[0].assurance.timestampDurability, 'pending'); // provisional TSA-only
  });

  it('Node: parses the Bitcoin block height from a real-shaped anchor', async () => {
    const btcVerify = async (proof: TimestampProof, hash: Uint8Array): Promise<VerifyResult> =>
      proof.provider === 'ots'
        ? { ok: true, timeSec: 1_700_000_500, anchor: 'bitcoin:block:750000:deadbeef' }
        : fakeVerify(proof, hash);
    const v = await verifyBundle(await makeBundle(), { verifyTimestamp: btcVerify });
    assert.equal(v.signers[0].bitcoinAnchor.status, 'confirmed');
    assert.equal(v.signers[0].bitcoinAnchor.blockHeight, 750000);
    assert.equal(v.signers[0].bitcoinAnchor.timeSec, 1_700_000_500);
    // Real Bitcoin block + valid TSA, agreeing times → durable timestamp assurance (F-32.2).
    assert.equal(v.signers[0].assurance.timestampDurability, 'confirmed');
  });

  it('Node: a .ots that does not confirm → pending, while .tsr keeps proven true (additive, AC-100)', async () => {
    const otsFails = async (proof: TimestampProof, hash: Uint8Array): Promise<VerifyResult> =>
      proof.provider === 'ots' ? { ok: false, timeSec: 0, anchor: '' } : fakeVerify(proof, hash);
    const v = await verifyBundle(await makeBundle(), { verifyTimestamp: otsFails });
    assert.equal(v.proven, true, 'a pending Bitcoin anchor must NOT fail the bundle');
    assert.equal(v.signers[0].bitcoinAnchor.status, 'pending');
  });

  it('Node: no .ots proof → absent; proven still true', async () => {
    const v = await verifyBundle(await makeBundle({ otsProof: undefined }), { verifyTimestamp: fakeVerify });
    assert.equal(v.proven, true);
    assert.equal(v.signers[0].bitcoinAnchor.status, 'absent');
  });

  it('Web is offline-first: pending even when the .ots could confirm; proven true', async () => {
    const v = await verifyBundleWeb(await makeBundle(), { verifyTimestamp: fakeVerify });
    assert.equal(v.proven, true);
    assert.equal(v.signers[0].bitcoinAnchor.status, 'pending', 'web must not confirm Bitcoin on load');
  });

  it('Web: no .ots proof → absent', async () => {
    const v = await verifyBundleWeb(await makeBundle({ otsProof: undefined }), { verifyTimestamp: fakeVerify });
    assert.equal(v.signers[0].bitcoinAnchor.status, 'absent');
  });
});
