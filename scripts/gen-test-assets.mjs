/**
 * gen-test-assets.mjs — generate the committed evidence-bundle test assets
 * (system-test cycle-1 TR-003 / FC1.3).
 *
 * Produces a VALID 2-signer evidence bundle plus the tamper matrix, written to
 * `docs/test-assets/`, so the code-blind Red Team can drop them on the deployed
 * `/verify` page (and the CLI verifier) and confirm each expected verdict.
 *
 * Faithful to the real pipeline: a genuine RSA DKIM keypair signs each forward
 * via mailauth (`dkimSign`), the bundle is built by the real `assembleBundle`,
 * and the timestamp is a REAL RFC-3161 token from freeTSA over sha256(.eml) — so
 * the valid bundle's timestamp check verifies OFFLINE on the deployed verifier
 * (the `.tsr` carries its own TSA-signed time; no Bitcoin-confirmation wait). A
 * real (pending) OTS proof is included for completeness; the verifier accepts the
 * `.tsr` alone for the timestamp check.
 *
 * DUMMY DATA ONLY (feedback_no_pii_scratch_in_repo): signers are
 * `alice@redteam.kysigned.test` / `bob@redteam.kysigned.test`, signing domain
 * `redteam.kysigned.test`, creator `creator@redteam.kysigned.test`. No real PII.
 *
 * Run:  node --import tsx scripts/gen-test-assets.mjs
 * (Requires network for the freeTSA + OTS-calendar stamp; run from the kysigned repo.)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { PDFDocument } from 'pdf-lib';
import { dkimSign } from 'mailauth';
import { assembleBundle } from '../src/bundle/assembleBundle.ts';
import { assembleCanonicalPdf } from '../src/pdf/assembleCanonicalPdf.ts';
import { createRfc3161Provider } from '../src/timestamp/rfc3161/provider.ts';
import { createOtsProvider } from '../src/timestamp/ots/provider.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'test-assets');
const DOMAIN = 'redteam.kysigned.test';
const SELECTOR = 'rt2026';
const ALICE = 'alice@redteam.kysigned.test';
const BOB = 'bob@redteam.kysigned.test';
const CREATOR = 'creator@redteam.kysigned.test';
const SIGN_TIME = new Date('2026-06-20T10:00:00Z');

const tsa = createRfc3161Provider({}); // freeTSA, real
const ots = createOtsProvider({}); // public calendars, real (pending until Bitcoin)

function pemToTxt(pubPem) {
  return `v=DKIM1; k=rsa; p=${pubPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')}`;
}

async function makePdf(lines) {
  const d = await PDFDocument.create();
  d.setCreationDate(new Date('2026-06-20T00:00:00Z'));
  d.setModificationDate(new Date('2026-06-20T00:00:00Z'));
  const page = d.addPage([612, 792]);
  lines.forEach((t, i) => page.drawText(t, { x: 56, y: 720 - i * 22, size: 12 }));
  return new Uint8Array(await d.save({ useObjectStreams: false }));
}

function b64Wrap(bytes) {
  return (Buffer.from(bytes).toString('base64').match(/.{1,64}/g) ?? []).join('\r\n');
}

/** Build a multipart/mixed forward that attaches `pdf`, with the intent line.
 *  `lTag` adds a length-limited DKIM (the l= tag the verifier must reject, AC-3). */
