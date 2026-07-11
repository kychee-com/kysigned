/**
 * gen-forged-key-asset.mjs — the #136 self-minted-key FORGERY fixture (F-32.1/F-32.3,
 * AC-153/AC-157). Writes docs/test-assets/sample-bundle-forged-key.pdf.
 *
 * Scenario: a malicious operator mints its OWN RSA keypair, DKIM-signs a fabricated
 * "I sign this document" email under a REAL provider domain+selector it does NOT control
 * (`gmail.com` / `20251104`), and embeds its own public key in `keys.json` as if it were
 * gmail's. The signature verifies against that embedded key, so the bundle is internally
 * self-consistent — the exact over-claim the OLD binary "PROVEN" hid.
 *
 * Expected verdicts on the deployed /verify:
 *   - OFFLINE  → INTEGRITY VERIFIED (all four hard checks pass; provider-key provenance
 *     is pending — honestly NOT PROVEN, which is the #137 fix).
 *   - ONLINE   → FAILED. The archive gate looks up gmail.com/20251104 in the public
 *     archive, finds gmail's REAL published key, sees it does NOT match the embedded
 *     self-minted key, and rejects the verdict as a provider-key mismatch (the #136 fix).
 *
 * The timestamp is a REAL freeTSA RFC-3161 token so the timestamp check passes offline —
 * isolating the failure to the provenance gate, not a fake proof. DUMMY data only: the
 * "signer" alice@gmail.com is an illustrative impersonation target; NO email is ever sent
 * (this is a static verifier fixture), and the document is fabricated.
 *
 * Run:  node --import tsx scripts/gen-forged-key-asset.mjs   (needs network for freeTSA/OTS)
 */
import { generateKeyPairSync, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { dkimSign } from 'mailauth';
import { assembleBundle } from '../src/bundle/assembleBundle.ts';
import { assembleCanonicalPdf } from '../src/pdf/assembleCanonicalPdf.ts';
import { createRfc3161Provider } from '../src/timestamp/rfc3161/provider.ts';
import { createOtsProvider } from '../src/timestamp/ots/provider.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'test-assets');
const CLAIMED_DOMAIN = 'gmail.com'; // a REAL provider the public archive holds
const CLAIMED_SELECTOR = '20251104'; // gmail's real, archived selector — attacker embeds a DIFFERENT key under it
const FROM = 'alice@gmail.com'; // illustrative impersonation target; no mail is sent
const SIGN_TIME = new Date('2026-07-05T10:00:00Z');

const tsa = createRfc3161Provider({}); // freeTSA, real → the .tsr verifies OFFLINE
const ots = createOtsProvider({}); // real, pending until a Bitcoin block

const pemToTxt = (pub) => `v=DKIM1; k=rsa; p=${pub.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')}`;
async function makePdf(lines) {
  const d = await PDFDocument.create();
  d.setCreationDate(new Date('2026-07-05T00:00:00Z'));
  d.setModificationDate(new Date('2026-07-05T00:00:00Z'));
  const p = d.addPage([612, 792]);
  lines.forEach((t, i) => p.drawText(t, { x: 56, y: 720 - i * 22, size: 12 }));
  return new Uint8Array(await d.save({ useObjectStreams: false }));
}
const b64Wrap = (b) => (Buffer.from(b).toString('base64').match(/.{1,64}/g) ?? []).join('\r\n');
const buildForward = (from, pdf) =>
  [
    `From: ${from}`,
    'To: forward-to-sign@kysigned.com',
    'Subject: Fwd: Signature requested: "Severance Agreement"',
    'Date: Sun, 05 Jul 2026 10:00:00 +0000',
    'Message-ID: <fwd-forged-demo@gmail.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: text/plain; charset=us-ascii',
    '',
    'I sign this document',
    '',
    '--B',
    'Content-Type: application/pdf; name="document.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="document.pdf"',
    '',
    b64Wrap(pdf),
    '--B--',
    '',
  ].join('\r\n');

const attacker = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const doc = await makePdf(['SEVERANCE AGREEMENT', '', 'A contract the impersonated signer never actually signed.']);
const cover = await makePdf(['SIGNING COVER PAGE', '', `Signer: Alice <${FROM}>`, 'I sign this document.']);
const P = await assembleCanonicalPdf(cover, doc);
const raw = buildForward(FROM, P);
const res = await dkimSign(raw, {
  canonicalization: 'relaxed/relaxed',
  signTime: SIGN_TIME,
  signatureData: [{ signingDomain: CLAIMED_DOMAIN, selector: CLAIMED_SELECTOR, privateKey: attacker.privateKey, algorithm: 'rsa-sha256' }],
});
const eml = new Uint8Array(Buffer.from(res.signatures + raw, 'latin1'));
const emlHash = createHash('sha256').update(eml).digest();
const tsaToken = await tsa.stamp(emlHash);
let otsProof = null;
try {
  otsProof = await ots.stamp(emlHash);
} catch (e) {
  console.warn('  OTS stamp skipped:', e.message);
}

const bundle = await assembleBundle({
  envelope: {
    id: 'f0f0f0f0-1111-2222-3333-444444444444',
    documentName: 'Severance Agreement',
    documentHash: createHash('sha256').update(doc).digest('hex'),
    creatorEmail: 'operator@evil.example',
    completedAt: new Date('2026-07-05T12:00:00Z'),
  },
  documentOriginal: doc,
  signers: [
    {
      index: 1,
      name: 'Alice',
      email: FROM,
      onBehalfOf: null,
      signingDomain: CLAIMED_DOMAIN,
      selector: CLAIMED_SELECTOR,
      signedAt: SIGN_TIME,
      emlSha256: emlHash.toString('hex'),
      rawEml: eml,
      cover,
      dkimKey: pemToTxt(attacker.publicKey), // the ATTACKER's key, embedded as if it were gmail's
      dkimObservedAt: new Date(SIGN_TIME.getTime() + 1000),
      archiveStatus: 'archived', // operator-authored — must NOT be treated as evidence
      otsProof,
      tsaToken,
      verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' },
    },
  ],
  verifierBaseUrl: 'https://kysigned.com',
});

writeFileSync(join(OUT, 'sample-bundle-forged-key.pdf'), Buffer.from(bundle.bytes));
console.log(`wrote sample-bundle-forged-key.pdf (${bundle.bytes.length} bytes); fingerprint ${bundle.fingerprint}`);
console.log(`claimed ${CLAIMED_DOMAIN}/${CLAIMED_SELECTOR}; embedded key is the attacker's self-minted key.`);
