/**
 * assembleBundle integration tests — F-8 (AC-21/22/63/64/67), spec v0.4.0.
 *
 * Builds a genuine 2-signer bundle: each signer's `.eml` is really DKIM-signed
 * (offline, generated key) with a real canonical PDF attached that byte-matches
 * `document-original.pdf`. Asserts the rendered page order + the five embedded
 * classes + the fingerprint on the signature page + no signature dictionary
 * (AC-21/63), that the embedded `.eml` re-verifies standalone against keys.json
 * with its attachment byte-identical to the document (AC-22), the fingerprint
 * recompute + tamper behaviour (AC-64), on-behalf-of rendering (AC-67), and
 * byte-determinism (F-8.4).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { dkimSign } from 'mailauth';
import { assembleBundle } from './assembleBundle.js';
import { buildEvidenceManifest } from './evidenceManifest.js';
import { computeBundleFingerprint } from './fingerprint.js';
import { hasSignatureDictionary } from './signatureDict.js';
import { buildKeysJson, type KeysJson } from './keysJson.js';
import { verifyDkim, type DkimResolver } from '../api/signing/dkimVerify.js';
import { evaluateDkimPolicy } from '../api/signing/dkimPolicy.js';
import { checkForwardedAttachment, sha256Hex } from '../api/signing/attachmentCheck.js';
import type { AssembleBundleInput, BundleSignerInput } from './types.js';
import type { TimestampProof } from '../timestamp/contract.js';

let privateKey = '';
let txtRecord = '';
let documentOriginal: Uint8Array;

before(async () => {
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKey = kp.privateKey;
  const der = kp.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  txtRecord = `v=DKIM1; k=rsa; p=${der}`;

  // A real 2-page canonical PDF (cover + document) — must be pdf-lib-loadable so
  // the bundle can copy its pages, and is what each forward attaches.
  const d = await PDFDocument.create();
  d.setProducer('kysigned-test');
  d.setCreationDate(new Date('2026-06-14T00:00:00Z'));
  d.setModificationDate(new Date('2026-06-14T00:00:00Z'));
  d.addPage([612, 792]).drawText('COVER PAGE acme contract');
  d.addPage([612, 792]).drawText('DOCUMENT BODY clause one');
  documentOriginal = new Uint8Array(await d.save({ useObjectStreams: false }));
});

function b64(bytes: Uint8Array): string {
  return (Buffer.from(bytes).toString('base64').match(/.{1,64}/g) ?? []).join('\r\n');
}

function buildForward(from: string, pdf: Uint8Array): string {
  return [
    `From: ${from}`,
    'To: forward-to-sign@kysigned.com',
    'Subject: Fwd: Please sign "acme"',
    'Date: Sat, 14 Jun 2026 10:00:00 +0000',
    `Message-ID: <fwd-${from}@example.com>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BOUND"',
    '',
    '--BOUND',
    'Content-Type: text/plain; charset=us-ascii',
    '',
    'I sign this document',
    '',
    '---------- Forwarded message ---------',
    'From: kysigned <forward-to-sign@kysigned.com>',
    '',
    '--BOUND',
    'Content-Type: application/pdf; name="acme.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="acme.pdf"',
    '',
    b64(pdf),
    '--BOUND--',
    '',
  ].join('\r\n');
}

async function signedEml(from: string): Promise<Uint8Array> {
  const raw = buildForward(from, documentOriginal);
  const res = await dkimSign(raw, {
    canonicalization: 'relaxed/relaxed',
    signTime: new Date('2026-06-14T10:00:00Z'),
    signatureData: [{ signingDomain: 'example.com', selector: 'test', privateKey, algorithm: 'rsa-sha256' }],
  });
  return new Uint8Array(Buffer.from(res.signatures + raw, 'latin1'));
}

function proof(provider: string, raw: string, status: 'pending' | 'complete' = 'complete'): TimestampProof {
  return { provider, version: 1, status, data: Buffer.from(raw).toString('base64') };
}

async function signer(index: number, email: string, name: string, onBehalfOf?: string): Promise<BundleSignerInput> {
  const rawEml = await signedEml(email);
  return {
    index,
    name,
    email,
    onBehalfOf: onBehalfOf ?? null,
    signingDomain: 'example.com',
    selector: 'test',
    signedAt: new Date('2026-06-14T10:00:00Z'),
    emlSha256: createHash('sha256').update(rawEml).digest('hex'),
    rawEml,
    cover: new Uint8Array(Buffer.from(`%PDF-cover-${index}\n`)),
    dkimKey: txtRecord,
    dkimObservedAt: new Date('2026-06-14T10:00:01Z'),
    archiveStatus: 'archived',
    otsProof: proof('ots', `ots-${index}`, 'pending'),
    tsaToken: proof('rfc3161', `tsr-${index}`),
    verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' },
  };
}

async function makeInput(opts: { onBehalfOf1?: string } = {}): Promise<AssembleBundleInput> {
  return {
    envelope: {
      id: '18267982-ca76-45dc-a294-e86039a6343d',
      documentName: 'NDA — Acme',
      documentHash: sha256Hex(documentOriginal),
      creatorEmail: 'creator@acme.com',
      completedAt: new Date('2026-06-14T12:00:00Z'),
    },
    documentOriginal,
    signers: [
      await signer(1, 'alice@example.com', 'Alice Adams', opts.onBehalfOf1),
      await signer(2, 'bob@example.com', 'Bob Brown'),
    ],
    verifierBaseUrl: 'https://kysigned.com',
  };
}

/** Decompress + decode pdf-lib content streams to read rendered text. */
function renderedText(pdfBytes: Uint8Array): string {
  const raw = Buffer.from(pdfBytes);
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const s = raw.indexOf(Buffer.from('stream', 'latin1'), i);
    if (s === -1) break;
    let start = s + 6;
    if (raw[start] === 0x0d) start++;
    if (raw[start] === 0x0a) start++;
    const e = raw.indexOf(Buffer.from('endstream', 'latin1'), start);
    if (e === -1) break;
    try {
      const inflated = inflateSync(raw.subarray(start, e));
      out.push(inflated.toString('latin1').replace(/<([0-9A-Fa-f]+)>/g, (_m, h: string) => {
        let t = '';
        for (let k = 0; k + 1 < h.length; k += 2) t += String.fromCharCode(parseInt(h.slice(k, k + 2), 16));
        return t;
      }));
    } catch { /* non-flate stream */ }
    i = e + 9;
  }
  return out.join('\n');
}

