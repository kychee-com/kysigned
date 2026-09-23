/**
 * F-45 email templates (spec 0.72.0, #166): the provider no-DKIM signer bounce
 * (AC-272), the provider creator notice (AC-273), and the general creator notice
 * for every other rejection class (AC-277). Also pins the six generic bounce
 * headlines so the F-45 split cannot drift the existing copy.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { templates, type CreatorNoticeReason, type GenericRejectionReason } from './templates.js';

const EM_DASH = String.fromCodePoint(0x2014);
const EN_DASH = String.fromCodePoint(0x2013);
type Rendered = { subject: string; html: string; text: string; from?: string; replyTo?: string };

function assertOutbound(r: Rendered, label: string): void {
  for (const [part, value] of Object.entries({ subject: r.subject, html: r.html, text: r.text })) {
    assert.ok(!value.includes(EM_DASH) && !value.includes(EN_DASH), `${label} ${part}: no em or en dash`);
    assert.ok(!value.includes('undefined'), `${label} ${part}: no "undefined"`);
  }
  assert.equal(r.from, 'notifications@kysigned.com', `${label}: From notifications@`);
  assert.equal(r.replyTo, 'info@kysigned.com', `${label}: Reply-To info@`);
}

function both(r: Rendered, re: RegExp | string, label: string): void {
  for (const [part, value] of [['html', r.html], ['text', r.text]] as const) {
    if (typeof re === 'string') assert.ok(value.includes(re), `${label}: ${part} includes ${re}`);
    else assert.match(value, re, `${label}: ${part}`);
  }
}

const PROVIDERS = [
  { reason: 'google_workspace_no_dkim', name: 'Google Workspace', where: 'Google Admin console', anchor: 'email-setup-google' },
  { reason: 'microsoft_365_no_dkim', name: 'Microsoft 365', where: 'Microsoft Defender portal', anchor: 'email-setup-microsoft' },
] as const;

describe('providerNoDkimBounce (F-45.2 / AC-272)', () => {
  for (const p of PROVIDERS) {
    const r = templates.providerNoDkimBounce({
      signerName: 'Alice', documentName: 'NDA', operatorDomain: 'kysigned.com',
      reason: p.reason, signerDomain: 'example.org', senderName: 'bob@creator.test',
    });

    it(`${p.name}: keeps the familiar subject`, () => {
      assert.match(r.subject, /^Action needed: your signature on "NDA" wasn.t accepted$/);
    });

    it(`${p.name}: no blame, and forwarding again won't help until it's on`, () => {
      both(r, /did everything right/i, p.name);
      both(r, /forwarding again won.t help/i, p.name);
    });

    it(`${p.name}: names the domain, the provider, and where the admin switches it on`, () => {
      both(r, 'example.org', p.name);
      both(r, p.name, p.name);
      both(r, p.where, p.name);
      both(r, /only your email administrator can switch (it )?on/i, p.name);
    });

    it(`${p.name}: a copy-ready admin line that names DKIM and links this provider's FAQ steps`, () => {
      both(r, /Please turn on DKIM email signing for example\.org/, p.name);
      both(r, `https://kysigned.com/faq#${p.anchor}`, p.name);
    });

    it(`${p.name}: forward the original again once it's on; ask the sender to sign sooner`, () => {
      both(r, /forward the original signing email again/i, p.name);
      both(r, /sign sooner/i, p.name);
      both(r, 'bob@creator.test', p.name);
    });

    it(`${p.name}: none of the generic bounce's transport advice`, () => {
      for (const re of [/forward button/i, /copy-?paste/i, /mailing list/i, /download-and-reattach/i]) {
        assert.doesNotMatch(r.html, re);
        assert.doesNotMatch(r.text, re);
      }
    });

    it(`${p.name}: outbound hygiene (no dashes, notifications@, Reply-To info@)`, () => {
      assertOutbound(r, p.name);
    });
  }

  it('escapes creator-supplied values in the HTML, keeps them literal in the text', () => {
    const r = templates.providerNoDkimBounce({
      signerName: 'Alice', documentName: '<b>NDA</b>', operatorDomain: 'kysigned.com',
      reason: 'google_workspace_no_dkim', signerDomain: 'example.org', senderName: '<i>Bob</i>',
    });
    assert.ok(!r.html.includes('<b>NDA</b>') && r.html.includes('&lt;b&gt;NDA&lt;/b&gt;'));
    assert.ok(!r.html.includes('<i>Bob</i>') && r.html.includes('&lt;i&gt;Bob&lt;/i&gt;'));
    assert.ok(r.text.includes('<b>NDA</b>'));
  });
});

describe('signerBlockedCreatorNotice (F-45.3 (a) / AC-273)', () => {
  for (const p of PROVIDERS) {
    const r = templates.signerBlockedCreatorNotice({
      signerName: 'Alice', signerEmail: 'alice@example.org', documentName: 'NDA', operatorDomain: 'kysigned.com',
      reason: p.reason, signerDomain: 'example.org', statusPageLink: 'https://kysigned.com/dashboard/envelope/env-1',
    });

    it(`${p.name}: subject names the signer, the document, and the setup`, () => {
      assert.match(r.subject, /^Alice can.t sign "NDA" until their email is set up$/);
    });

    it(`${p.name}: who, what, not their fault, and that the signer was told`, () => {
      both(r, 'alice@example.org', p.name);
      both(r, 'example.org', p.name);
      both(r, p.name, p.name);
      both(r, /did nothing wrong/i, p.name);
      both(r, /sent them instructions/i, p.name);
    });

    it(`${p.name}: both remedies (admin switches on DKIM here; or change their address)`, () => {
      both(r, /DKIM/, p.name);
      both(r, p.where, p.name);
      both(r, `https://kysigned.com/faq#${p.anchor}`, p.name);
      both(r, /change their email on the document.s page/i, p.name);
    });

    it(`${p.name}: deep-links the envelope status page, outbound hygiene`, () => {
      both(r, 'https://kysigned.com/dashboard/envelope/env-1', p.name);
      assertOutbound(r, p.name);
    });
  }
});

describe('signerRejectedCreatorNotice (F-45.3 (b) / AC-277)', () => {
  const REASONS: Record<CreatorNoticeReason, RegExp> = {
    wrong_phrase: /first line of their forward wasn.t .I sign this document./i,
    attachment_missing: /document wasn.t attached/i,
    attachment_modified: /attached document had been changed/i,
    sender_auth: /didn.t pass our sender checks/i,
    dkim_unverifiable: /signature on the forward didn.t verify/i,
  };
  const render = (reason: CreatorNoticeReason) =>
    templates.signerRejectedCreatorNotice({
      signerName: 'Alice', signerEmail: 'alice@x.com', documentName: 'NDA', operatorDomain: 'kysigned.com',
      reason, statusPageLink: 'https://kysigned.com/dashboard/envelope/env-1',
    });

  for (const [reason, line] of Object.entries(REASONS) as Array<[CreatorNoticeReason, RegExp]>) {
    it(`${reason}: subject, its plain reason line, signer already told, change-address, status link`, () => {
      const r = render(reason);
      assert.match(r.subject, /^Alice.s signature on "NDA" wasn.t accepted$/);
      both(r, line, reason);
      both(r, 'alice@x.com', reason);
      both(r, /already emailed them/i, reason);
      both(r, /different email address of theirs/i, reason);
      both(r, 'https://kysigned.com/dashboard/envelope/env-1', reason);
      assertOutbound(r, reason);
    });
  }

  it('each class has its own reason line (no two notices read the same)', () => {
    const texts = (Object.keys(REASONS) as CreatorNoticeReason[]).map((reason) => render(reason).text);
    assert.equal(new Set(texts).size, texts.length);
  });
});

describe('generic bounce headlines are unchanged by the F-45 split (regression pin)', () => {
  const HEADLINES: Record<GenericRejectionReason, RegExp> = {
    wrong_phrase: /Your forward needs the exact signing line/,
    attachment_missing: /The document wasn.t attached/,
    attachment_modified: /The attached document didn.t match the original/,
    sender_auth: /Your email failed sender authentication/,
    dkim_unverifiable: /We couldn.t verify your email.s signature/,
    envelope_inactive: /This signing request is no longer active/,
  };
  for (const [reason, headline] of Object.entries(HEADLINES) as Array<[GenericRejectionReason, RegExp]>) {
    it(`${reason} keeps its headline`, () => {
      const r = templates.rejectionBounce({
        signerName: 'Alice', documentName: 'NDA', operatorDomain: 'kysigned.com', reason,
        howItWorksLink: 'h', faqHowToSignLink: 'f1', faqWrongEmailLink: 'f2',
      });
      assert.match(r.text, headline);
    });
  }
});
