/**
 * gen-m365-no-dkim-mock.mjs — the GENERATED Microsoft 365 no-DKIM corporate forward
 * (F-45.1 / AC-279, spec 0.73.1). Writes, under src/api/signing/fixtures/:
 *   m365-corporate-no-dkim.GENERATED.eml   the forward, as kysigned's inbound receives it
 *   m365-corporate-no-dkim.GENERATED.json  what the tests need: envelope, signer, creator,
 *                                          attachment hash, and the stand-in PUBLIC key
 *
 * Why a mock: no corporate Microsoft 365 tenant with DKIM switched off is available to
 * send a real one, and only Microsoft's servers can make an ARC seal the live service
 * verifies. So this builds the message a signer at such a company would send: Exchange
 * Online's header layout (modelled on the real Outlook forward in the private client
 * corpus: the X-MS-Exchange-* family, Microsoft's ARC-Message-Signature header list and
 * its `mx.microsoft.com 1; ... dkim=none` results line); NO DKIM-Signature (Microsoft
 * documents a no-DKIM custom domain's mail as unsigned); and an i=1 ARC set with
 * `d=microsoft.com s=arcselector10001 cv=none`, sealed by the real mailauth code with a
 * FRESH stand-in key made on each run. Only the public half is written (into the .json);
 * tests serve it under Microsoft's key name. Against any other key (Microsoft's real one
 * included) the seal fails, which is exactly how the live service treats this file.
 *
 * Everything in it is fictional: the people and the company sit on the reserved
 * `.example` domain, the envelope is made up, the attachment is a tiny placeholder PDF,
 * and the addresses are documentation ranges. It is marked GENERATED in its file names,
 * its first header, the .json and the fixtures README.
 *
 * Run:  node --import tsx scripts/gen-m365-no-dkim-mock.mjs
 */
import { generateKeyPairSync, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealMessage } from 'mailauth';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'api', 'signing', 'fixtures');
const BASE = 'm365-corporate-no-dkim.GENERATED';

// ── The fictional scenario ────────────────────────────────────────────────────────────
const ENVELOPE_ID = '5e1f0c2a-9b7d-4c3e-8a61-2f4d6b8e0c17';
const ENVELOPE_HEX = ENVELOPE_ID.replaceAll('-', '');
const DOCUMENT = 'Mock Services Agreement (GENERATED TEST)';
const SIGNER = { name: 'Dana Cohen', email: 'dana.cohen@northwind-traders.example' };
const SIGNER_DOMAIN = 'northwind-traders.example';
const CREATOR = { name: 'Sam Rivera', email: 'sam.rivera@fabrikam.example' };
const SIGN_MAILBOX = 'forward-to-sign@kysigned.com';
const REQUEST_FROM = 'kysigned <notifications@kysigned.com>';
const SENT = 'Wed, 23 Sep 2026 09:41:07 +0000';
const RECEIVED = 'Wed, 23 Sep 2026 09:41:09 +0000';
const SEAL_TIME = new Date('2026-09-23T09:41:08Z');
const SERVER = 'SA1PR17MB6189'; // fictional Exchange Online mailbox server
const PEER = 'SA1PR17MB5432'; // fictional transport server
const TENANT_ID = '3f6c1d2e-8b4a-4f0e-9c7d-5a1b2c3d4e5f'; // fictional tenant
const SUBJECT = `Signature requested: "${DOCUMENT}" [ksgn-${ENVELOPE_HEX}]`;