/** A DkimResolver backed by keys.json (what the offline verifier does). */
function keysJsonResolver(keys: KeysJson): DkimResolver {
  return async (name, rrtype) => {
    const m = /^([^.]+)\._domainkey\.(.+)$/.exec(name);
    if (String(rrtype).toLowerCase() === 'txt' && m) {
      const rec = keys.keys.find((k) => k.selector === m[1] && k.domain === m[2]);
      if (rec?.record) return [[rec.record]];
    }
    const err = new Error('ENOTFOUND') as Error & { code?: string };
    err.code = 'ENOTFOUND';
    throw err;
  };
}

describe('assembleBundle — F-8 (AC-21/63)', () => {
  it('renders ONE document-level "Verify this document" QR panel for the whole bundle — not one per signer (Barry QA 2026-06-22)', async () => {
    const input = await makeInput(); // two signers
    const { bytes } = await assembleBundle(input);
    const text = renderedText(bytes);
    const panels = (text.match(/Verify this document/g) || []).length;
    assert.equal(panels, 1, `exactly one verifier panel for the whole bundle (2 signers) — got ${panels}`);
    assert.ok(!/Scan to verify/.test(text), 'the ambiguous standalone "Scan to verify" label is gone');
  });

  it('renders signature page(s) then cover+document once, embeds all five classes, no sig dict', async () => {
    const input = await makeInput();
    const { bytes, fingerprint, manifest } = await assembleBundle(input);

    // Page order: sig page(s) (>=1) then the 2 canonical pages, exactly once.
    const result = await PDFDocument.load(bytes);
    const canonicalPages = (await PDFDocument.load(documentOriginal)).getPageCount();
    assert.equal(canonicalPages, 2);
    const sigPages = result.getPageCount() - canonicalPages;
    assert.ok(sigPages >= 1, 'at least one signature page before the document');

    // Rendered text: signature page present, canonical document copied in.
    const text = renderedText(bytes);
    assert.match(text, /Signature page/);
    assert.match(text, /COVER PAGE acme contract/);
    assert.match(text, /DOCUMENT BODY clause one/);

    // All five embedded-file classes present (filespec names live in the bytes).
    const blob = Buffer.from(bytes).toString('latin1');
    for (const name of ['document-original.pdf', 'signer-1.eml', 'signer-2.eml', 'proofs/signer-1.tsr', 'proofs/signer-1.ots', 'keys.json', 'VERIFY-README.txt']) {
      assert.ok(blob.includes(name), `embedded ${name}`);
    }

    // Fingerprint is printed on the signature page (AC-64) and recomputes (F-8.2).
    assert.match(text, new RegExp(fingerprint));
    assert.equal(computeBundleFingerprint(manifest), fingerprint);

    // AC-63: no digital-signature dictionary anywhere.
    assert.equal(hasSignatureDictionary(bytes), false);
  });
});

