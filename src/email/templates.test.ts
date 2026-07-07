import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { templates } from './templates.js';
import { parseEnvelopeToken } from '../api/subjectToken.js';

// ── Canonical enumeration of EVERY outbound template ─────────────────────────
// The single source of truth for the suite-wide sweeps (AC-55 friendly subjects,
// AC-61 mailbox purity). A NEW template MUST be added here — then both sweeps
// cover it automatically, so a wrong subject or a wrong From mailbox can't slip
// past unnoticed.
const SWEEP_ENV = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
type RenderedEmail = { subject: string; html: string; text: string; from?: string; replyTo?: string };
function buildAllTemplates(op: string): Record<string, RenderedEmail> {
  return {
    signingRequest: templates.signingRequest({ signerName: 'Alice', senderName: 'Bob', documentName: 'NDA', envelopeId: SWEEP_ENV, reviewLink: 'http://x', howItWorksLink: 'http://h', operatorDomain: op }),
    reminder: templates.reminder({ signerName: 'Alice', senderName: 'Bob', documentName: 'NDA', envelopeId: SWEEP_ENV, reviewLink: 'http://x', howItWorksLink: 'http://h', operatorDomain: op, reminderNumber: 1 }),
    acceptanceAck: templates.acceptanceAck({ signerName: 'Alice', documentName: 'NDA', operatorDomain: op }),
    rejectionBounce: templates.rejectionBounce({ signerName: 'Alice', documentName: 'NDA', operatorDomain: op, reason: 'wrong_phrase', howItWorksLink: 'http://h', faqHowToSignLink: 'http://f1', faqWrongEmailLink: 'http://f2' }),
    completion: templates.completion({ recipientName: 'Alice', documentName: 'NDA', signerCount: 2, role: 'creator', bundleFingerprint: 'a'.repeat(64), verifyUrl: 'http://x/verify', dashboardLink: 'http://d', operatorDomain: op }),
    voidNotification: templates.voidNotification({ signerName: 'Alice', senderName: 'Bob', documentName: 'NDA', operatorDomain: op }),
    expiryNotification: templates.expiryNotification({ recipientName: 'Alice', documentName: 'NDA', operatorDomain: op }),
    retentionWarning: templates.retentionWarning({ recipientName: 'Alice', documentName: 'NDA', deletionDate: '2026-07-01', operatorDomain: op }),
    envelopeExpired: templates.envelopeExpired({ recipientName: 'Alice', documentName: 'NDA', senderName: 'Bob', role: 'sender', signedCount: 1, totalCount: 2, signedNames: ['Bob'], pendingNames: ['Alice'], operatorDomain: op }),
    envelopeCreated: templates.envelopeCreated({ documentName: 'NDA', envelopeId: SWEEP_ENV, signers: [{ name: 'Alice', email: 'a@x.com', status: 'pending' }], dashboardLink: 'http://d', operatorDomain: op }),
    creatorProgress: templates.creatorProgress({ signerName: 'Alice', documentName: 'NDA', signedCount: 1, totalCount: 2, statusPageLink: 'http://s', operatorDomain: op }),
    signingRequestUndeliverable: templates.signingRequestUndeliverable({ senderName: 'Bob', documentName: 'NDA', signerEmail: 'a@x.com', dashboardLink: 'http://d', operatorDomain: op }),
  };
}

// F-19.1 partition: EXACTLY the two SIGNING-channel templates are From
// forward-to-sign@; everything else is status mail From notifications@. Both
// F-5.2 (routing token) and AC-61 (mailbox purity) rest on this set.
const SIGNING_CHANNEL_TEMPLATES = new Set(['signingRequest', 'reminder']);

