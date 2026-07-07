#!/usr/bin/env node
/**
 * Generates `docs/test-assets/acme-anvil-waiver.pdf` — a second deliberately-silly
 * kysigned trial document, a companion to `acme-approval.pdf`. Having two
 * fixtures lets forkers (and the e2e suite) exercise the signing flow with more
 * than one document.
 *
 * kysigned documents are signed by EMAIL, not with handwritten signature lines:
 * a signer replies to the kysigned message from their own address with the
 * intent phrase, and their DKIM-authenticated email is the signature. So this
 * document carries NO names/signatures block — it closes with an
 * execution-by-email clause, and the signers are chosen when the envelope is
 * created, not baked into the page. (The engine wraps the finished document
 * with its own cover and signature/proof pages; those are never drawn here.)
 *
 * The document:
 *   - Is completely placeholder text (no real names, no real emails, no real
 *     legal weight) so it's safe to ship publicly.
 *   - Carries a "TEST DOCUMENT — NOT LEGALLY BINDING" watermark so nobody
 *     accidentally tries to use it in production.
 *
 * Run:
 *   cd kysigned
 *   node docs/test-assets/build-acme-anvil-waiver.mjs
 *
 * Output:
 *   docs/test-assets/acme-anvil-waiver.pdf
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const doc = await PDFDocument.create();
  doc.setTitle('ACME Anvil Liability Waiver — kysigned trial document');
  doc.setAuthor('kysigned');
  doc.setSubject('Sample trial document for testing the kysigned signing flow');
  doc.setKeywords(['kysigned', 'test', 'sample', 'waiver', 'anvil', 'ACME']);
  doc.setProducer('kysigned docs/test-assets/build-acme-anvil-waiver.mjs');

  const page = doc.addPage([612, 792]); // US Letter
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const helvOblique = await doc.embedFont(StandardFonts.HelveticaOblique);

  const navy = rgb(0.10, 0.10, 0.18);
  const grey = rgb(0.42, 0.42, 0.48);
  const lightGrey = rgb(0.82, 0.82, 0.86);
  const paleNavy = rgb(0.93, 0.93, 0.97);

  // --- Watermark (pale, behind everything) ----------------------------------
  page.drawText('TEST DOCUMENT — NOT LEGALLY BINDING', {
    x: 45,
    y: 380,
    size: 32,
    font: helvBold,
    color: rgb(0.95, 0.95, 0.98),
    rotate: { type: 'degrees', angle: 30 },
  });

  // --- Header bar -----------------------------------------------------------
  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: paleNavy });
  page.drawText('> ACME Corporation', { x: 50, y: 762, size: 18, font: helvBold, color: navy });
  page.drawText('Widgets, sprockets, anvils, and adjacent engineered goods.', {
    x: 50, y: 748, size: 9, font: helvOblique, color: grey,
  });

  // --- Title ----------------------------------------------------------------
  page.drawText('ANVIL LIABILITY WAIVER 13-K', { x: 50, y: 705, size: 22, font: helvBold, color: navy });
  page.drawText('ACME accepts no responsibility for gravity. (You know how to sign.)', {
    x: 50, y: 684, size: 12, font: helvOblique, color: grey,
  });

  // --- Divider --------------------------------------------------------------
  page.drawLine({
    start: { x: 50, y: 670 }, end: { x: 562, y: 670 },
    thickness: 0.8, color: lightGrey,
  });

  // --- Preamble -------------------------------------------------------------
  const preamble = [
    'WHEREAS the undersigned wishes to acquire, deploy, and/or stand directly',
    'beneath one (1) or more genuine ACME-brand anvils (the "Anvil"), and',
    '',
    'WHEREAS the Anvil is engineered to a single, uncompromising specification —',
    'namely, to be extremely heavy and to travel reliably downward, and',
    '',
    'WHEREAS the laws of physics are not manufactured, distributed, or warranted',
    'by ACME and are hereby expressly excluded from this and all other terms,',
    '',
    'NOW THEREFORE the undersigned, by signing through kysigned as set out below,',
    'acknowledge and accept the following terms:',
    '',
    '  1. The Anvil shall go down, not up.',
    '  2. ACME is not liable for any coyote, customer, or passing party located',
    '     at the terminal point of the Anvil\'s descent.',
    '  3. "Look up" constitutes the entirety of the safety training provided.',
    '  4. The signing of this document is itself a successful test of the',
    '     kysigned signing flow, which is the real purpose here.',
    '',
    'The undersigned further acknowledge that this document is a TEST FIXTURE',
    'from the kysigned public repository, is NOT legally binding, and carries',
    'the legal weight of a polite suggestion scrawled on a napkin.',
  ];

  let y = 640;
  for (const line of preamble) {
    page.drawText(line, { x: 50, y, size: 10, font: helv, color: navy });
    y -= 14;
  }

  // --- Execution clause -----------------------------------------------------
  // kysigned documents are NOT signed with handwritten signature lines. Each
  // party signs by replying to the kysigned email from their own address with
  // the intent phrase; their DKIM-authenticated email IS the signature, and the
  // proof is sealed into the evidence bundle. So the document closes with an
  // execution-by-email clause instead of a names/signatures block. (kysigned
  // also wraps the finished document with its own cover and signature/proof
  // pages — those are generated by the engine, never drawn here.)
  y -= 8;
  page.drawLine({
    start: { x: 50, y }, end: { x: 562, y },
    thickness: 0.8, color: lightGrey,
  });
  y -= 22;
  page.drawText('EXECUTION', { x: 50, y, size: 12, font: helvBold, color: navy });
  y -= 20;

  const execution = [
    'IN WITNESS WHEREOF, the parties execute this waiver by electronic mail rather',
    'than by hand. There are no signature lines, and none are required.',
    '',
    'Each party signs from their own email address by replying to the kysigned',
    'message that delivered this document with the words "I sign this document."',
    'That reply, authenticated by the DKIM signature its sending domain attaches,',
    'is the party\'s binding electronic signature — the signature lives in the',
    'email, not on this page.',
    '',
    'kysigned seals every signature, the exact document signed, and an independent',
    'timestamp into an evidence bundle that anyone may verify without trusting',
    'ACME, the signer, or kysigned. By so replying, each party adopts their email',
    'as their signature, intends to be bound to the same extent as a handwritten',
    'signature, and accepts all gravitational outcomes as final.',
  ];
  for (const line of execution) {
    page.drawText(line, { x: 50, y, size: 10, font: helv, color: navy });
    y -= 14;
  }

  // --- Footer ---------------------------------------------------------------
  const footerY = 42;
  page.drawLine({
    start: { x: 50, y: footerY + 12 }, end: { x: 562, y: footerY + 12 },
    thickness: 0.5, color: lightGrey,
  });
  page.drawText(
    'Generated by kysigned · Trial document · github.com/kychee-com/kysigned',
    { x: 50, y: footerY, size: 8, font: helvOblique, color: grey },
  );
  page.drawText('TEST — NOT LEGALLY BINDING', {
    x: 430, y: footerY, size: 8, font: helvBold, color: grey,
  });

  const bytes = await doc.save();
  const outPath = join(__dirname, 'acme-anvil-waiver.pdf');
  writeFileSync(outPath, bytes);
  console.log(`wrote ${outPath} (${bytes.length} bytes)`);
}

main().catch((err) => {
  console.error('build-acme-anvil-waiver failed:', err);
  process.exit(1);
});