// Deterministic filler (Thread-Index, message ids, the opaque antispam blob) so a
// regeneration only changes the key and the seal.
const det = (label, n) => {
  let out = Buffer.alloc(0);
  for (let i = 0; out.length < n; i++) {
    out = Buffer.concat([out, createHash('sha256').update(`kysigned-m365-mock:${label}:${i}`).digest()]);
  }
  return out.subarray(0, n);
};
const uuidOf = (label) => {
  const h = det(label, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const fold = (name, value, width = 76) => {
  const chunks = value.match(new RegExp(`.{1,${width}}`, 'g')) ?? [value];
  return `${name}: ${chunks.join('\r\n ')}`;
};

const MSG_KEY = det('message-id', 16).toString('hex').toUpperCase();
const BOUNDARY_MIXED = `_004_${SERVER}${MSG_KEY}${SERVER}namp_`;
const BOUNDARY_ALT = `_000_${SERVER}${MSG_KEY}${SERVER}namp_`;

// ── The attachment: a tiny placeholder PDF (only its hash matters to the pipeline) ────
const PDF = Buffer.from(
  '%PDF-1.7\n% GENERATED MOCK attachment for the kysigned F-45.1 fixture: not a real document.\n%%EOF\n',
  'latin1',
);
const PDF_NAME = `${DOCUMENT}.pdf`;

// ── The forward's body, as Outlook writes it ──────────────────────────────────────────
const quoted = [
  '________________________________',
  `From: ${REQUEST_FROM}`,
  'Sent: Wednesday, September 23, 2026 12:36 PM',
  `To: ${SIGNER.name} <${SIGNER.email}>`,
  `Subject: ${SUBJECT}`,
  '',
  `Hi ${SIGNER.name},`,
  '',
  `${CREATOR.name} has requested your signature on "${DOCUMENT}". The document is attached to this email.`,
];
const textPart = ['I sign this document', '', ...quoted, ''].join('\r\n');
const escape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const htmlPart = [
  '<html>',
  '<head>',
  '<meta http-equiv="Content-Type" content="text/html; charset=us-ascii">',
  '</head>',
  '<body dir="ltr">',
  '<div style="font-family: Aptos, sans-serif; font-size: 12pt;">I sign this document</div>',
  '<div><br></div>',
  '<hr style="display:inline-block;width:98%" tabindex="-1">',
  '<div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" style="font-size:11pt" color="#000000">',
  `<b>From:</b> ${escape(REQUEST_FROM)}<br>`,
  '<b>Sent:</b> Wednesday, September 23, 2026 12:36 PM<br>',
  `<b>To:</b> ${escape(`${SIGNER.name} <${SIGNER.email}>`)}<br>`,
  `<b>Subject:</b> ${escape(SUBJECT)}</font>`,
  '<div>&nbsp;</div>',
  '</div>',
  `<div><p>Hi ${escape(SIGNER.name)},</p>`,
  `<p>${escape(CREATOR.name)} has requested your signature on &ldquo;${escape(DOCUMENT)}&rdquo;. The document is attached to this email.</p></div>`,
  '</body>',
  '</html>',
  '',
].join('\r\n');
const pdfB64 = (PDF.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');

const body = [
  `--${BOUNDARY_MIXED}`,
  `Content-Type: multipart/alternative; boundary="${BOUNDARY_ALT}"`,
  '',
  `--${BOUNDARY_ALT}`,
  'Content-Type: text/plain; charset="us-ascii"',
  'Content-Transfer-Encoding: 7bit',
  '',
  textPart,
  `--${BOUNDARY_ALT}`,
  'Content-Type: text/html; charset="us-ascii"',
  'Content-Transfer-Encoding: 7bit',
  '',
  htmlPart,
  `--${BOUNDARY_ALT}--`,
  '',
  `--${BOUNDARY_MIXED}`,
  `Content-Type: application/pdf; name="${PDF_NAME}"`,
  `Content-Description: ${PDF_NAME}`,
  `Content-Disposition: attachment; filename="${PDF_NAME}"; size=${PDF.length};`,
  '\tcreation-date="Wed, 23 Sep 2026 09:40:58 GMT";',
  '\tmodification-date="Wed, 23 Sep 2026 09:41:07 GMT"',
  'Content-Transfer-Encoding: base64',
  '',
  pdfB64,
  '',
  `--${BOUNDARY_MIXED}--`,
  '',
].join('\r\n');

// ── The message as Exchange Online sends it (before the seal) ─────────────────────────
const asSent = [
  `Received: from ${SERVER}.namprd17.prod.outlook.com (2001:db8:806:1bd::9) by`,
  ` ${PEER}.namprd17.prod.outlook.com (2001:db8:806:1be::7) with Microsoft SMTP`,
  ' Server (version=TLS1_2, cipher=TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384) id',
  ` 15.20.9160.12; ${SENT}`,
  `Received: from ${SERVER}.namprd17.prod.outlook.com`,
  ` ([fe80::db8:1]) by ${SERVER}.namprd17.prod.outlook.com`,
  ` ([fe80::db8:1%4]) with mapi id 15.20.9160.012; ${SENT}`,
  `From: ${SIGNER.name} <${SIGNER.email}>`,
  `To: "${SIGN_MAILBOX}" <${SIGN_MAILBOX}>`,
  `Subject: FW: ${SUBJECT}`,
  `Thread-Topic: ${SUBJECT}`,
  `Thread-Index: ${det('thread-index', 22).toString('base64')}`,
  `Date: ${SENT}`,
  `Message-ID: <${SERVER}${MSG_KEY}@${SERVER}.namprd17.prod.outlook.com>`,
  `References: <ksgn-${ENVELOPE_HEX}.request@kysigned.com>`,
  `In-Reply-To: <ksgn-${ENVELOPE_HEX}.request@kysigned.com>`,
  'Accept-Language: en-US',
  'Content-Language: en-US',
  'X-MS-Has-Attach: yes',
  'X-MS-TNEF-Correlator:',
  'x-ms-publictraffictype: Email',
  `x-ms-traffictypediagnostic: ${SERVER}:EE_|${PEER}:EE_`,
  `x-ms-office365-filtering-correlation-id: ${uuidOf('correlation')}`,
  'x-ms-exchange-antispam-messagedata-chunkcount: 1',
  fold('x-ms-exchange-antispam-messagedata-0', det('antispam', 240).toString('base64')),
  `Content-Type: multipart/mixed; boundary="${BOUNDARY_MIXED}"`,
  'MIME-Version: 1.0',
  `X-OriginatorOrg: ${SIGNER_DOMAIN}`,
  'X-MS-Exchange-CrossTenant-AuthAs: Internal',
  `X-MS-Exchange-CrossTenant-AuthSource: ${SERVER}.namprd17.prod.outlook.com`,
  `X-MS-Exchange-CrossTenant-Network-Message-Id: ${uuidOf('network-message-id')}`,
  'X-MS-Exchange-CrossTenant-originalarrivaltime: 23 Sep 2026 09:41:07.4213 (UTC)',
  'X-MS-Exchange-CrossTenant-fromentityheader: Hosted',
  `X-MS-Exchange-CrossTenant-id: ${TENANT_ID}`,
  'X-MS-Exchange-CrossTenant-mailboxtype: HOSTED',
  `X-MS-Exchange-Transport-CrossTenantHeadersStamped: ${PEER}`,
  '',
  body,
].join('\r\n');

// ── The seal: i=1, as Exchange Online stamps outgoing mail, under a stand-in key ──────
const kp = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const standInTxt = `v=DKIM1; k=rsa; p=${kp.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')}`;
const arcHeaders = await sealMessage(asSent, {
  signingDomain: 'microsoft.com',
  selector: 'arcselector10001',
  privateKey: kp.privateKey,
  cv: 'none',
  authResults: 'mx.microsoft.com 1; spf=none; dmarc=none; dkim=none; arc=none',
  // Microsoft's ARC-Message-Signature header set. mailauth reads this as ONE
  // colon-separated string (an array silently falls back to its default list).
  headerList:
    'From:Date:Subject:Message-ID:Content-Type:MIME-Version:' +
    'X-MS-Exchange-AntiSpam-MessageData-ChunkCount:X-MS-Exchange-AntiSpam-MessageData-0',
  signTime: SEAL_TIME,
});

// ── What kysigned's inbound adds on receipt (above the seal), plus the GENERATED mark ─
const received = [
  'X-Kysigned-Fixture: GENERATED MOCK, not real mail. A Microsoft 365 corporate',
  " tenant's forward with DKIM off (F-45.1 / AC-279). Its ARC seal is made with a",
  " stand-in test key, not Microsoft's. See src/api/signing/fixtures/README.md.",
  `Return-Path: <${SIGNER.email}>`,
  'Received: from NAM12-SN1-obe.outbound.protection.outlook.com (198.51.100.101)',
  ` by inbound-smtp.us-east-1.amazonaws.com with SMTP id ${det('ses-id', 16).toString('hex')}`,
  ` for ${SIGN_MAILBOX}; ${RECEIVED}`,
  `Received-SPF: pass (spfCheck: domain of ${SIGNER_DOMAIN} designates 198.51.100.101`,
  ` as permitted sender) client-ip=198.51.100.101; envelope-from=${SIGNER.email};`,
  ' helo=NAM12-SN1-obe.outbound.protection.outlook.com;',
  `Authentication-Results: amazonses.com; spf=pass (spfCheck: domain of ${SIGNER_DOMAIN}`,
  ` designates 198.51.100.101 as permitted sender) client-ip=198.51.100.101;`,
  ` envelope-from=${SIGNER.email}; helo=NAM12-SN1-obe.outbound.protection.outlook.com;`,
  ` dkim=none header.i=unknown; dmarc=none header.from=${SIGNER_DOMAIN};`,
  '',
].join('\r\n');

const eml = received + arcHeaders.toString('utf8') + asSent;

const meta = {
  generated: true,
  note:
    "GENERATED MOCK, not real mail: a Microsoft 365 corporate tenant's forward with DKIM off, sealed " +
    "with a stand-in test key instead of Microsoft's. Only a test resolver serving standInKeys makes the seal verify.",
  generator: 'scripts/gen-m365-no-dkim-mock.mjs',
  generatedAt: new Date().toISOString(),
  scenario:
    'Microsoft 365 tenant, custom domain, DKIM off: the forward carries no DKIM-Signature and one ARC set (i=1, d=microsoft.com, s=arcselector10001, cv=none).',
  envelope: { id: ENVELOPE_ID, hex: ENVELOPE_HEX, documentName: DOCUMENT, creator: CREATOR },
  signer: { ...SIGNER, domain: SIGNER_DOMAIN },
  attachment: { filename: PDF_NAME, sha256: createHash('sha256').update(PDF).digest('hex') },
  standInKeys: { 'arcselector10001._domainkey.microsoft.com': standInTxt },
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `${BASE}.eml`), eml);
writeFileSync(join(OUT, `${BASE}.json`), `${JSON.stringify(meta, null, 2)}\n`);
console.log(`wrote ${BASE}.eml (${eml.length} bytes) and ${BASE}.json`);