describe('email templates', () => {
  it('signingRequest renders the forward-to-sign instructions + a name greeting; declaration is on the cover (F-5.1/F-22)', () => {
    const result = templates.signingRequest({
      signerName: 'Alice',
      signerEmail: 'alice@example.com',
      senderName: 'Bob',
      documentName: 'NDA',
      envelopeId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      reviewLink: 'https://kysigned.com/review/env-001/token123',
      howItWorksLink: 'https://kysigned.com/how-it-works',
      operatorDomain: 'kysigned.com',
    });
    // F-5.8 friendly subject + F-5.2 forward-surviving routing token.
    assert.ok(result.subject.includes('NDA'));
    assert.match(result.subject, /\[ksgn-f47ac10b58cc4372a5670e02b2c3d479\]/);
    // Forward instructions + the normal-case intent line (caps never required).
    assert.ok(result.html.includes('Alice'));
    assert.ok(result.html.includes('Bob'));
    // The address is anti-linkified (GH#7), so it is contiguous only once tags are
    // stripped — what the signer actually reads.
    assert.ok(result.html.replace(/<[^>]+>/g, '').includes('forward-to-sign@kysigned.com'));
    assert.ok(result.html.includes('I sign this document'));
    assert.ok(result.html.includes('how-it-works'));
    // Family B: a friendly name GREETING stays in the email body (F-5.1), but the
    // per-signer legal declaration moved to the COVER (F-22) — so it is NOT here.
    assert.match(result.html, /Hi Alice,/);
    assert.ok(!/am signing this document using this email address/i.test(result.html), 'declaration is on the cover, not the email body');
    // text mirror carries the forward instructions + intent line.
    assert.ok(result.text.includes('forward-to-sign@kysigned.com'));
    assert.ok(result.text.includes('I sign this document'));
    // Signing mailbox From/Reply-To (F-19).
    assert.equal(result.from, 'forward-to-sign@kysigned.com');
    assert.equal(result.replyTo, 'forward-to-sign@kysigned.com');
  });

  it('signingRequest uses an explicit generated signing mailbox address when provided', () => {
    const result = templates.signingRequest({
      signerName: 'Alice',
      signerEmail: 'alice@example.com',
      senderName: 'Bob',
      documentName: 'NDA',
      envelopeId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      reviewLink: 'https://kysigned5.run402.com/review/env-001/token123',
      howItWorksLink: 'https://kysigned5.run402.com/how-it-works',
      operatorDomain: 'kysigned5.run402.com',
      signingEmail: 'forward-to-sign@kysigned5.mail.run402.com',
    });

    assert.ok(result.html.replace(/<[^>]+>/g, '').includes('forward-to-sign@kysigned5.mail.run402.com'));
    assert.equal(result.from, 'forward-to-sign@kysigned5.mail.run402.com');
    assert.equal(result.replyTo, 'forward-to-sign@kysigned5.mail.run402.com');
  });

  it('signingRequest carries NO Mode-2 residue (no mailto / hash-check / all-caps)', () => {
    const result = templates.signingRequest({
      signerName: 'Alice', signerEmail: 'alice@example.com', senderName: 'Bob',
      documentName: 'NDA', envelopeId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      reviewLink: 'https://kysigned.com/review/env-001/token123',
      howItWorksLink: 'https://kysigned.com/how-it-works', operatorDomain: 'kysigned.com',
    });
    assert.ok(!/mailto:/i.test(result.html), 'no mailto Sign link (forward model)');
    assert.ok(!/hash-check/i.test(result.html), 'no signer hash-check (F-5.4)');
    assert.ok(!/I SIGN THIS DOCUMENT/.test(result.html), 'intent phrase displayed normal-case');
  });

  it('GH#7 — the forward-to-sign address is not a client-auto-linkable token (no blank-compose trap)', () => {
    const result = templates.signingRequest({
      signerName: 'Alice', signerEmail: 'alice@example.com', senderName: 'Bob',
      documentName: 'NDA', envelopeId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      reviewLink: 'https://kysigned.com/review/env-001/token123',
      howItWorksLink: 'https://kysigned.com/how-it-works', operatorDomain: 'kysigned.com',
    });
    // To a human the address still reads correctly when tags are stripped...
    const visible = result.html.replace(/<[^>]+>/g, '');
    assert.ok(visible.includes('forward-to-sign@kysigned.com'), 'address still reads correctly to the signer');
    // ...but the raw HTML must NOT carry it as one contiguous token, or Gmail / Apple
    // Mail / Outlook auto-linkify it into a mailto: link whose tap opens a blank
    // compose window (the GH#7 dead-end). Splitting it with inline markup defeats the
    // client linkifier while keeping the text identical and copy-paste-clean.
    assert.ok(!result.html.includes('forward-to-sign@kysigned.com'),
      'address is split by markup so clients do not auto-linkify it');
    assert.ok(!/mailto:/i.test(result.html), 'still no explicit mailto link');
  });

  it('keeps the on-behalf-of declaration OFF the email body — it lives on the cover (F-22)', () => {
    const base = {
      signerName: 'Alice', signerEmail: 'alice@example.com', senderName: 'Bob',
      documentName: 'MSA', envelopeId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      reviewLink: 'https://x', howItWorksLink: 'https://h', operatorDomain: 'kysigned.com',
    };
    // Family B: the authority declaration is in the signed cover bytes, never the
    // email body — neither variant renders it in the email.
    const withOrg = templates.signingRequest({ ...base, onBehalfOf: 'Acme Corp' });
    assert.ok(!/on behalf of/i.test(withOrg.html), 'on-behalf-of declaration is on the cover, not the email');
    const without = templates.signingRequest(base);
    assert.ok(!/on behalf of/i.test(without.html), 'no on-behalf-of line in the email');
  });

  it('reminder is a NUDGE (5.4/5.5): clean subject (no token), points to the original, From forward-to-sign@', () => {
    const result = templates.reminder({
      signerName: 'Alice',
      senderName: 'bob@acme.com',
      documentName: 'NDA',
      envelopeId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      reviewLink: 'https://kysigned.com/review/env-001/token123',
      howItWorksLink: 'https://kysigned.com/how-it-works',
      operatorDomain: 'kysigned.com',
      reminderNumber: 1,
    });
    // A reminder is NOT the signing email — no routing token, nothing to forward.
    assert.ok(!/\[ksgn-/i.test(result.subject), 'no routing token in the reminder subject');
    assert.match(result.subject, /Reminder/i);
    assert.match(result.html, /original signature-request email/i, 'points to the original request');
    assert.match(result.html, /spam/i, 'spam-folder fallback');
    assert.match(result.html, /resend/i, 'contact-sender fallback');
    assert.ok(result.html.includes('mailto:bob@acme.com'), 'lets them email the sender');
    assert.ok(!/I SIGN THIS DOCUMENT/.test(result.html), 'no all-caps intent phrase');
    // Still on the signing channel so it threads with the original request.
    assert.equal(result.from, 'forward-to-sign@kysigned.com');
    assert.equal(result.replyTo, 'forward-to-sign@kysigned.com');
  });

  it('reminder uses an explicit generated signing mailbox address when provided', () => {
    const result = templates.reminder({
      signerName: 'Alice',
      senderName: 'bob@acme.com',
      documentName: 'NDA',
      envelopeId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      reviewLink: 'https://kysigned5.run402.com/review/env-001/token123',
      howItWorksLink: 'https://kysigned5.run402.com/how-it-works',
      operatorDomain: 'kysigned5.run402.com',
      signingEmail: 'forward-to-sign@kysigned5.mail.run402.com',
      reminderNumber: 1,
    });

    assert.equal(result.from, 'forward-to-sign@kysigned5.mail.run402.com');
    assert.equal(result.replyTo, 'forward-to-sign@kysigned5.mail.run402.com');
  });

  // F-7.3 / AC-45 — acceptance acknowledgment (replaces the Mode-2
  // signerConfirmation). Affirmative cue, "once everyone has signed".
  describe('acceptanceAck (F-7.3 / AC-45)', () => {
    it('confirms recording with an affirmative cue and the completion wait', () => {
      const r = templates.acceptanceAck({ signerName: 'Alice', documentName: 'NDA', operatorDomain: 'kysigned.com' });
      assert.match(r.subject, /received your signature.*NDA/i);
      assert.ok(r.html.includes('Alice'));
      assert.match(r.html, /recorded/i); // affirmative lead
      assert.match(r.html, /once everyone has signed/i); // sets the expectation (no silence)
      assert.match(r.html, /signing record/i); // durable record = the signing record
      assert.ok(!r.html.includes('undefined') && !r.text.includes('undefined'));
      // Notification class.
      assert.equal(r.from, 'notifications@kysigned.com');
      assert.equal(r.replyTo, 'info@kysigned.com');
    });

    it('renders the optional envelope status link when given', () => {
      const r = templates.acceptanceAck({
        signerName: 'Alice', documentName: 'NDA', operatorDomain: 'kysigned.com',
        statusLink: 'https://kysigned.com/dashboard/envelope/env-1',
      });
      assert.ok(r.html.includes('https://kysigned.com/dashboard/envelope/env-1'));
      assert.ok(r.text.includes('https://kysigned.com/dashboard/envelope/env-1'));
    });
  });

  // F-7.1 / AC-20 — corrective bounce: each class names the fix; the intent-line
  // classes quote the required line verbatim + re-state keep-the-attachment.
  describe('rejectionBounce (F-7.1 / AC-20)', () => {
    const links = {
      howItWorksLink: 'https://kysigned.com/how-it-works',
      faqHowToSignLink: 'https://kysigned.com/faq#how-to-sign',
      faqWrongEmailLink: 'https://kysigned.com/faq#wrong-email',
    };
    const make = (reason: Parameters<typeof templates.rejectionBounce>[0]['reason']) =>
      templates.rejectionBounce({ signerName: 'Alice', documentName: 'NDA', operatorDomain: 'kysigned.com', reason, ...links });

    it('wrong_phrase quotes the exact required line verbatim + keep-the-attachment (AC-15)', () => {
      const r = make('wrong_phrase');
      assert.match(r.subject, /Action needed.*NDA/i);
      assert.ok(r.html.includes('I sign this document'), 'quotes the required line verbatim');
      assert.match(r.html, /keep the attachment/i);
      // Never all-caps the phrase (caps never required).
      assert.ok(!/I SIGN THIS DOCUMENT/.test(r.html));
    });

    it('attachment_missing names the keep-the-original-attached fix', () => {
      const r = make('attachment_missing');
      assert.match(r.html, /wasn.t attached|PDF wasn.t attached/i);
      assert.match(r.html, /keep the attachment/i);
    });

    it('attachment_modified tells the signer to forward the unmodified original', () => {
      const r = make('attachment_modified');
      assert.match(r.html, /didn.t match the original/i);
      assert.match(r.html, /without editing|exactly as you received/i);
    });

    it('sender_auth and dkim_unverifiable explain the auth failure (no intent-line block)', () => {
      const sa = make('sender_auth');
      assert.match(sa.html, /sender authentication|SPF\/DMARC/i);
      assert.ok(!sa.html.includes('I sign this document'), 'no required-line block for auth failures');
      const dk = make('dkim_unverifiable');
      assert.match(dk.html, /DKIM|verify your email/i);
      assert.ok(!dk.html.includes('I sign this document'));
    });

    it('envelope_inactive says no action is needed', () => {
      const r = make('envelope_inactive');
      assert.match(r.html, /no longer active|completed, voided/i);
      assert.match(r.html, /no action is needed/i);
    });

    it('always links the FAQ how-to-sign + wrong-email + how-it-works (AC-56), notifications@', () => {
      const r = make('wrong_phrase');
      assert.ok(r.html.includes(links.faqHowToSignLink), 'how-to-sign FAQ linked');
      assert.ok(r.html.includes(links.faqWrongEmailLink), 'wrong-email FAQ linked');
      assert.ok(r.html.includes(links.howItWorksLink), 'how-it-works linked');
      assert.ok(!r.html.includes('undefined') && !r.text.includes('undefined'));
      assert.equal(r.from, 'notifications@kysigned.com');
      assert.equal(r.replyTo, 'info@kysigned.com');
    });
  });

  // F-9.1 — completion distribution (evidence-bundle model).
  describe('completion — bundle distribution, role-scoped (F-9.1 / AC-24)', () => {
    const base = {
      recipientName: 'Alice',
      documentName: 'Mutual NDA',
      signerCount: 2,
      bundleFingerprint: 'f'.repeat(64),
      verifyUrl: 'https://kysigned.com/verify',
      operatorDomain: 'kysigned.com',
    };

    it('announces the attached signing record, the verification code, and the verify URL', () => {
      const r = templates.completion({ ...base, role: 'signee' as const });
      assert.ok(r.subject.includes('Mutual NDA'));
      assert.match(r.html, /attached to this email is your signing record/i);
      assert.ok(r.html.includes('f'.repeat(64)), 'prints the verification code');
      assert.ok(r.html.includes('https://kysigned.com/verify'), 'verify URL present');
      assert.ok(!r.html.includes('undefined') && !r.text.includes('undefined'));
    });

    it('creator variant has a dashboard link; signee variant does NOT (AC-24)', () => {
      const creator = templates.completion({ ...base, role: 'creator' as const, dashboardLink: 'https://kysigned.com/dashboard/envelope/env-1' });
      const signee = templates.completion({ ...base, role: 'signee' as const });
      assert.ok(creator.html.includes('https://kysigned.com/dashboard/envelope/env-1'), 'creator gets the dashboard link');
      assert.ok(!signee.html.includes('/dashboard/'), 'signee gets NO dashboard link');
      assert.ok(creator.html.includes('/verify') && signee.html.includes('/verify'), 'both get the public verify link');
    });

    it('creator CTAs (verify + manage) share ONE button width so the stacked buttons align', () => {
      const r = templates.completion({ ...base, role: 'creator' as const, dashboardLink: 'https://kysigned.com/dashboard/envelope/env-1' });
      // The two CTA cells are the only fixed-width <td>s; they must declare the same width.
      const widths = [...r.html.matchAll(/<td\b[^>]*\bwidth="(\d+)"/g)].map((m) => m[1]);
      assert.equal(widths.length, 2, `expected exactly 2 fixed-width CTA cells, got ${widths.length}`);
      assert.equal(new Set(widths).size, 1, `both CTA buttons must be the same width, got ${widths.join(', ')}`);
    });

    it('has a keep-your-copy / proof-in-your-inbox note', () => {
      const r = templates.completion({ ...base, role: 'signee' as const });
      assert.match(r.html, /keep your copy/i);
      assert.match(r.html, /delete our stored copy|proof in your inbox/i);
    });

    it('is a notification-class email (notifications@ / info@)', () => {
      const r = templates.completion({ ...base, role: 'creator' as const, dashboardLink: 'https://x' });
      assert.equal(r.from, 'notifications@kysigned.com');
      assert.equal(r.replyTo, 'info@kysigned.com');
    });
  });

  it('all templates should produce HTML under 100KB', () => {
    const all = [
      templates.signingRequest({ signerName: 'A', senderName: 'B', documentName: 'D', envelopeId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', docHash: 'a'.repeat(64), reviewLink: 'http://x', howItWorksLink: 'http://h', operatorDomain: 'kysigned.com' }),
      templates.reminder({ signerName: 'A', senderName: 'B', documentName: 'D', envelopeId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', docHash: 'a'.repeat(64), reviewLink: 'http://x', howItWorksLink: 'http://h', operatorDomain: 'kysigned.com', reminderNumber: 1 }),
      templates.acceptanceAck({ signerName: 'A', documentName: 'D', operatorDomain: 'kysigned.com' }),
      templates.rejectionBounce({ signerName: 'A', documentName: 'D', operatorDomain: 'kysigned.com', reason: 'wrong_phrase', howItWorksLink: 'http://h', faqHowToSignLink: 'http://f1', faqWrongEmailLink: 'http://f2' }),
      templates.completion({ recipientName: 'A', documentName: 'D', signerCount: 1, bundleFingerprint: 'a'.repeat(64), verifyUrl: 'http://x/verify', role: 'signee', operatorDomain: 'kysigned.com' }),
      templates.voidNotification({ signerName: 'A', senderName: 'B', documentName: 'D', operatorDomain: 'kysigned.com' }),
      templates.expiryNotification({ recipientName: 'A', documentName: 'D', operatorDomain: 'kysigned.com' }),
      templates.retentionWarning({ recipientName: 'A', documentName: 'D', deletionDate: '2026-05-05', operatorDomain: 'kysigned.com' }),
    ];
    for (const t of all) {
      assert.ok(Buffer.byteLength(t.html) < 100_000, `Template HTML exceeds 100KB`);
      assert.ok(t.text.length > 0, 'Text version should not be empty');
    }
  });

  it('HTML should use table-based layout and inline CSS', () => {
    const result = templates.signingRequest({ signerName: 'A', senderName: 'B', documentName: 'D', envelopeId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', docHash: 'a'.repeat(64), reviewLink: 'http://x', howItWorksLink: 'http://h', operatorDomain: 'kysigned.com' });
    assert.ok(result.html.includes('<table'));
    assert.ok(result.html.includes('style='));
    assert.ok(!result.html.includes('<script'));
  });

  // DD-16: envelopeExpired template with signer status breakdown
  describe('envelopeExpired', () => {
    it('should show the full signer breakdown to the sender', () => {
      const result = templates.envelopeExpired({
        recipientName: 'Sender Sam',
        documentName: 'NDA Q4',
        senderName: 'Sender Sam',
        role: 'sender',
        signedCount: 2,
        totalCount: 3,
        signedNames: ['Alice', 'Bob'],
        pendingNames: ['Carol'],
        operatorDomain: 'kysigned.com',
      });
      assert.ok(result.subject.includes('NDA Q4'));
      assert.match(result.subject, /expired/i);
      assert.ok(result.html.includes('Sender Sam'));
      assert.ok(result.html.includes('NDA Q4'));
      assert.ok(result.html.includes('2 of 3'));
      assert.ok(result.html.includes('Alice'));
      assert.ok(result.html.includes('Bob'));
      assert.ok(result.html.includes('Carol'));
      assert.ok(result.text.includes('Alice'));
      assert.ok(result.text.includes('Carol'));
      assert.ok(result.text.includes('2 of 3'));
    });

    it('should send a simpler message to a pending signer (no action required)', () => {
      const result = templates.envelopeExpired({
        recipientName: 'Carol',
        documentName: 'Contract',
        senderName: 'Sam',
        role: 'signer',
        signedCount: 2,
        totalCount: 3,
        signedNames: ['Alice', 'Bob'],
        pendingNames: ['Carol'],
        operatorDomain: 'kysigned.com',
      });
      assert.ok(result.subject.includes('Contract'));
      assert.ok(result.html.includes('Carol'));
      // Signers still see who-sent and the overall status
      assert.ok(result.html.includes('Sam'));
      assert.ok(result.html.includes('Contract'));
    });

    it('should gracefully handle empty signed/pending lists', () => {
      const result = templates.envelopeExpired({
        recipientName: 'Sender',
        documentName: 'Doc',
        senderName: 'Sender',
        role: 'sender',
        signedCount: 0,
        totalCount: 1,
        signedNames: [],
        pendingNames: ['Alice'],
        operatorDomain: 'kysigned.com',
      });
      assert.ok(result.html.includes('Alice'));
      assert.ok(result.html.includes('0 of 1'));
      // Should not crash or produce undefined strings
      assert.ok(!result.html.includes('undefined'));
      assert.ok(!result.text.includes('undefined'));
    });

    it('should be under 100KB like the other templates', () => {
      const result = templates.envelopeExpired({
        recipientName: 'R', documentName: 'D', senderName: 'S', role: 'sender',
        signedCount: 1, totalCount: 2, signedNames: ['A'], pendingNames: ['B'],
        operatorDomain: 'kysigned.com',
      });
      assert.ok(Buffer.byteLength(result.html) < 100_000);
      assert.ok(result.text.length > 0);
    });
  });

  // v0.30.0 — F7.8 / Issue 10: creator creation-confirmation email (to the creator
  // at envelope creation), carrying the signer list, a dashboard link, and a
  // keep-your-copy / ephemeral-retention note (the canonical PDF is attached by the
  // send site, not the template).
  describe('envelopeCreated (F7.8 / Issue 10)', () => {
    const make = () => templates.envelopeCreated({
      documentName: 'Mutual NDA',
      envelopeId: 'env-1',
      signers: [
        { name: 'Alice', email: 'alice@acme.com', status: 'pending' },
        { name: 'Bob', email: 'bob@globex.com', status: 'pending' },
      ],
      dashboardLink: 'https://kysigned.com/dashboard/envelope/env-1',
      operatorDomain: 'kysigned.com',
    });

    it('shows the signer COUNT (not a pending list) + an envelope status-page link + keep-your-copy (5.5/AC-53)', () => {
      const r = make();
      assert.ok(r.subject.includes('Mutual NDA'));
      // F-5.6: just the count, never a redundant per-signer "pending" list.
      assert.match(r.html, /2 signers/);
      assert.ok(!r.html.includes('alice@acme.com') && !r.html.includes('bob@globex.com'), 'no per-signer pending list');
      // Deep-links to the envelope's OWN status page (F-11.2).
      assert.ok(r.html.includes('https://kysigned.com/dashboard/envelope/env-1'), 'envelope status-page link');
      assert.match(r.html, /keep your copy/i);
      assert.match(r.html, /signing record/i);
      assert.ok(r.text.includes('env-1'));
      assert.ok(!r.html.includes('undefined') && !r.text.includes('undefined'));
    });

    it('is a notification-class email (from notifications@, replyTo info@)', () => {
      const r = make();
      assert.equal(r.from, 'notifications@kysigned.com');
      assert.equal(r.replyTo, 'info@kysigned.com');
    });
  });

  describe('creatorProgress (F-5.7 / AC-54)', () => {
    const base = { signerName: 'Alice', documentName: 'NDA', statusPageLink: 'https://kysigned.com/dashboard/envelope/env-9', operatorDomain: 'kysigned.com' };

    it('renders a short "X signed Y" note with a progress count + status-page link', () => {
      const r = templates.creatorProgress({ ...base, signedCount: 1, totalCount: 3 });
      assert.match(r.subject, /Alice signed "NDA"/);
      assert.match(r.html, /1 of 3/);
      assert.ok(r.html.includes('https://kysigned.com/dashboard/envelope/env-9'), 'status-page link');
      assert.ok(!/mailto:/i.test(r.html), 'no mailto');
      assert.equal(r.from, 'notifications@kysigned.com');
      assert.equal(r.replyTo, 'info@kysigned.com');
    });

    it('a NON-final signature carries no completion line', () => {
      const r = templates.creatorProgress({ ...base, signedCount: 1, totalCount: 3, autoClose: true });
      assert.ok(!/complete\b.*on its way|review and seal/i.test(r.html), 'no completion line before the last signer');
    });

    it('the FINAL signer with auto-close ON says the envelope is complete + bundle on its way (F-24)', () => {
      const r = templates.creatorProgress({ ...base, signedCount: 3, totalCount: 3, autoClose: true });
      assert.match(r.html, /3 of 3/);
      assert.match(r.html, /complete/i);
      assert.match(r.html, /on its way/i);
      assert.ok(!/review and seal/i.test(r.html), 'auto-close: no manual seal CTA');
      assert.match(r.text, /on its way/i);
    });

    it('the FINAL signer with auto-close OFF points the creator to the dashboard to seal (F-24)', () => {
      const r = templates.creatorProgress({ ...base, signedCount: 3, totalCount: 3, autoClose: false });
      assert.match(r.html, /3 of 3/);
      assert.match(r.html, /review and seal/i);
      assert.match(r.html, /Seal &amp; send/i);
      assert.ok(!/on its way/i.test(r.html), 'manual: not the auto-send wording');
      assert.match(r.text, /review and seal/i);
    });
  });

  it('F3.3.8: per-template `from` + `replyTo` mapping across all templates (2F.MBX.4)', () => {
    const op = 'kysigned.com';
    // Signing class — both From and Reply-To use the signing mailbox so run402's
    // reply-only-history accepts the signer's reply.
    const signing = templates.signingRequest({
      signerName: 'A', senderName: 'B', documentName: 'D',
      envelopeId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', docHash: 'a'.repeat(64),
      reviewLink: 'http://x', howItWorksLink: 'http://h', operatorDomain: op,
    });
    assert.equal(signing.from, `forward-to-sign@${op}`);
    assert.equal(signing.replyTo, `forward-to-sign@${op}`);

    const reminder = templates.reminder({
      signerName: 'A', senderName: 'B', documentName: 'D',
      envelopeId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', docHash: 'a'.repeat(64),
      reviewLink: 'http://x', howItWorksLink: 'http://h', operatorDomain: op, reminderNumber: 1,
    });
    assert.equal(reminder.from, `forward-to-sign@${op}`);
    assert.equal(reminder.replyTo, `forward-to-sign@${op}`);

    // Notification class — From = notifications@; Reply-To = info@ (saaspocalypse
    // F22 Standard Operator Mailbox Set, end-state per saas-factory v1.23.0).
    const notifications: Array<{ from?: string; replyTo?: string }> = [
      templates.acceptanceAck({ signerName: 'A', documentName: 'D', operatorDomain: op }),
      templates.rejectionBounce({ signerName: 'A', documentName: 'D', operatorDomain: op, reason: 'wrong_phrase', howItWorksLink: 'http://h', faqHowToSignLink: 'http://f1', faqWrongEmailLink: 'http://f2' }),
      templates.completion({ recipientName: 'A', documentName: 'D', signerCount: 1, bundleFingerprint: 'a'.repeat(64), verifyUrl: 'http://x/verify', role: 'signee', operatorDomain: op }),
      templates.voidNotification({ signerName: 'A', senderName: 'B', documentName: 'D', operatorDomain: op }),
      templates.expiryNotification({ recipientName: 'A', documentName: 'D', operatorDomain: op }),
      templates.retentionWarning({ recipientName: 'A', documentName: 'D', deletionDate: '2026-05-05', operatorDomain: op }),
      templates.envelopeExpired({ recipientName: 'R', documentName: 'D', senderName: 'S', role: 'sender', signedCount: 1, totalCount: 2, signedNames: ['A'], pendingNames: ['B'], operatorDomain: op }),
    ];
    for (const t of notifications) {
      assert.equal(t.from, `notifications@${op}`);
      assert.equal(t.replyTo, `info@${op}`);
    }
  });
});

// AC-55 — the display subject of EVERY outbound email is human-readable (no raw
// hex prefix), and the routing token still survives a Fwd:/Fw: round-trip. This
// locks the invariant across the whole suite (one professional branded template,
// friendly subjects) rather than per-template.
describe('AC-55 — friendly display subjects across the whole suite', () => {
  const ENV = SWEEP_ENV;
  const op = 'kysigned.com';

  // Every outbound template, built with representative vars (shared enumeration).
  const all = buildAllTemplates(op);

  // F-5.2 — only the forwarded SIGNING email carries the routing token. The
  // reminder is From the signing channel (it threads with the original) but is a
  // NUDGE — no token, nothing to forward (F-5.5). Status emails carry none.
  const ROUTED = new Set(['signingRequest']);

  for (const [name, r] of Object.entries(all)) {
    it(`${name}: subject is human-readable with no raw-hex prefix`, () => {
      assert.ok(r.subject.length > 0, 'non-empty subject');
      // Leads with a word or a quoted document name — never a bracket/hex token.
      assert.match(r.subject, /^["“]?[A-Za-z]/, `should start human-readable: ${r.subject}`);
      assert.ok(!r.subject.startsWith('[ksgn-'), 'no leading routing token');
      assert.doesNotMatch(r.subject, /^[\s[]*[0-9a-f]{8,}/i, 'no leading raw hex run');
      if (ROUTED.has(name)) {
        assert.match(r.subject, /\[ksgn-[0-9a-f]{32}\]/, 'routed signing email carries the token');
      } else {
        assert.ok(!/\[ksgn-/i.test(r.subject), 'status email carries no routing token');
      }
    });
  }

  for (const name of ROUTED) {
    it(`${name}: routing token survives a Fwd:/Fw: round-trip (AC-55/AC-11)`, () => {
      const subject = all[name].subject;
      for (const prefix of ['', 'Fwd: ', 'Fw: ', 'FWD: ', 'fwd: ', 'Re: Fwd: ']) {
        assert.equal(parseEnvelopeToken(prefix + subject), ENV, `token lost under "${prefix}"`);
      }
    });
  }
});

// AC-61 / F-19.1 — mailbox PURITY sweep (14.3). Locks the From/Reply-To partition
// across the WHOLE template suite: `forward-to-sign@` is the pure signing channel
// (From of ONLY the signing request + reminder, and nothing else), and EVERY
// status email — acknowledgments, rejections, all of them — is From
// `notifications@` with Reply-To the human inbox `info@`. A future template that
// sent status mail from the signing channel (or vice-versa) turns this RED.
describe('AC-61 — mailbox purity sweep across the whole suite', () => {
  const op = 'kysigned.com';
  const all = buildAllTemplates(op);

  for (const [name, r] of Object.entries(all)) {
    it(`${name}: From/Reply-To match the F-19.1 mailbox partition`, () => {
      if (SIGNING_CHANNEL_TEMPLATES.has(name)) {
        assert.equal(r.from, `forward-to-sign@${op}`, `${name} must send From the signing channel`);
        assert.equal(r.replyTo, `forward-to-sign@${op}`, `${name} Reply-To must be the signing channel`);
      } else {
        assert.equal(r.from, `notifications@${op}`, `${name} must send From notifications@, never the signing channel`);
        assert.equal(r.replyTo, `info@${op}`, `${name} Reply-To must be the human inbox`);
      }
    });
  }

  it('forward-to-sign@ is the From of EXACTLY the signing request + reminder (nothing else)', () => {
    const fromSigningChannel = Object.entries(all)
      .filter(([, r]) => r.from === `forward-to-sign@${op}`)
      .map(([name]) => name)
      .sort();
    assert.deepEqual(fromSigningChannel, ['reminder', 'signingRequest']);
  });

  it('the rejection bounce + acceptance acknowledgment are From notifications@ (AC-61, explicit)', () => {
    assert.equal(all.rejectionBounce.from, `notifications@${op}`);
    assert.equal(all.acceptanceAck.from, `notifications@${op}`);
  });
});

// GH#36 — the intent line is displayed sentence-case (F-6.3) precisely so caps are
// never implied as required, so the "Capitalization doesn't matter" reassurance is
// redundant copy that states a non-issue. It must not appear in ANY template.
describe('GH#36 — no redundant capitalization reassurance', () => {
  const op = 'kysigned.com';
  const all = buildAllTemplates(op);
  for (const [name, r] of Object.entries(all)) {
    it(`${name}: never mentions capitalization (intent line is shown sentence-case)`, () => {
      assert.ok(!/capitali[sz]ation/i.test(r.html), `${name} HTML must not mention capitalization`);
      assert.ok(!/capitali[sz]ation/i.test(r.text), `${name} text must not mention capitalization`);
    });
  }
});

describe('F-7.4 removed — no instant receipt acknowledgment (spec v0.28.0)', () => {
  it('the receiptAcknowledgment template no longer exists', () => {
    // Email triggers make the acceptance ack (F-7.3) prompt, so the "we received your email,
    // reviewing" receipt ack is redundant. The acceptance ack is the single per-signer confirmation.
    assert.equal((templates as Record<string, unknown>).receiptAcknowledgment, undefined);
  });
});