describe('assembleBundle — embedded evidence is byte-complete + standalone-reverifiable (AC-22)', () => {
  it('embeds the .eml byte-for-byte and it DKIM-verifies against keys.json with the document attached', async () => {
    const input = await makeInput();
    const { manifest } = await assembleBundle(input);

    // Byte-complete (F-8.3): the embedded bytes are exactly the raw forward + doc.
    const eml1 = manifest.find((f) => f.path === 'signer-1.eml')!;
    assert.deepEqual(eml1.bytes, input.signers[0].rawEml);
    const docFile = manifest.find((f) => f.path === 'document-original.pdf')!;
    assert.deepEqual(docFile.bytes, documentOriginal);

    // Standalone-reverifiable: DKIM passes against keys.json (not live DNS)…
    const keysFile = manifest.find((f) => f.path === 'keys.json')!;
    const keys = JSON.parse(Buffer.from(keysFile.bytes).toString()) as KeysJson;
    const emlStr = Buffer.from(eml1.bytes).toString('latin1');
    const dkim = evaluateDkimPolicy(await verifyDkim(emlStr, { resolver: keysJsonResolver(keys) }));
    assert.equal(dkim.ok, true, 'embedded .eml DKIM-verifies against keys.json');

    // …and its attachment is byte-identical to document-original.pdf.
    const att = checkForwardedAttachment(emlStr, sha256Hex(docFile.bytes));
    assert.equal(att.ok, true, 'attachment byte-matches the embedded document');
  });
});

describe('assembleBundle — fingerprint tamper (AC-64)', () => {
  it('a changed embedded evidence byte makes the recomputed fingerprint differ', async () => {
    const input = await makeInput();
    const { fingerprint, manifest } = await assembleBundle(input);
    // Flip a byte in an embedded .eml → recompute must diverge from the printed one.
    const eml = manifest.find((f) => f.path === 'signer-1.eml')!;
    const tampered = manifest.map((f) =>
      f === eml ? { ...f, bytes: Uint8Array.from([...f.bytes.slice(0, -1), f.bytes[f.bytes.length - 1] ^ 0x01]) } : f,
    );
    assert.notEqual(computeBundleFingerprint(tampered), fingerprint);
  });
});

describe('assembleBundle — on-behalf-of rendering (AC-67)', () => {
  it('shows "on behalf of <org>" for a declaring signer and omits it for an individual', async () => {
    const input = await makeInput({ onBehalfOf1: 'Acme Holdings LLC' });
    const { bytes } = await assembleBundle(input);
    const text = renderedText(bytes);
    assert.match(text, /On behalf of: Acme Holdings LLC/);
    // Exactly one on-behalf line (signer 2 is an individual → none).
    assert.equal((text.match(/On behalf of:/g) ?? []).length, 1);
  });

  it('frames signer names/orgs as DECLARED, not verified (F-15.3 / AC-76)', async () => {
    const { bytes } = await assembleBundle(await makeInput({ onBehalfOf1: 'Acme Holdings LLC' }));
    const text = renderedText(bytes);
    assert.match(text, /as declared by the parties/i, 'declared-not-verified note present');
    assert.match(text, /not real-world identity/i, 'mailbox control, not verified identity (no KYC)');
  });
});

describe('assembleBundle — determinism (F-8.4)', () => {
  it('assembling twice with identical inputs yields byte-identical output', async () => {
    const input = await makeInput();
    const a = await assembleBundle(input);
    const b = await assembleBundle(input);
    assert.deepEqual(a.bytes, b.bytes);
    assert.equal(a.fingerprint, b.fingerprint);
  });
});
