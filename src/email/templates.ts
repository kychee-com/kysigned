// Table-based HTML email templates. Inline CSS, no JS, <100KB.
// All templates include List-Unsubscribe header support.

interface TemplateVars {
  [key: string]: string | number | undefined;
}

/**
 * The exact signing phrase, displayed sentence-case. Capitalization is never
 * required (F-6.3 compares case-insensitively); we display normal case precisely
 * so caps are never *implied* as required. This single constant is the verbatim
 * "required line" the F-7.1 corrective bounce quotes back to the signer.
 */
export const REQUIRED_INTENT_LINE = 'I sign this document';

/**
 * Presentational rejection classes for the F-7.1 corrective bounce. The signing
 * pipeline emits finer-grained `ForwardRejectionCode`s; the notifier folds them
 * into these user-facing classes (see `forwardNotifier.rejectionReasonForCode`).
 */
export type RejectionReason =
  | 'wrong_phrase' // bad / missing first-line intent phrase
  | 'attachment_missing' // the canonical PDF wasn't attached
  | 'attachment_modified' // the attached PDF didn't byte-match the original
  | 'sender_auth' // SES SPF / DMARC hard-fail (spoofing guard)
  | 'dkim_unverifiable' // the forward's DKIM signature didn't verify
  | 'envelope_inactive'; // completed / voided / expired — no new signatures