function buildForward(from, pdf) {
  return [
    `From: ${from}`,
    'To: forward-to-sign@kysigned.com',
    'Subject: Fwd: Signature requested: "Mutual NDA" [ksgn-18267982ca7645dca294e86039a6343d]',
    'Date: Sat, 20 Jun 2026 10:00:00 +0000',
    `Message-ID: <fwd-${from.replace(/[@.]/g, '-')}@redteam.kysigned.test>`,
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
}

async function signEml(privateKey, from, pdf, { lTag = false } = {}) {
  const raw = buildForward(from, pdf);
  const sig = { signingDomain: DOMAIN, selector: SELECTOR, privateKey, algorithm: 'rsa-sha256' };
  // l= tag (AC-3): set maxBodyLength to the canonical body length so mailauth emits
  // a VALID signature carrying `l=<n>` — exactly the length-limited DKIM the verifier
  // must reject (a partial-body signature lets an attacker append unsigned bytes).
  if (lTag) {
    const bodyStart = raw.indexOf('\r\n\r\n') + 4;
    sig.maxBodyLength = Buffer.byteLength(raw.slice(bodyStart), 'latin1');
  }
  const res = await dkimSign(raw, {
    canonicalization: 'relaxed/relaxed',
    signTime: SIGN_TIME,
    signatureData: [sig],
  });
  return new Uint8Array(Buffer.from(res.signatures + raw, 'latin1'));
}

async function signerInput(index, name, email, rawEml, cover, txtRecord) {
  const emlHash = createHash('sha256').update(rawEml).digest();
  // Real RFC-3161 token (verifies OFFLINE) + a real pending OTS proof.
  const tsaToken = await tsa.stamp(emlHash);
  let otsProof = null;
  try {
    otsProof = await ots.stamp(emlHash);
  } catch (e) {
    console.warn(`  OTS stamp skipped for signer ${index} (${e.message})`);
  }
  return {
    index,
    name,
    email,
    onBehalfOf: index === 2 ? 'Acme Corporation' : null, // signer 2 signs on behalf of (AC-67/77/78)
    signingDomain: DOMAIN,
    selector: SELECTOR,
    signedAt: SIGN_TIME,
    emlSha256: emlHash.toString('hex'),
    rawEml,
    cover,
    dkimKey: txtRecord,
    dkimObservedAt: new Date(SIGN_TIME.getTime() + 1000),
    archiveStatus: 'archived',
    otsProof,
    tsaToken,
    verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' },
  };
}

function envelopeInput(documentOriginal, signers) {
  return {
    envelope: {
      id: '18267982-ca76-45dc-a294-e86039a6343d',
      documentName: 'Mutual NDA',
      documentHash: createHash('sha256').update(documentOriginal).digest('hex'),
      creatorEmail: CREATOR,
      completedAt: new Date('2026-06-20T12:00:00Z'),
    },
    documentOriginal,
    signers,
    verifierBaseUrl: 'https://kysigned.com',
  };
}

function write(name, bytes) {
  writeFileSync(join(OUT, name), Buffer.from(bytes));
  console.log(`  wrote ${name} (${bytes.length} bytes)`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log('Generating evidence-bundle test assets in docs/test-assets/ …');

  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const txtRecord = pemToTxt(kp.publicKey);

  // Shared document D + two per-signer covers (Family B).
  const documentD = await makePdf(['MUTUAL NON-DISCLOSURE AGREEMENT', '', 'Between the parties named on their cover pages.']);
  const coverAlice = await makePdf(['SIGNING COVER PAGE', '', `Signer: Alice Example <${ALICE}>`, 'I sign this document.']);
  const coverBob = await makePdf(['SIGNING COVER PAGE', '', `Signer: Bob Example <${BOB}>`, 'on behalf of Acme Corporation']);

  // Each signer forwards P_i = cover_i ++ D.
  const pAlice = await assembleCanonicalPdf(coverAlice, documentD);
  const pBob = await assembleCanonicalPdf(coverBob, documentD);
  const emlAlice = await signEml(kp.privateKey, ALICE, pAlice);
  const emlBob = await signEml(kp.privateKey, BOB, pBob);

  const sAlice = await signerInput(1, 'Alice Example', ALICE, emlAlice, coverAlice, txtRecord);
  const sBob = await signerInput(2, 'Bob Example', BOB, emlBob, coverBob, txtRecord);

  // ── 1. VALID bundle ───────────────────────────────────────────────────────
  const valid = await assembleBundle(envelopeInput(documentD, [sAlice, sBob]));
  write('sample-bundle.pdf', valid.bytes);
  console.log(`  fingerprint: ${valid.fingerprint}`);

  // ── 2. tamper: document bytes changed (attachment mismatch) ────────────────
  // Rebuild with a DIFFERENT document-original; the .emls still attach the original P_i.
  const documentTampered = await makePdf(['MUTUAL NON-DISCLOSURE AGREEMENT', '', 'TAMPERED: an added secret clause.']);
  write('sample-bundle-tampered-doc.pdf',
    (await assembleBundle(envelopeInput(documentTampered, [sAlice, sBob]))).bytes);

  // ── 3. tamper: one .eml byte flipped in the DKIM-Signature b= value ────────
  // Flipping a byte inside the DKIM `b=` signature value breaks the signature
  // CLEANLY (verify → invalid_signature) and also changes sha256(.eml) so the
  // timestamp no longer matches — without corrupting the base64 attachment body
  // (a faithful "one byte changed" that yields a clean FAILED verdict, not a
  // decode crash). We flip a base64 char in the b= run of the signature header.
  const emlFlipped = (() => {
    const str = Buffer.from(emlAlice).toString('latin1');
    const bIdx = str.search(/b=[A-Za-z0-9+/]{20}/); // the signature value
    const flipAt = bIdx + 5; // a char well inside the b= run
    const ch = str[flipAt];
    const repl = ch === 'A' ? 'B' : 'A'; // a different valid base64 char
    const mutated = str.slice(0, flipAt) + repl + str.slice(flipAt + 1);
    return new Uint8Array(Buffer.from(mutated, 'latin1'));
  })();
  // Keep sAlice's ORIGINAL timestamp proofs + emlSha256 (made over the untampered
  // .eml) but ship the flipped bytes — the realistic post-signing tamper: DKIM
  // fails AND sha256(flipped) ≠ the stamped hash, so the timestamp fails too.
  const sAliceFlipped = { ...sAlice, rawEml: emlFlipped };
  write('sample-bundle-tampered-eml.pdf',
    (await assembleBundle(envelopeInput(documentD, [sAliceFlipped, sBob]))).bytes);

  // ── 4. tamper: timestamp proof over the WRONG hash ─────────────────────────
  const wrongHash = createHash('sha256').update(Buffer.from('not the eml')).digest();
  const sAliceBadTs = {
    ...sAlice,
    tsaToken: await tsa.stamp(wrongHash),
    otsProof: await ots.stamp(wrongHash).catch(() => null),
  };
  write('sample-bundle-tampered-timestamp.pdf',
    (await assembleBundle(envelopeInput(documentD, [sAliceBadTs, sBob]))).bytes);

  // ── 5. tamper: signer email changed in keys.json / mismatched key ──────────
  // A different keypair's public record is embedded for signer 1 → DKIM fails.
  const kp2 = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const sAliceWrongKey = { ...sAlice, dkimKey: pemToTxt(kp2.publicKey) };
  write('sample-bundle-tampered-signer-email.pdf',
    (await assembleBundle(envelopeInput(documentD, [sAliceWrongKey, sBob]))).bytes);

  // ── 6. tamper: rendered signature-page text only (verdict still from the .eml) ──
  // Editing the printed page CANNOT change the embedded evidence: the verifier reads
  // the .eml, so this bundle still verifies PROVEN. We simulate "rendered page altered"
  // by flipping the bundle's own page bytes outside the embedded files: the safest
  // faithful proxy is a SECOND valid bundle rendered with a different displayed name
  // while the .eml (the evidence) is unchanged — verdict unaffected. Here we re-render
  // signer 1's NAME as a different display string; the .eml/email/intent are identical.
  const sAliceRelabelled = { ...sAlice, name: 'NOT ALICE (tampered display name)' };
  write('sample-bundle-tampered-rendered-page.pdf',
    (await assembleBundle(envelopeInput(documentD, [sAliceRelabelled, sBob]))).bytes);

  // ── 7. tamper: substitute a different document behind one signer's cover ───
  // Ship a DIFFERENT cover for signer 1 than the one they signed → reconstruct
  // (wrongCover ++ D) ≠ the .eml attachment → FAILED (operator-forgery defense).
  const wrongCover = await makePdf(['SIGNING COVER PAGE', '', 'Signer: Someone Else', 'substituted cover']);
  const sAliceSubCover = { ...sAlice, cover: wrongCover };
  write('sample-bundle-tampered-cover-substitution.pdf',
    (await assembleBundle(envelopeInput(documentD, [sAliceSubCover, sBob]))).bytes);

  // ── 8. l= tag: a length-limited DKIM signature the verifier must reject (AC-3) ──
  const emlLtag = await signEml(kp.privateKey, ALICE, pAlice, { lTag: true });
  const sAliceLtag = await signerInput(1, 'Alice Example', ALICE, emlLtag, coverAlice, txtRecord);
  write('sample-bundle-l-tag.pdf',
    (await assembleBundle(envelopeInput(documentD, [sAliceLtag, sBob]))).bytes);

  // ── /hashcheck assets (F-25): standalone original + a real sign-request P_i + a
  // tampered sign-request. `pAlice` is signer 1's canonical PDF (cover ++ D), i.e.
  // exactly the sign-request a signer receives attached. (A regen keeps these
  // byte-consistent with this run's bundle; the offline
  // `gen-sign-request-assets.mjs` derives the same three from an EXISTING bundle.)
  write('sample-document-original.pdf', documentD);
  write('sample-sign-request.pdf', pAlice);
  write('sample-sign-request-tampered-doc.pdf', await assembleCanonicalPdf(coverAlice, documentTampered));

  console.log('Done. 12 assets written to docs/test-assets/.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
