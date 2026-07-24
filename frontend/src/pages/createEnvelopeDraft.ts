/**
 * createEnvelopeDraft — pure helpers for the create-envelope page, kept OUT of
 * the component file so `CreateEnvelopePage.tsx` only exports its component
 * (the react-refresh/only-export-components lint rule).
 */

/**
 * F-025 (AC-228, 0.61.1 "no link on the gate may cost the visitor their
 * envelope") — is there a held/unsent draft worth guarding navigation against?
 * The gate/sending phases always are; on the form, any real content (a file, a
 * doc name, or a signer with a name/email) counts. An empty form is not a draft.
 */
export function hasUnsentDraft(s: {
  gatePhase: 'form' | 'gate' | 'sending'
  file: File | null
  docName: string
  signers: Array<{ email: string; name: string }>
}): boolean {
  if (s.gatePhase !== 'form') return true
  if (s.file) return true
  if (s.docName.trim() !== '') return true
  return s.signers.some((x) => x.email.trim() !== '' || x.name.trim() !== '')
}

export const DRAFT_LEAVE_WARNING =
  'You have an unsent envelope on this page. If you leave, your document and signers will be lost. Leave anyway?'
