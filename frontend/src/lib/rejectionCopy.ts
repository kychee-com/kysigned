/**
 * F-45.5 / AC-275 — the dashboard's plain-words guidance for a signer whose latest
 * forward was rejected: what went wrong, what to tell them, and, for the two
 * "organization has no DKIM" classes, the provider's FAQ steps to share. Keyed by
 * the classes the API sends in `last_rejection.class`.
 */
export interface RejectionGuidance {
  reason: string
  tell: string
  /** The provider's setup steps (only for the no-DKIM classes). */
  faqHref?: string
}

const ALREADY_TOLD = 'We’ve already emailed them how to fix it.'

const GUIDANCE: Record<string, RejectionGuidance> = {
  google_workspace_no_dkim: {
    reason: 'Their organization’s Google Workspace email isn’t set up for verified signing, so their forward couldn’t count.',
    tell: 'Their email administrator needs to switch on DKIM in the Google Admin console. We’ve sent them instructions; the guide below helps if you want to pass it on.',
    faqHref: '/faq#email-setup-google',
  },
  microsoft_365_no_dkim: {
    reason: 'Their organization’s Microsoft 365 email isn’t set up for verified signing, so their forward couldn’t count.',
    tell: 'Their email administrator needs to switch on DKIM in the Microsoft Defender portal. We’ve sent them instructions; the guide below helps if you want to pass it on.',
    faqHref: '/faq#email-setup-microsoft',
  },
  wrong_phrase: { reason: 'Their last forward didn’t start with “I sign this document”.', tell: ALREADY_TOLD },
  attachment_missing: { reason: 'Their last forward didn’t include the attached document.', tell: ALREADY_TOLD },
  attachment_modified: { reason: 'The document attached to their last forward had been changed.', tell: ALREADY_TOLD },
  sender_auth: { reason: 'Their last forward didn’t pass our sender checks.', tell: ALREADY_TOLD },
  dkim_unverifiable: { reason: 'Their email provider’s signature on their last forward didn’t verify.', tell: ALREADY_TOLD },
}

export const REJECTION_CLASSES: readonly string[] = Object.keys(GUIDANCE)

export function rejectionGuidance(rejectionClass: string): RejectionGuidance {
  return GUIDANCE[rejectionClass] ?? { reason: 'Their last forward wasn’t accepted.', tell: ALREADY_TOLD }
}
