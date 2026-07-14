/**
 * sealSelfHeal.test.ts (F-32.6 / AC-164, #147, DD-36) — the permanent regression
 * lock that ARCHIVE STATE NEVER GATES SEALING, and that a bundle sealed during an
 * archive outage SELF-HEALS at verification once the archive holds the exact key.
 *
 * The design fact this pins (DD-36): the verifier confirms provenance by a LIVE
 * archive lookup at verification time — never from the bundle's own operator-authored
 * archive status. So a bundle sealed while archive.prove.email was down is not
 * damaged: the moment the archive observes the key (our contribution lands, or its
 * next crawl), the SAME bundle bytes verify with provenance confirmed — no re-issue,
 * no customer action. This is why completion/sealing is never delayed by archive
 * state, and why the F-32.7 sweep (not a seal gate) handles the one unrecoverable
 * case (rotation before any observation).
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
import { confirmKeyArchive } from './confirmKeyArchive.js';
import { applyOnlineConfirmations } from './applyConfirmations.js';
import { createFakeProvider } from '../timestamp/fake.js';
import type { AssembleBundleInput, BundleSignerInput } from './types.js';
import type { TimestampProof, VerifyResult } from '../timestamp/contract.js';

const SIGN_TIME_SEC = 1_780_000_000;
const fake = createFakeProvider({ timeSec: SIGN_TIME_SEC });
const verifyTimestamp = async (p: TimestampProof, h: Uint8Array): Promise<VerifyResult> =>
  fake.verify({ ...p, provider: 'fake' }, h);

let providerKey = '';
let providerTxt = '';
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

async function signGenuine(from: string, pdf: Uint8Array, domain: string): Promise<Uint8Array> {
  const raw = buildForward(from, pdf);
  const res = await dkimSign(raw, {
    canonicalization: 'relaxed/relaxed',
    signTime: new Date('2026-06-14T10:00:00Z'),
    signatureData: [{ signingDomain: domain, selector: 'mail2026', privateKey: providerKey, algorithm: 'rsa-sha256' }],
  });
  return new Uint8Array(Buffer.from(res.signatures + raw, 'latin1'));
}

before(async () => {
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  providerKey = kp.privateKey;
  providerTxt = `v=DKIM1; k=rsa; p=${kp.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')}`;
  doc = await makeDoc('A GENUINE AGREEMENT');
  cover = await makeDoc('COVER for dana@example-corp.com');
});

/** A GENUINE bundle whose receipt happened during an archive outage. */
async function outageSealedBundle(): Promise<Uint8Array> {
  const eml = await signGenuine('dana@example-corp.com', await assembleCanonicalPdf(cover, doc), 'example-corp.com');
  const emlHash = createHash('sha256').update(eml).digest();
  const signer: BundleSignerInput = {
    index: 1,
    name: 'Dana',
    email: 'dana@example-corp.com',
    onBehalfOf: null,
    signingDomain: 'example-corp.com',
    selector: 'mail2026',
    signedAt: new Date('2026-06-14T10:00:00Z'),
    emlSha256: emlHash.toString('hex'),
    rawEml: eml,
    cover,
    dkimKey: providerTxt,
    dkimObservedAt: new Date('2026-06-14T10:00:01Z'),
    archiveStatus: 'outage', // sealed DURING an archive outage — the AC-164 scenario
    otsProof: await fake.stamp(emlHash),
    tsaToken: await fake.stamp(emlHash),
    verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' },
  };
  const input: AssembleBundleInput = {
    envelope: {
      id: '66666666-7777-8888-9999-aaaaaaaaaaaa',
      documentName: 'Genuine Agreement',
      documentHash: 'e'.repeat(64),
      creatorEmail: 'creator@example-corp.com',
      completedAt: new Date('2026-06-14T12:00:00Z'),
    },
    documentOriginal: doc,
    signers: [signer],
    verifierBaseUrl: 'https://kysigned.com',
  };
  return (await assembleBundle(input)).bytes;
}

describe('seal-during-outage self-heals at verification (F-32.6 / AC-164)', () => {
  it('sealing is never gated on archive state: an outage-status bundle seals and every hard check passes', async () => {
    const bundle = await outageSealedBundle(); // assembly itself has no archive dependency
    const v = await verifyBundle(bundle, { verifyTimestamp });
    assert.equal(v.signers[0].checks.dkim, true);
    assert.equal(v.signers[0].checks.attachment, true);
    assert.equal(v.signers[0].checks.intent, true);
    assert.equal(v.signers[0].checks.timestamp, true);
    // Offline, provenance is honestly pending — capped, never failed, never blocked.
    assert.equal(v.signers[0].assurance.keyProvenance, 'pending');
    assert.equal(v.tier, 'INTEGRITY_VERIFIED');
  });

  it('once the archive holds the exact key, the SAME sealed bytes verify provider-key confirmed (self-heal, no re-issue)', async () => {
    const bundle = await outageSealedBundle();
    const bytesBefore = createHash('sha256').update(bundle).digest('hex');

    // The archive has caught up (our contribution landed / its crawl observed the key):
    const lastSeen = new Date(SIGN_TIME_SEC * 1000 + 3_600_000).toISOString();
    const archiveFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          domain: 'example-corp.com',
          selector: 'mail2026',
          value: providerTxt,
          firstSeenAt: new Date(SIGN_TIME_SEC * 1000 - 3_600_000).toISOString(),
          lastSeenAt: lastSeen,
        },
      ],
    })) as unknown as typeof fetch;

    const verdict = await verifyBundle(bundle, { verifyTimestamp });
    const confirmation = await confirmKeyArchive('example-corp.com', 'mail2026', providerTxt, {
      fetchFn: archiveFetch,
    });
    assert.equal(confirmation.keyProvenance, 'confirmed');

    const healed = applyOnlineConfirmations(verdict, { keyArchive: { 1: confirmation } });
    assert.equal(healed.signers[0].assurance.keyProvenance, 'confirmed');
    assert.equal(healed.signers[0].assurance.keyValidity, 'confirmed', 'anchored time inside the recorded window');
    assert.equal(healed.signers[0].tier, 'PROVIDER_KEY_CONFIRMED', 'healed past INTEGRITY_VERIFIED (durability stays pending on the test-fake OTS, so not PROVEN)');
    assert.equal(healed.tier, 'PROVIDER_KEY_CONFIRMED');

    // No re-issue: the heal came from the live lookup, not from touching the bundle.
    const bytesAfter = createHash('sha256').update(bundle).digest('hex');
    assert.equal(bytesAfter, bytesBefore, 'the sealed bundle bytes never change');
  });

  it("the bundle's own operator-authored outage status is ignored as evidence in BOTH directions (AC-158)", async () => {
    const bundle = await outageSealedBundle();
    const verdict = await verifyBundle(bundle, { verifyTimestamp });
    // Without a live confirmation, self-asserted status never raises the tier...
    assert.equal(verdict.tier, 'INTEGRITY_VERIFIED');
    // ...and with one, the stale 'outage' string never blocks the upgrade (proven above).
  });
});