function wrap(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f6f6f6;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f6;padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="padding:30px 40px 20px;background:#1a1a2e;color:#ffffff;">
<h1 style="margin:0;font-size:20px;font-weight:600;">kysigned</h1>
</td></tr>
<tr><td style="padding:30px 40px;">
${body}
</td></tr>
<tr><td style="padding:20px 40px;background:#f0f0f0;font-size:12px;color:#666;">
<p style="margin:0;">This email was sent by kysigned: e-signatures proven by your own email.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function textWrap(body: string): string {
  return `kysigned: E-Signatures Proven By Your Own Email\n${'='.repeat(50)}\n\n${body}\n\n---\nThis email was sent by kysigned.`;
}

/**
 * Defeat email-client auto-linkification of a bare address (GH#7). Gmail / Apple
 * Mail / Outlook turn `local@domain.tld` in body text into a mailto: link, and
 * tapping it opens a blank compose window — a dead end for the forward-to-sign flow
 * (you sign by FORWARDING, not composing). Splitting the address with an inline tag
 * at the final dot breaks the client's token match (no single text node is a
 * complete email OR a bare domain), while the rendered text stays identical and
 * copy-paste stays clean (every character is real, just across nodes).
 */
function antiLinkify(addr: string): string {
  const dot = addr.lastIndexOf('.');
  return dot < 0 ? addr : `${addr.slice(0, dot)}<span>.</span>${addr.slice(dot + 1)}`;
}

export const templates = {
  signingRequest(vars: {
    signerName: string;
    /** The signer's own email — named in the F-22.1 binding declaration. */
    signerEmail?: string;
    senderName: string;
    documentName: string;
    envelopeId: string;
    reviewLink: string;
    howItWorksLink: string;
    operatorDomain: string;
    signingEmail?: string;
    /** F-22.2 — organisation the signer is signing on behalf of (optional). */
    onBehalfOf?: string;
    message?: string;
    /**
     * Set ONLY on a re-send after an edit (F-23). Adds a compact "(updated <UTC>)"
     * marker to the subject so the new request starts a FRESH inbox thread instead
     * of chaining under the original — Gmail threads by normalized subject, so an
     * identical subject would collapse the two requests together and the signer
     * could forward the stale one (Barry QA). The first send omits it.
     */
    revisedAt?: Date;
    // --- accepted-but-unused by this template; ignored ---
    docHash?: string;
    pdfDownloadLink?: string;
    senderEmail?: string;
  }) {
    const msgBlock = vars.message
      ? `<p style="margin:15px 0;padding:15px;background:#f8f8f8;border-left:3px solid #1a1a2e;font-style:italic;">${vars.message}</p>`
      : '';
    // F-5.2 — routing token in the subject that survives Forward (clients
    // prepend "Fwd:"/"Fw:" but keep the rest). The fixed signing mailbox parses
    // [ksgn-<envelopeId>] to route the forward back to its envelope.
    const envHex = vars.envelopeId.replace(/-/g, '').toLowerCase();
    const signMailbox = vars.signingEmail ?? `forward-to-sign@${vars.operatorDomain}`;

    // A re-send after an edit (F-23) gets a compact "(updated <UTC>)" subject
    // marker so it does NOT thread under the original request in the signer's
    // inbox. Friendly, not a scary hash (Barry QA).
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const r = vars.revisedAt;
    const revisedTag = r
      ? ` (updated ${MONTHS[r.getUTCMonth()]} ${r.getUTCDate()}, ${pad2(r.getUTCHours())}:${pad2(r.getUTCMinutes())} UTC)`
      : '';

    // Family B (F-22): the per-signer legal declaration (named binding +
    // on-behalf-of authority) now lives on the signer's COVER PAGE — inside the
    // DKIM-signed attachment bytes — NOT in this email body. The email keeps only
    // a friendly name greeting + the forward instructions.

    const stepHeader = (n: string, title: string) => `
      <div style="margin:24px 0 8px;border-top:1px solid #e5e7eb;padding-top:16px;">
        <span style="display:inline-block;background:#1a1a2e;color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:3px;margin-right:8px;">STEP ${n}</span>
        <span style="font-size:15px;font-weight:600;color:#1a1a2e;">${title}</span>
      </div>`;

    return {
      // F-5.8 — friendly display subject; the routing token rides in a segment
      // that survives Forward (F-5.2).
      subject: `Signature requested: "${vars.documentName}"${revisedTag} [ksgn-${envHex}]`,
      html: wrap(`Signature Request`, `
        <p style="margin:0 0 15px;">Hi ${vars.signerName},</p>
        <p style="margin:0 0 8px;"><strong>${vars.senderName}</strong> has requested your signature on <strong>&ldquo;${vars.documentName}&rdquo;</strong>. <strong>The document is attached to this email.</strong></p>
        ${msgBlock}

        ${stepHeader('1', 'Read the attached document')}
        <p style="margin:8px 0 12px;font-size:13px;color:#444;">The PDF is attached to this email. You can also <a href="${vars.reviewLink}" style="color:#1a1a2e;text-decoration:underline;">open it in your browser</a>.</p>

        ${stepHeader('2', 'Sign by forwarding this email')}
        <p style="margin:8px 0 8px;font-size:13px;color:#444;">Forward this whole email (keep the attached PDF) to:</p>
        <p style="margin:0 0 10px;font-size:15px;"><strong style="font-family:monospace;">${antiLinkify(signMailbox)}</strong></p>
        <p style="margin:0 0 10px;font-size:13px;color:#444;">&hellip; and type this as the very first line of your forward:</p>
        <p style="margin:0 0 12px;padding:10px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;font-family:monospace;font-size:15px;color:#14532d;">I sign this document</p>
        <p style="margin:0 0 8px;font-size:12px;color:#666;">Your email provider&rsquo;s built-in signature on that forward is your signature. No account, password, or app needed.</p>

        <div style="margin:24px 0 8px;border-top:1px solid #e5e7eb;padding-top:12px;font-size:12px;color:#666;">
          <a href="${vars.howItWorksLink}" style="color:#1a1a2e;">How it works &rarr;</a>
        </div>
      `),
      // Plain-text mirror. In the FORWARD model the signer composes their own
      // first line, so our body size is unconstrained (no quoted-reply budget).
      text: textWrap(
        `Hi ${vars.signerName},\n\n${vars.senderName} has requested your signature on "${vars.documentName}". The document is attached to this email.\n\n` +
        `TO SIGN: forward this whole email (keep the attached PDF) to ${signMailbox}, and type this as the very first line of your forward:\n\n    I sign this document\n\n` +
        `(Your email provider's built-in signature on that forward is your signature.)\n\n` +
        `Read it in your browser: ${vars.reviewLink}\nHow it works: ${vars.howItWorksLink}`
      ),
      from: signMailbox,
      replyTo: signMailbox,
    };
  },

  reminder(vars: {
    signerName: string;
    senderName: string;
    documentName: string;
    envelopeId: string;
    reviewLink: string;
    howItWorksLink: string;
    operatorDomain: string;
    signingEmail?: string;
    reminderNumber: number;
    docHash?: string; // accepted-but-unused by this template; ignored
  }) {
    const signMailbox = vars.signingEmail ?? `forward-to-sign@${vars.operatorDomain}`;
    return {
      // A reminder is a NUDGE — NOT the signing email, NOT forwarded. It carries no
      // routing token and no attachment; the signer acts on the ORIGINAL request
      // (which has both). So the subject stays clean — no [ksgn-] hash (Barry QA).
      subject: `Reminder: your signature on "${vars.documentName}"`,
      html: wrap(`Signature Reminder`, `
        <p style="margin:0 0 15px;">Hi ${vars.signerName},</p>
        <p style="margin:0 0 15px;">A friendly reminder that <strong>${vars.senderName}</strong> is still waiting for your signature on <strong>&ldquo;${vars.documentName}&rdquo;</strong>.</p>
        <p style="margin:0 0 12px;font-size:14px;color:#444;"><strong>This reminder isn&rsquo;t the signing email.</strong> There&rsquo;s nothing to forward here. To sign, open the <strong>original signature-request email</strong> we sent you (subject: <em>Signature requested: &ldquo;${vars.documentName}&rdquo;</em>) and follow the instructions in it.</p>
        <div style="margin:0 0 14px;padding:12px 16px;background:#f8f8f8;border-left:3px solid #1a1a2e;font-size:13px;color:#444;">
          <strong>Can&rsquo;t find it?</strong>
          <ul style="margin:8px 0 0;padding-left:18px;">
            <li>Check your <strong>spam</strong> or <strong>junk</strong> folder.</li>
            <li>Still can&rsquo;t find it? Email the sender, <a href="mailto:${vars.senderName}" style="color:#1a1a2e;">${vars.senderName}</a>, and ask them to resend it.</li>
          </ul>
        </div>
        <div style="margin:8px 0;border-top:1px solid #e5e7eb;padding-top:12px;font-size:12px;color:#666;">
          <a href="${vars.reviewLink}" style="color:#1a1a2e;">Preview the document &rarr;</a>
          <span style="color:#bbb;margin:0 8px;">|</span>
          <a href="${vars.howItWorksLink}" style="color:#1a1a2e;">How it works &rarr;</a>
        </div>
      `),
      text: textWrap(
        `Hi ${vars.signerName},\n\nA friendly reminder that ${vars.senderName} is still waiting for your signature on "${vars.documentName}".\n\n` +
        `This reminder isn't the signing email. There's nothing to forward here. To sign, open the ORIGINAL signature-request email we sent you (subject: Signature requested: "${vars.documentName}") and follow the instructions in it.\n\n` +
        `Can't find it?\n  - Check your spam or junk folder.\n  - Still can't find it? Email the sender, ${vars.senderName}, and ask them to resend it.\n\n` +
        `Preview the document: ${vars.reviewLink}\nHow it works: ${vars.howItWorksLink}`
      ),
      from: signMailbox,
      replyTo: signMailbox,
    };
  },

  // F-7.3 / AC-45 — acceptance acknowledgment. An ACCEPTED forward earns the signer
  // an immediate confirmation From `notifications@` so silence never means
  // uncertainty. The durable record is the signing record every party receives at
  // completion (NOT yet created here — no attachment on this email, so this copy
  // promises it for later, it does not point at a "bundle" that doesn't exist yet,
  // which is exactly the confusion Tal hit). Copy leads with the affirmative cue.
  acceptanceAck(vars: {
    signerName: string;
    documentName: string;
    operatorDomain: string;
    /** Optional deep-link to this envelope's public status page (F-11.2). */
    statusLink?: string;
  }) {
    const statusRow = vars.statusLink
      ? `<table cellpadding="0" cellspacing="0" style="margin:4px 0 18px;"><tr><td style="border:1px solid #1a1a2e;border-radius:6px;padding:10px 22px;"><a href="${vars.statusLink}" style="color:#1a1a2e;text-decoration:none;font-weight:600;font-size:14px;">View this envelope&rsquo;s status</a></td></tr></table>`
      : '';
    const statusText = vars.statusLink ? `\nView this envelope's status: ${vars.statusLink}` : '';
    return {
      subject: `We received your signature on "${vars.documentName}"`,
      html: wrap(`Signature Recorded`, `
        <p style="margin:0 0 15px;">Hi ${vars.signerName},</p>
        <p style="margin:0 0 15px;font-size:15px;color:#15803d;"><strong>&#10003; Your signature is recorded.</strong></p>
        <p style="margin:0 0 15px;">Thanks, your signature on <strong>&ldquo;${vars.documentName}&rdquo;</strong> is recorded. Once everyone has signed, we&rsquo;ll email you the complete signing record (a PDF) to keep. Nothing more for you to do right now.</p>
        ${statusRow}
        <p style="margin:0;font-size:13px;color:#666;">The signing record will be your permanent proof, and anyone can verify it.</p>
      `),
      text: textWrap(
        `Hi ${vars.signerName},\n\nYour signature is recorded.\n\nThanks, your signature on "${vars.documentName}" is recorded. Once everyone has signed, we'll email you the complete signing record (a PDF) to keep. Nothing more for you to do right now.${statusText}\n\nThe signing record will be your permanent proof, and anyone can verify it.`
      ),
      from: `notifications@${vars.operatorDomain}`,
      replyTo: `info@${vars.operatorDomain}`,
    };
  },

  // F-7.1 / AC-20 — corrective bounce. A legitimate pending signer whose forward
  // failed a gate gets an immediate, class-specific email From `notifications@`:
  // what we received, why it didn't count, and exactly what to do — quoting the
  // required line verbatim and re-stating "keep the attachment". Self-healing UX:
  // most real first attempts need exactly one correction. Never reveals other
  // signers' state (F-7.2). Links to how-it-works + the FAQ how-to-sign / wrong-email
  // entries (AC-56) are passed in (defaulted from operatorDomain by the notifier).
  rejectionBounce(vars: {
    signerName: string;
    documentName: string;
    operatorDomain: string;
    reason: RejectionReason;
    howItWorksLink: string;
    faqHowToSignLink: string;
    faqWrongEmailLink: string;
  }) {
    // Per-class copy: headline + what-happened + how-to-fix, and which standard
    // reminder blocks (the required intent line, the keep-the-attachment note) to show.
    const COPY: Record<
      RejectionReason,
      { headline: string; what: string; fix: string; showIntentLine: boolean; showAttachment: boolean }
    > = {
      wrong_phrase: {
        headline: 'Your forward needs the exact signing line',
        what: 'We received your forward, but its first line wasn’t the exact phrase we need, so your signature wasn’t accepted.',
        fix: 'Forward the original email again and make the very first line of your message exactly this:',
        showIntentLine: true,
        showAttachment: true,
      },
      attachment_missing: {
        headline: 'The document wasn’t attached',
        what: 'We received your forward, but the original PDF wasn’t attached, so we couldn’t confirm what you signed.',
        fix: 'Forward the original signing-request email (the one with the PDF attached). Don’t remove the attachment.',
        showIntentLine: true,
        showAttachment: true,
      },
      attachment_modified: {
        headline: 'The attached document didn’t match the original',
        what: 'We received your forward, but the attached PDF didn’t match the document we sent, so it couldn’t be accepted.',
        fix: 'Forward the original email without editing, re-saving, or re-attaching the PDF. Send it exactly as you received it.',
        showIntentLine: true,
        showAttachment: true,
      },
      sender_auth: {
        headline: 'Your email failed sender authentication',
        what: 'Your forward didn’t pass our sender-authentication checks, so we couldn’t safely confirm it came from you.',
        fix: 'Forward again from your normal email account and app (not a relay, mailing list, or “send-as” alias).',
        showIntentLine: false,
        showAttachment: false,
      },
      dkim_unverifiable: {
        headline: 'We couldn’t verify your email’s signature',
        what: 'Your email provider’s signature didn’t verify on the forward. That signature is how we confirm the message is really from you.',
        fix: 'Use your mail app’s Forward button on the original message (don’t copy-paste, download-and-reattach, or send through a list that rewrites mail).',
        showIntentLine: false,
        showAttachment: false,
      },
      envelope_inactive: {
        headline: 'This signing request is no longer active',
        what: `The document “${vars.documentName}” has already been completed, voided, or has expired, so new signatures can’t be added.`,
        fix: 'No action is needed. If you think this is a mistake, just reply to this email and we’ll help.',
        showIntentLine: false,
        showAttachment: false,
      },
    };
    const c = COPY[vars.reason];

    const intentBlockHtml = c.showIntentLine
      ? `<p style="margin:0 0 12px;padding:10px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;font-family:monospace;font-size:15px;color:#14532d;">${REQUIRED_INTENT_LINE}</p>`
      : '';
    const attachmentBlockHtml = c.showAttachment
      ? `<p style="margin:0 0 12px;font-size:13px;color:#444;"><strong>Keep the attachment.</strong> The forwarded email must still include the original PDF, unchanged.</p>`
      : '';
    const intentBlockText = c.showIntentLine
      ? `\n\n    ${REQUIRED_INTENT_LINE}`
      : '';
    const attachmentBlockText = c.showAttachment
      ? `\n\nKeep the attachment: the forwarded email must still include the original PDF, unchanged.`
      : '';

    return {
      subject: `Action needed: your signature on "${vars.documentName}" wasn’t accepted`,
      html: wrap(`Action Needed`, `
        <p style="margin:0 0 15px;">Hi ${vars.signerName},</p>
        <p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#1a1a2e;">${c.headline}</p>
        <p style="margin:0 0 15px;">${c.what}</p>
        <div style="margin:18px 0 8px;border-top:1px solid #e5e7eb;padding-top:16px;">
          <span style="display:inline-block;background:#1a1a2e;color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:3px;">HOW TO FIX</span>
        </div>
        <p style="margin:10px 0 12px;font-size:14px;color:#222;">${c.fix}</p>
        ${intentBlockHtml}
        ${attachmentBlockHtml}
        <div style="margin:22px 0 0;border-top:1px solid #e5e7eb;padding-top:12px;font-size:12px;color:#666;">
          <a href="${vars.faqHowToSignLink}" style="color:#1a1a2e;">How to sign by forwarding &rarr;</a>
          <span style="color:#bbb;margin:0 8px;">|</span>
          <a href="${vars.faqWrongEmailLink}" style="color:#1a1a2e;">Wrong email address? &rarr;</a>
          <span style="color:#bbb;margin:0 8px;">|</span>
          <a href="${vars.howItWorksLink}" style="color:#1a1a2e;">How it works &rarr;</a>
        </div>
      `),
      text: textWrap(
        `Hi ${vars.signerName},\n\n${c.headline}\n\n${c.what}\n\nHOW TO FIX\n${c.fix}${intentBlockText}${attachmentBlockText}\n\n` +
        `How to sign by forwarding: ${vars.faqHowToSignLink}\nWrong email address? ${vars.faqWrongEmailLink}\nHow it works: ${vars.howItWorksLink}`
      ),
      from: `notifications@${vars.operatorDomain}`,
      replyTo: `info@${vars.operatorDomain}`,
    };
  },

  // F-9.1 — completion distribution (evidence-bundle model). The self-contained
  // evidence bundle PDF is attached by the send site (distributeEnvelopeBundle).
  // Role-scoped (F-2.3 / AC-24): the creator gets a dashboard link, signers get
  // NONE. Keep-your-copy note (the bundle is the durable record; kysigned deletes
  // its stored copies).
  completion(vars: {
    recipientName: string;
    documentName: string;
    signerCount: number;
    role: 'creator' | 'signee';
    /** F-8.2 bundle fingerprint — a human-checkable integrity reference. */
    bundleFingerprint: string;
    /** Verifier page URL (drag the bundle in). */
    verifyUrl: string;
    /** Creator-only dashboard link (signers get none — AC-24). */
    dashboardLink?: string;
    operatorDomain: string;
  }) {
    // Secondary CTA. Same fixed width + matched box model (border, padding) as the
    // primary "Verify this document" button so the two stacked buttons align in length.
    const dashboardRow = vars.role === 'creator' && vars.dashboardLink
      ? `<table cellpadding="0" cellspacing="0" style="margin:0 0 18px;"><tr><td width="300" align="center" style="width:300px;border:1px solid #1a1a2e;border-radius:6px;padding:13px 20px;text-align:center;"><a href="${vars.dashboardLink}" style="color:#1a1a2e;text-decoration:none;font-weight:600;font-size:14px;">Manage on your dashboard</a></td></tr></table>`
      : '';
    const dashboardText = vars.role === 'creator' && vars.dashboardLink ? `\nManage on your dashboard: ${vars.dashboardLink}` : '';
    return {
      subject: `"${vars.documentName}" is signed and complete`,
      html: wrap(`Signed and complete`, `
        <p style="margin:0 0 15px;">Hi ${vars.recipientName},</p>
        <p style="margin:0 0 15px;">All <strong>${vars.signerCount} signer${vars.signerCount === 1 ? '' : 's'}</strong> have signed <strong>"${vars.documentName}"</strong>.</p>
        <p style="margin:0 0 15px;"><strong>The PDF attached to this email is your signing record.</strong> Keep it: it is your permanent proof.</p>
        <p style="margin:0 0 15px;font-size:13px;color:#444;">Inside it: the document everyone signed, plus a signature page listing each signer, their email, and the exact time they signed. The signatures are recorded by email rather than stamped onto the document, and anyone can verify them, even offline, with no account. It opens like any normal PDF (no certificate, no warning).</p>
        <table cellpadding="0" cellspacing="0" style="margin:18px 0;">
        <tr><td width="300" align="center" style="width:300px;background:#1a1a2e;border:1px solid #1a1a2e;border-radius:6px;padding:13px 20px;text-align:center;">
        <a href="${vars.verifyUrl}" style="color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;">Verify this document</a>
        </td></tr>
        </table>
        ${dashboardRow}
        <p style="margin:0 0 15px;font-size:13px;color:#666;"><strong>Keep your copy.</strong> We delete our stored copy after sending, so this email is the lasting one ("proof in your inbox"). Anyone you forward it to can re-check it offline, forever, with no account and even if kysigned no longer exists.</p>
        <table style="margin:0 0 4px;font-size:13px;width:100%;">
        <tr><td style="padding:5px 0;color:#666;">Verify anytime:</td><td style="padding:5px 0;"><a href="${vars.verifyUrl}" style="color:#1a1a2e;">${vars.verifyUrl}</a></td></tr>
        </table>
        <p style="margin:6px 0 2px;font-size:12px;color:#666;">Verification code:</p>
        <p style="margin:0;font-family:monospace;font-size:11px;color:#444;word-break:break-all;">${vars.bundleFingerprint}</p>
      `),
      text: textWrap(
        `Hi ${vars.recipientName},\n\nAll ${vars.signerCount} signer${vars.signerCount === 1 ? '' : 's'} have signed "${vars.documentName}".\n\nThe PDF attached to this email is your signing record. Keep it: it is your permanent proof.\n\n` +
        `Inside it: the document everyone signed, plus a signature page listing each signer, their email, and the exact time they signed. The signatures are recorded by email rather than stamped onto the document, and anyone can verify them, even offline, with no account.\n\n` +
        `Keep your copy. We delete our stored copy after sending, so this email is the lasting one. Anyone you forward it to can re-check it offline, forever.\n\n` +
        `Verify anytime: ${vars.verifyUrl}${dashboardText}\n\nVerification code:\n${vars.bundleFingerprint}`
      ),
      from: `notifications@${vars.operatorDomain}`,
      replyTo: `info@${vars.operatorDomain}`,
    };
  },

  voidNotification(vars: { signerName: string; senderName: string; documentName: string; operatorDomain: string }) {
    return {
      subject: `"${vars.documentName}" has been voided`,
      html: wrap(`Envelope Voided`, `
        <p style="margin:0 0 15px;">Hi ${vars.signerName},</p>
        <p style="margin:0 0 15px;"><strong>${vars.senderName}</strong> has voided the signing request for <strong>"${vars.documentName}"</strong>. No further action is needed.</p>
      `),
      text: textWrap(
        `Hi ${vars.signerName},\n\n${vars.senderName} has voided the signing request for "${vars.documentName}". No further action is needed.`
      ),
      from: `notifications@${vars.operatorDomain}`,
      replyTo: `info@${vars.operatorDomain}`,
    };
  },

  /**
   * F-23.3 — a SINGLE signer's signing request was cancelled: deleted from an
   * open envelope, or replaced because their email was corrected (delete-old half
   * of the email-change, F-23.4 / DD-10). Distinct from voidNotification (whole
   * envelope voided) — the envelope continues for the other signers.
   * DRAFT wording — Barry-approval queue (W5).
   */
  signingRequestCancelled(vars: { signerName: string; senderName: string; documentName: string; operatorDomain: string }) {
    return {
      subject: `Your signing request for "${vars.documentName}" was cancelled`,
      html: wrap(`Signing Request Cancelled`, `
        <p style="margin:0 0 15px;">Hi ${vars.signerName},</p>
        <p style="margin:0 0 15px;"><strong>${vars.senderName}</strong> has cancelled your signing request for <strong>"${vars.documentName}"</strong>. No action is needed, you can disregard the document you received.</p>
      `),
      text: textWrap(
        `Hi ${vars.signerName},\n\n${vars.senderName} has cancelled your signing request for "${vars.documentName}". No action is needed, you can disregard the document you received.`
      ),
      from: `notifications@${vars.operatorDomain}`,
      replyTo: `info@${vars.operatorDomain}`,
    };
  },

  /**
   * F-24.2 — manual seal: every signer has signed but `autoClose` is off, so the
   * envelope is parked in `awaiting_seal` and the CREATOR is asked to review &
   * seal. Nothing is distributed until they click "Seal & send". DRAFT wording
   * (Barry-approval queue W6).
   */
  reviewAndSeal(vars: { recipientName: string; documentName: string; signerCount: number; dashboardLink: string; operatorDomain: string }) {
    const signedVerb = vars.signerCount === 1 ? 'signer has' : 'signers have';
    return {
      subject: `All signers have signed "${vars.documentName}": review & seal`,
      html: wrap(`Ready to Seal`, `
        <p style="margin:0 0 15px;">Hi ${vars.recipientName},</p>
        <p style="margin:0 0 15px;">All <strong>${vars.signerCount}</strong> ${signedVerb} signed <strong>"${vars.documentName}"</strong>. Nothing has been sent yet. This envelope is waiting for you to seal it.</p>
        <p style="margin:0 0 20px;">Review the signers and, when you're ready, click <strong>Seal &amp; send signed envelope</strong> to finalise and deliver everyone's signing record.</p>
        <p style="margin:0 0 10px;"><a href="${vars.dashboardLink}" style="display:inline-block;padding:12px 24px;background:#1a1a2e;color:#ffffff;text-decoration:none;border-radius:6px;">Seal &amp; send signed envelope</a></p>
      `),
      text: textWrap(
        `Hi ${vars.recipientName},\n\nAll ${vars.signerCount} ${signedVerb} signed "${vars.documentName}". Nothing has been sent yet. This envelope is waiting for you to seal it.\n\nReview the signers and, when ready, seal the envelope to deliver everyone's signing record:\n${vars.dashboardLink}`
      ),
      from: `notifications@${vars.operatorDomain}`,
      replyTo: `info@${vars.operatorDomain}`,
    };
  },

  expiryNotification(vars: { recipientName: string; documentName: string; operatorDomain: string }) {
    return {
      subject: `"${vars.documentName}" has expired`,
      html: wrap(`Envelope Expired`, `
        <p style="margin:0 0 15px;">Hi ${vars.recipientName},</p>
        <p style="margin:0 0 15px;">The signing request for <strong>"${vars.documentName}"</strong> has expired. Not all signatures were collected before the deadline.</p>
      `),
      text: textWrap(
        `Hi ${vars.recipientName},\n\nThe signing request for "${vars.documentName}" has expired. Not all signatures were collected before the deadline.`
      ),
      from: `notifications@${vars.operatorDomain}`,
      replyTo: `info@${vars.operatorDomain}`,
    };
  },

  retentionWarning(vars: { recipientName: string; documentName: string; deletionDate: string; operatorDomain: string }) {
    return {
      subject: `"${vars.documentName}" will be deleted on ${vars.deletionDate}`,
      html: wrap(`Document Retention Notice`, `
        <p style="margin:0 0 15px;">Hi ${vars.recipientName},</p>
        <p style="margin:0 0 15px;">The PDF for <strong>"${vars.documentName}"</strong> will be permanently deleted on <strong>${vars.deletionDate}</strong>. Please download your copy before then.</p>
        <p style="margin:0;font-size:13px;color:#666;">Your signing record (emailed to every party at completion) is the permanent record. This only removes kysigned&rsquo;s temporary copy.</p>
      `),
      text: textWrap(
        `Hi ${vars.recipientName},\n\nThe PDF for "${vars.documentName}" will be permanently deleted on ${vars.deletionDate}. Please download your copy.\n\nYour signing record (emailed to every party at completion) is the permanent record; this only removes kysigned's temporary copy.`
      ),
      from: `notifications@${vars.operatorDomain}`,
      replyTo: `info@${vars.operatorDomain}`,
    };
  },

  // DD-16: rich envelope-expired notification that includes the signer status
  // breakdown. Sent by handleEnvelopeExpiration to the sender AND to every
  // pending signer. The `role` discriminator switches copy — the sender sees a
  // "create a new envelope" hint, pending signers see a "no further action"
  // line.
  envelopeExpired(vars: {
    recipientName: string;
    documentName: string;
    senderName: string;
    role: 'sender' | 'signer';
    signedCount: number;
    totalCount: number;
    signedNames: string[];
    pendingNames: string[];
    operatorDomain: string;
  }) {
    const openingHtml =
      vars.role === 'sender'
        ? `Your envelope for <strong>"${vars.documentName}"</strong> has expired without collecting all signatures.`
        : `The signing request for <strong>"${vars.documentName}"</strong> sent by ${vars.senderName} has expired.`;

    const openingText =
      vars.role === 'sender'
        ? `Your envelope for "${vars.documentName}" has expired without collecting all signatures.`
        : `The signing request for "${vars.documentName}" sent by ${vars.senderName} has expired.`;

    const statusLine = `${vars.signedCount} of ${vars.totalCount} signer${vars.totalCount === 1 ? '' : 's'} completed.`;

    const signedBlockHtml = vars.signedNames.length
      ? `<p style="margin:0 0 10px;"><strong>Signed:</strong> ${vars.signedNames.join(', ')}</p>`
      : '';
    const pendingBlockHtml = vars.pendingNames.length
      ? `<p style="margin:0 0 15px;"><strong>Did not sign:</strong> ${vars.pendingNames.join(', ')}</p>`
      : '';

    const closingHtml =
      vars.role === 'sender'
        ? `<p style="margin:0;">If you'd still like to get this document signed, you can create a new envelope with the same PDF and invite only the signers who didn't complete.</p>`
        : `<p style="margin:0;">No further action is required. Any signatures already collected remain valid.</p>`;

    const signedBlockText = vars.signedNames.length ? `Signed: ${vars.signedNames.join(', ')}\n` : '';
    const pendingBlockText = vars.pendingNames.length ? `Did not sign: ${vars.pendingNames.join(', ')}\n` : '';

    const closingText =
      vars.role === 'sender'
        ? `If you'd still like to get this document signed, you can create a new envelope with the same PDF and invite only the signers who didn't complete.`
        : `No further action is required. Any signatures already collected remain valid.`;

    return {
      subject: `"${vars.documentName}" signing request has expired`,
      html: wrap(`Envelope Expired`, `
        <p style="margin:0 0 15px;">Hi ${vars.recipientName},</p>
        <p style="margin:0 0 15px;">${openingHtml}</p>
        <p style="margin:0 0 15px;">${statusLine}</p>
        ${signedBlockHtml}${pendingBlockHtml}${closingHtml}
      `),
      text: textWrap(
        `Hi ${vars.recipientName},\n\n${openingText}\n\n${statusLine}\n${signedBlockText}${pendingBlockText}\n${closingText}`
      ),
      from: `notifications@${vars.operatorDomain}`,
      replyTo: `info@${vars.operatorDomain}`,
    };
  },

  // v0.30.0 — F7.8 / Issue 10: creator creation-confirmation email. Sent to the
  // CREATOR when an envelope is created (previously the creator got nothing at
  // creation). Carries the signer list + a dashboard link + a keep-your-copy /
  // ephemeral-retention note. The canonical PDF is attached by the send site
  // (handleCreateEnvelope), not the template.
  envelopeCreated(vars: {
    documentName: string;
    envelopeId: string;
    signers: Array<{ name: string; email: string; status: string }>;
    dashboardLink: string;
    operatorDomain: string;
  }) {
    // F-5.6 — just the signer COUNT, not a redundant per-signer "pending" list
    // (all signers are pending at creation). The link is the envelope's own
    // status page (F-11.2), not the general dashboard.
    const n = vars.signers.length;
    const signerCount = `${n} signer${n === 1 ? '' : 's'}`;
    return {
      subject: `Envelope created: "${vars.documentName}"`,
      html: wrap(`Envelope Created`, `
        <p style="margin:0 0 15px;">Your envelope <strong>&ldquo;${vars.documentName}&rdquo;</strong> has been created and the signing requests are on their way to <strong>${signerCount}</strong>.</p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
        <tr><td style="background:#1a1a2e;border-radius:6px;padding:12px 28px;">
        <a href="${vars.dashboardLink}" style="color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;">View this envelope&rsquo;s status</a>
        </td></tr>
        </table>
        <p style="margin:0;font-size:13px;color:#666;"><strong>Your document is attached to this email, keep your copy.</strong> kysigned deletes the stored document once the envelope completes; the durable copy is the signing record emailed to every party.</p>
      `),
      text: textWrap(
        `Your envelope "${vars.documentName}" has been created and signing requests are on their way to ${signerCount}.\n\nView this envelope's status:\n${vars.dashboardLink}\n(envelope ${vars.envelopeId})\n\nYour document is attached to this email, keep your copy. kysigned deletes the stored document once the envelope completes; the durable copy is the signing record emailed to every party.`
      ),
      from: `notifications@${vars.operatorDomain}`,
      replyTo: `info@${vars.operatorDomain}`,
    };
  },

  // F-5.7 / AC-54 — short progress note to the creator each time a NON-creator
  // signer signs. The final signer's event is the completion distribution
  // (F-9.1), not a progress note. Deep-links to the envelope status page (F-11.2).
  // (Sent by the forward-processing pipeline, Phase 6, on each recorded signature.)
  creatorProgress(vars: {
    signerName: string;
    documentName: string;
    signedCount: number;
    totalCount: number;
    statusPageLink: string;
    operatorDomain: string;
    /** Envelope's auto-close setting (F-24) — consulted ONLY on the final signer
     *  to tailor the completion line. Defaults to the auto-close (true) wording. */
    autoClose?: boolean;
  }) {
    const isComplete = vars.totalCount > 0 && vars.signedCount >= vars.totalCount;
    // On the final signature, add a completion line that branches on auto-close (F-24):
    // auto-close on → "complete, bundle on its way"; off → "review and seal on the dashboard".
    const completionHtml = !isComplete
      ? ''
      : vars.autoClose === false
        ? `<p style="margin:0 0 18px;font-size:14px;color:#444;">All signers are in. Head to your dashboard to <strong>review and seal</strong> this envelope (&ldquo;Seal &amp; send&rdquo;) and deliver the final signing record to everyone.</p>`
        : `<p style="margin:0 0 18px;font-size:14px;color:#444;">All signers are in, your envelope is <strong>complete</strong>. Because it&rsquo;s set to send automatically when everyone signs, the final signing record is on its way to all parties.</p>`;
    const completionText = !isComplete
      ? ''
      : vars.autoClose === false
        ? `All signers are in. Head to your dashboard to review and seal this envelope ("Seal & send") and deliver the final signing record to everyone.\n\n`
        : `All signers are in, your envelope is complete. Because it's set to send automatically when everyone signs, the final signing record is on its way to all parties.\n\n`;
    return {
      subject: `${vars.signerName} signed "${vars.documentName}"`,
      html: wrap(`Signature Received`, `
        <p style="margin:0 0 15px;"><strong>${vars.signerName}</strong> just signed <strong>&ldquo;${vars.documentName}&rdquo;</strong>.</p>
        <p style="margin:0 0 ${isComplete ? '12' : '18'}px;font-size:14px;color:#15803d;"><strong>${vars.signedCount} of ${vars.totalCount}</strong> signers complete.</p>
        ${completionHtml}
        <table cellpadding="0" cellspacing="0" style="margin:0 0 8px;">
        <tr><td style="background:#1a1a2e;border-radius:6px;padding:12px 28px;">
        <a href="${vars.statusPageLink}" style="color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;">View this envelope&rsquo;s status</a>
        </td></tr>
        </table>
      `),
      text: textWrap(
        `${vars.signerName} just signed "${vars.documentName}".\n\n${vars.signedCount} of ${vars.totalCount} signers complete.\n\n${completionText}View this envelope's status:\n${vars.statusPageLink}`
      ),
      from: `notifications@${vars.operatorDomain}`,
      replyTo: `info@${vars.operatorDomain}`,
    };
  },

  // F-9.8 / AC-50 — notify the CREATOR that a signing request couldn't be
  // delivered to a signer (hard bounce); the fix is now per-signer editing on the
  // envelope page (F-23): remove + re-add at the corrected address (NOT the old
  // void-and-recreate, which DD-10 superseded).
  signingRequestUndeliverable(vars: {
    senderName: string;
    documentName: string;
    signerEmail: string;
    dashboardLink: string;
    operatorDomain: string;
  }) {
    return {
      subject: `Couldn't deliver your signing request for "${vars.documentName}"`,
      html: wrap(`Delivery Problem`, `
        <p style="margin:0 0 15px;">Hi ${vars.senderName},</p>
        <p style="margin:0 0 15px;">We couldn&rsquo;t deliver the signing request for <strong>&ldquo;${vars.documentName}&rdquo;</strong> to <strong>${vars.signerEmail}</strong>. The address bounced.</p>
        <p style="margin:0 0 18px;font-size:13px;color:#444;">Double-check the address. On the envelope page you can fix it: remove this signer and add them back at the corrected address, or remove them if they&rsquo;re no longer needed.</p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 8px;">
        <tr><td style="border:1px solid #1a1a2e;border-radius:6px;padding:10px 22px;">
        <a href="${vars.dashboardLink}" style="color:#1a1a2e;text-decoration:none;font-weight:600;font-size:14px;">Manage this envelope</a>
        </td></tr>
        </table>
      `),
      text: textWrap(
        `Hi ${vars.senderName},\n\nWe couldn't deliver the signing request for "${vars.documentName}" to ${vars.signerEmail}. The address bounced.\n\nDouble-check the address. On the envelope page you can fix it: remove this signer and add them back at the corrected address, or remove them if they're no longer needed.\n\nManage this envelope: ${vars.dashboardLink}`
      ),
      from: `notifications@${vars.operatorDomain}`,
      replyTo: `info@${vars.operatorDomain}`,
    };
  },
};
