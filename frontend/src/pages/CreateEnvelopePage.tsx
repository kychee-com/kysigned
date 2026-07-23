import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, apiGet, apiPost, formatUsd, type CreditBalance } from '../lib/api'
import { friendlyCreateError } from '../lib/friendlyError'
import { isPdfTooLarge, pdfTooLargeMessage } from '../lib/pdfSize'
import { useAuth } from '../auth/auth-core'
import { SignInScreen } from '../auth/SignInScreen'
import { trackEvent, GA_EVENTS } from '../lib/analytics'
import { telemetryEvent, telemetryEventOnce } from '../lib/telemetry'
import { getOperatorConfig } from '../config/operator'

interface SignerInput {
  email: string
  name: string
  /** F-22.2 — this signer is signing on behalf of an organisation (checkbox). */
  onBehalf: boolean
  /** The organisation name (only meaningful when onBehalf is true). */
  onBehalfOf: string
  /**
   * F1.10 — the creator's own "will you also sign?" row. Tracked by this explicit
   * flag (NOT an email match) so a typed/autofilled signer that happens to share
   * the creator's email is never mistaken for it.
   */
  isCreator?: boolean
}

const emptySigner = (email = '', name = ''): SignerInput => ({ email, name, onBehalf: false, onBehalfOf: '' })

export function CreateEnvelopePage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  // F-39.1 — the editor is open to guests; the sign-in moment is the SEND
  // (F-39.3), not the way in. Guest mode hides the self-sign row (its values
  // belong to a signed-in creator, F-39.2) and shows the trial line instead.
  const isGuest = !user
  const [docName, setDocName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [signers, setSigners] = useState<SignerInput[]>([emptySigner()])
  const [isSenderSigner, setIsSenderSigner] = useState(false)
  // F-24 — auto-close (default on). Off = the envelope waits in "awaiting seal"
  // for the creator's manual "Seal & send" once everyone has signed.
  const [autoClose, setAutoClose] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // F-39.3 — the sign-in gate at Send. 'form' = drafting; 'gate' = a validated
  // guest draft is HELD (heldPayloadRef) while the in-flow SignInScreen runs;
  // 'sending' = a session appeared and the held create is dispatching. The
  // draft never leaves this tab (DD-51): no envelope, bytes, or charge exists
  // server-side before the gate is crossed.
  const [gatePhase, setGatePhase] = useState<'form' | 'gate' | 'sending'>('form')
  const heldPayloadRef = useRef<Record<string, unknown> | null>(null)
  const gateSentOnceRef = useRef(false)
  // Which mandatory field failed validation — drives the per-field red highlight.
  // (Scroll-to-section was replaced by scroll-to-top so the error banner is always
  // seen even when several fields are wrong — Barry QA 2026-06-19.)
  const [firstError, setFirstError] = useState<'file' | 'docName' | 'signers' | null>(null)

  // F-13 / AC-5 — enforce the envelope-credit gate UP-FRONT (Barry QA 2026-06-16:
  // "if I don't have $0.25 I should be referred to PAYMENT and not allowed to
  // fill the envelope and then told I'm out of funds"). Read the balance on load
  // and, when it's below the per-envelope price, replace the whole form with an
  // Add-credits referral. Optimistic: the form renders until we KNOW the balance
  // is short, so a failed/absent balance read (self-host, billing off) never
  // traps the user behind a gate.
  const [balance, setBalance] = useState<CreditBalance | null>(null)
  const [redirecting, setRedirecting] = useState(false)
  // GH#108 — billing/balance is [service]/private: a fork never reads the balance
  // (the /v1/credits link is gated behind the operator config), so the credit gate
  // is inert there and creation is allowlist-gated server-side instead.
  const { showBilling } = getOperatorConfig()
  useEffect(() => {
    // Guests have no balance to read (F-39.1) — the credit outcome surfaces
    // AFTER the send-gate sign-in (F-39.4), not before.
    if (!showBilling || isGuest) return
    apiGet<CreditBalance>('/v1/credits/balance').then(setBalance).catch(() => setBalance(null))
  }, [showBilling, isGuest])
  const insufficientCredit = balance != null && !balance.sufficient_for_envelope

  const goToTopUp = async () => {
    setRedirecting(true)
    setError('')
    try {
      const { url } = await apiPost<{ url: string }>('/v1/credits/checkout', { email: user?.email })
      window.location.href = url
    } catch (e) {
      setError((e as Error).message)
      setRedirecting(false)
    }
  }

  // F-39.4 (AC-226) — top-up WITHOUT losing the draft: when a draft exists the
  // checkout opens in a NEW tab, so this tab (the only place the draft lives,
  // DD-51) stays alive and the same draft sends after the top-up.
  const topUpInNewTab = async () => {
    setRedirecting(true)
    try {
      const { url } = await apiPost<{ url: string }>('/v1/credits/checkout', { email: user?.email })
      window.open(url, '_blank', 'noopener')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRedirecting(false)
    }
  }
  // F16.10 suggestion state intentionally removed in v0.18.x — see note in
  // handleSubmit. Will be reinstated when the backend + message logic land
  // their rewrite. createdEnvelopeId was the marker for that branch; now
  // we navigate directly so it's no longer needed.

  const addSigner = () => setSigners([...signers, emptySigner()])
  const removeSigner = (i: number) => setSigners(signers.filter((_, idx) => idx !== i))
  // F-39.5 (AC-227) — the "invested in the editor" funnel fact, DD-52: fired by
  // hand at the interaction sites (first file pick / first signer keystroke),
  // deduped per page load by the rail's eventOnce. The FACT only — no filename,
  // address, or any other draft value ever rides a telemetry call.
  const markDraftStarted = () => telemetryEventOnce('draft_started')
  const patchSigner = (i: number, patch: Partial<SignerInput>) => {
    markDraftStarted()
    setSigners((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  }

  // F1.10 / F1.11 (DD-98): "Will you also sign?" adds the CREATOR to the
  // SUBMITTED signer list as a real signer row — email locked to their login
  // email, name prefilled from their saved name (F1.11), editable. The creator
  // row is tracked by an explicit `isCreator` FLAG, not an email match: checking
  // always adds a distinct row, and unchecking removes ONLY that row — so a typed
  // or browser-autofilled signer that happens to share the creator's email is
  // never adopted or wiped (Barry QA — autofill put the creator email in Signer 1,
  // which broke the old email-match logic).
  const creatorEmail = user?.email ?? ''
  const isCreatorRow = (s: SignerInput) => !!s.isCreator
  const toggleSenderSigner = (checked: boolean) => {
    setIsSenderSigner(checked)
    if (creatorEmail === '') return
    if (checked) {
      setSigners((prev) =>
        prev.some((s) => s.isCreator)
          ? prev
          : [{ ...emptySigner(creatorEmail, user?.display_name ?? ''), isCreator: true }, ...prev],
      )
    } else {
      setSigners((prev) => prev.filter((s) => !s.isCreator))
    }
  }

  // On ANY validation failure, jump to the TOP of the page so the red error
  // banner is always seen — NOT to the offending field (there may be several;
  // scrolling to one hides the rest). The per-field red highlight (firstError)
  // still flags which inputs need fixing. (Barry QA 2026-06-19.)
  const scrollToTop = () => window.scrollTo({ top: 0, behavior: 'smooth' })

  /**
   * The actual create POST + success routing — one path for both the classic
   * signed-in Send and the F-39.3 held send after the gate.
   */
  const dispatchEnvelope = async (payload: Record<string, unknown>) => {
    setSubmitting(true)
    setError('')
    try {
      const result = await apiPost<{
        envelope_id: string
        // 2026-06-21 — per-signer send outcome. `undeliverable`/`failed` mean the
        // envelope was created but some invites didn't go out; surface a warning
        // instead of a misleading all-green "sent" banner.
        delivery?: { delivered: number; undeliverable: string[]; failed: string[] }
        suggestion?: {
          has_existing_signatures: boolean
          signed_count: number
          total_count: number
          missing_signers: Array<{ email: string; name: string }>
        }
      }>('/v1/envelope', payload)

      // GA4 key event (F-14.6 / AC-47): an envelope was created. Consent-gated
      // upstream by Consent Mode v2; a no-op when no GA4 is configured.
      trackEvent(GA_EVENTS.ENVELOPE_CREATED, { envelope_id: result.envelope_id })

      // F16.10 suggestion prompt is intentionally NOT rendered in v0.18.x.
      // The backend logic in kysigned/src/api/envelope.ts triggers on any
      // pre-existing envelope sharing the document_hash — including expired
      // and voided ones from old E2E test runs — and the message template
      // ("0 of 2 signatures... 1 missing signer") doesn't match the data
      // shape from getDocumentsByOwner. Filed as a follow-up: only surface
      // when the matching envelopes are ACTIVE + partially-signed by the
      // SAME sender. Until then, route straight to the new envelope.
      // Carry justSent so the detail page jumps to the top + shows the green
      // "Envelope sent successfully" banner (Barry QA 2026-06-19). If any invite
      // didn't go out (undeliverable/transient), carry the addresses so the detail
      // page warns instead of showing all-green (2026-06-21).
      const deliveryProblems = [
        ...(result.delivery?.undeliverable ?? []),
        ...(result.delivery?.failed ?? []),
      ]
      navigate(`/dashboard/envelope/${result.envelope_id}`, {
        state: { justSent: true, ...(deliveryProblems.length ? { deliveryProblems } : {}) },
      })
    } catch (e) {
      // Don't leak an opaque server fault (run402's "Internal function error") —
      // show a calm fallback for 5xx/opaque, keep helpful 4xx validation messages
      // (2026-06-21). scroll-to-top so the banner is seen. A held-send failure
      // (e.g. the F-39.4 insufficient-credit outcome) returns to the FORM with
      // the draft intact — never a dead end.
      setError(friendlyCreateError(e instanceof ApiError ? e.status : undefined, e instanceof Error ? e.message : undefined))
      setFirstError(null)
      setGatePhase('form')
      scrollToTop()
    } finally {
      setSubmitting(false)
    }
  }

  /** Build the create body from the draft (shared by preflight + dispatch). */
  const buildPayload = async (): Promise<Record<string, unknown>> => {
    const base64 = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve((reader.result as string).split(',')[1])
      reader.readAsDataURL(file!)
    })
    const signerList = signers.map((s) => ({
      email: s.email,
      name: s.name,
      // F-22.2 — only emit on_behalf_of when the checkbox is on AND a name was typed.
      on_behalf_of: s.onBehalf && s.onBehalfOf.trim() ? s.onBehalfOf.trim() : undefined,
    }))
    return {
      document_name: docName,
      pdf_base64: base64,
      signers: signerList,
      auto_close: autoClose,
    }
  }

  // F-39.3 — a session appeared in THIS browser while the gate held the draft:
  // fire the held send exactly once (SignInScreen ref-guards the callback; the
  // ref here is belt-and-braces against a remount).
  const handleGateSignedIn = () => {
    if (gateSentOnceRef.current || !heldPayloadRef.current) return
    gateSentOnceRef.current = true
    setGatePhase('sending')
    void dispatchEnvelope(heldPayloadRef.current)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    // F-39.5 — every Send PRESS is a funnel fact (valid or not, guest or
    // signed in): the click measures intent; validation outcomes follow.
    telemetryEvent('send_clicked')
    if (!file) { setError('Please upload a PDF'); setFirstError('file'); scrollToTop(); return }
    // Reject oversize PDFs here, with a clear message — otherwise the base64 upload
    // inflates past the 6 MiB Lambda invoke cap and the gateway returns an opaque 502.
    if (isPdfTooLarge(file.size)) { setError(pdfTooLargeMessage(file.size)); setFirstError('file'); scrollToTop(); return }
    if (!docName.trim()) { setError('Please enter a document name'); setFirstError('docName'); scrollToTop(); return }
    if (signers.some((s) => !s.email || !s.name)) { setError('All signers need name and email'); setFirstError('signers'); scrollToTop(); return }
    setFirstError(null)

    if (!isGuest) {
      // Signed-in Send: unchanged — immediate dispatch, no gate (AC-225).
      const payload = await buildPayload()
      await dispatchEnvelope(payload)
      return
    }

    // Guest Send (F-39.3): validate FIRST — the free public preflight runs the
    // same server-side rejections a signed-in create would hit (F-3.2a address
    // rules, size guards), so nobody signs in just to learn the form is
    // invalid. Preflight is STATELESS: nothing is stored server-side. Only a
    // draft that passes opens the gate.
    setSubmitting(true)
    setError('')
    try {
      const payload = await buildPayload()
      await apiPost('/v1/envelope/preflight', payload)
      heldPayloadRef.current = payload
      setGatePhase('gate')
    } catch (e) {
      setError(friendlyCreateError(e instanceof ApiError ? e.status : undefined, e instanceof Error ? e.message : undefined))
      setFirstError(null)
      scrollToTop()
    } finally {
      setSubmitting(false)
    }
  }

  // F16.10 suggestion-prompt render branch removed in v0.18.x — see note in
  // handleSubmit. Future fix will reinstate with correct filter logic and
  // a sensible message template.

  // F-39.3 — the gate view: the draft is HELD (state + heldPayloadRef live on;
  // the form is merely unmounted) while the one SignInScreen runs in-flow. The
  // back link abandons nothing — it just re-renders the form.
  if (gatePhase === 'gate') {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8">
        <button
          type="button"
          data-testid="gate-back"
          onClick={() => setGatePhase('form')}
          className="inline-flex items-center gap-1 min-h-[44px] text-sm text-gray-500 hover:text-gray-900 mb-3 cursor-pointer"
        >
          <span aria-hidden>←</span> Back to your envelope
        </button>
        <SignInScreen title="Sign in to send your envelope" telemetryTrigger="send" onSignedIn={handleGateSignedIn} />
      </div>
    )
  }

  // The held send is dispatching (a session just appeared) — F-39.3.
  if (gatePhase === 'sending') {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8 text-center" data-testid="gate-sending">
        <div className="animate-spin h-6 w-6 border-4 border-gray-300 border-t-gray-900 rounded-full mx-auto mt-16" />
        <p className="text-sm text-gray-500 mt-4">Sending your envelope…</p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <Link
        to={isGuest ? '/' : '/dashboard'}
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3"
      >
        <span aria-hidden>←</span> {isGuest ? 'Back to Home' : 'Back to Dashboard'}
      </Link>
      <h1 className="text-2xl font-semibold mb-6">Create an Envelope</h1>
      {/* F-39.1 — the cost question answered before the gate ever appears: the
          F-39.7 teaching line, guest-only (a signed-in creator has the credit
          pill). */}
      {isGuest && (
        <p className="text-sm text-gray-600 -mt-4 mb-6" data-testid="guest-trial-line">
          An envelope is one document sent out for signatures. Your first 4 are free. No credit card.
        </p>
      )}

      {/* The replacing credit card serves its ORIGINAL purpose only — stopping
          someone from FILLING a form they can't send (Barry QA 2026-06-16). A
          draft that already exists must never be swallowed by it (F-39.4 /
          AC-226): with a file picked, the form stays and the inline top-up
          strip below carries the referral instead. */}
      {insufficientCredit && !file ? (
        <div className="bg-white border border-gray-200 rounded-xl p-8 text-center space-y-4">
          <div
            className="mx-auto w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center text-amber-600 text-2xl font-semibold"
            aria-hidden
          >
            $
          </div>
          <h2 className="text-lg font-semibold">Add credits to send an envelope</h2>
          <p className="text-sm text-gray-600 max-w-md mx-auto">
            Sending an envelope costs a flat{' '}
            <strong>{formatUsd(balance!.envelope_cost_usd_micros)}</strong>, for any number of
            signers, one price. Your balance is{' '}
            <strong>{formatUsd(balance!.balance_usd_micros)}</strong>.
          </p>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="button"
            onClick={goToTopUp}
            disabled={redirecting}
            className="px-5 py-2.5 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-40"
          >
            {redirecting ? 'Taking you to checkout…' : 'Add credits'}
          </button>
          <p className="text-xs text-gray-400">
            You&rsquo;ll top up on our secure payment page, then come straight back here to send.
          </p>
        </div>
      ) : (
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">{error}</div>
        )}

        {/* F-39.4 / AC-226 — the draft-preserving top-up: shown when the
            balance is short but a draft EXISTS. Checkout opens in a new tab so
            the draft tab survives; Send again afterward sends this same draft. */}
        {insufficientCredit && file && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900" data-testid="topup-inline">
            <p className="font-medium mb-2">
              Add credits to send. Your envelope is saved in this tab: top up, then press Send again.
            </p>
            <button
              type="button"
              data-testid="topup-inline-btn"
              onClick={topUpInNewTab}
              disabled={redirecting}
              className="min-h-[44px] px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-40"
            >
              {redirecting ? 'Opening checkout…' : 'Add credits (opens a new tab)'}
            </button>
          </div>
        )}

        {/* F22.7.1 — Cover-page disclosure. Before the file picker, tell the
            envelope creator we'll add a one-page cover. Keeps the canonical-
            PDF semantics from being a surprise + sets up the "verify this
            envelope" reproduce.sh path on the envelope detail page (F22.7.2). */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-900">
          <p className="font-medium mb-1">kysigned adds a one-page cover before sending</p>
          <p className="text-xs text-blue-800 mb-1">
            Every envelope ships with a kysigned-generated cover page (page 1) before your content. The cover carries:
          </p>
          <ul className="text-xs text-blue-800 list-disc ml-5 space-y-0.5">
            <li>The document name, your email (shown to signers as &ldquo;Sender&rdquo;), envelope ID, and timestamp</li>
            <li>The signer&rsquo;s consent to sign electronically instead of with a wet-ink signature, and to be legally bound, satisfying US (ESIGN, UETA) and EU (eIDAS) e-signature law in a single reply (<a href="/how-it-works" target="_blank" rel="noopener noreferrer" className="text-blue-900 underline">how this works &rarr;</a>)</li>
            <li>Instructions so the signer can independently verify the document hash before replying</li>
          </ul>
          <p className="text-xs text-blue-700 mt-2">
            Keep your original PDF: you can re-check it later from the envelope detail page to confirm we didn&rsquo;t tamper with your upload.
          </p>
        </div>

        {/* Document */}
        <div
          className={`bg-white border rounded-xl p-6 space-y-4 ${firstError === 'file' || firstError === 'docName' ? 'border-red-300 ring-1 ring-red-300' : 'border-gray-200'}`}
        >
          <h2 className="text-sm font-medium">Document</h2>
          <div>
            <label className="block text-sm text-gray-600 mb-1">PDF file</label>
            <input
              type="file" accept=".pdf"
              // Clear the value before the picker opens so re-selecting the SAME
              // file still counts as a change — otherwise the browser fires no
              // onChange on an identical re-pick and the name never refreshes
              // (Barry QA). State keeps the File, so the picker just re-derives.
              onClick={(e) => { e.currentTarget.value = '' }}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null
                if (f) markDraftStarted() // F-39.5 — the fact of the pick, never the file
                setFile(f)
                // Always reflect the chosen file in the display name, overwriting a
                // prior value — so re-picking a file refreshes the name. The user can
                // still tweak it afterward (Barry QA).
                if (f) setDocName(f.name.replace(/\.pdf$/i, ''))
                // Instant feedback: flag an oversize PDF the moment it's picked.
                if (f && isPdfTooLarge(f.size)) { setError(pdfTooLargeMessage(f.size)); setFirstError('file') }
                else if (f && firstError === 'file') { setFirstError(null); setError('') }
              }}
              className={`w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200 ${firstError === 'file' ? 'ring-2 ring-red-400 rounded-lg' : ''}`}
            />
            <p className="text-xs text-gray-400 mt-1">Max 3 MB per PDF.</p>
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">Display name</label>
            <input
              type="text" value={docName}
              onChange={(e) => { setDocName(e.target.value); if (firstError === 'docName') setFirstError(null) }}
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 ${firstError === 'docName' ? 'border-red-400 ring-1 ring-red-400' : 'border-gray-300'}`}
              placeholder="e.g., NDA for Acme Corp"
            />
            <p className="text-xs text-gray-400 mt-1">
              Shown to signers in the email subject and signing page. Auto-filled from the filename, edit if you want something nicer.
            </p>
          </div>
        </div>

        {/* Signers */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Signers</h2>
            <button type="button" onClick={addSigner} className="text-sm text-blue-600 hover:underline">
              + Add signer
            </button>
          </div>

          {/* Sender as signer — F-39.2: ABSENT (not disabled) for a guest; the
              row's email/name are the signed-in creator's values, which a
              guest session does not have. A guest who wants to sign their own
              envelope adds themselves after the gated send (F-23 editing). */}
          {!isGuest && (
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={isSenderSigner} onChange={(e) => toggleSenderSigner(e.target.checked)}
                     className="rounded border-gray-300" />
              Will you also sign this document?
            </label>
          )}

          {signers.map((s, i) => (
            <div key={i} className="border border-gray-100 rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">Signer {i + 1}{isCreatorRow(s) ? ' (you)' : ''}</span>
                {signers.length > 1 && !isCreatorRow(s) && (
                  <button type="button" onClick={() => removeSigner(i)} className="text-xs text-red-400 hover:text-red-600">
                    Remove
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Full name</label>
                  {/* These are OTHER people — the browser/password-manager must NEVER
                      inject YOUR saved identity here. autoComplete="off" alone is
                      ignored by Chrome + password managers, so we also emit the PM
                      ignore hints (1Password/LastPass/Dashlane) (Barry QA: his email
                      kept autofilling Signer 1). autoFocus the first name on open. */}
                  <input
                    type="text" autoComplete="off" data-1p-ignore="true" data-lpignore="true" data-form-type="other"
                    autoFocus={i === 0} placeholder="e.g., Jane Smith" value={s.name}
                    onChange={(e) => { patchSigner(i, { name: e.target.value }); if (firstError === 'signers') setFirstError(null) }}
                    className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 ${firstError === 'signers' && !s.name ? 'border-red-400 ring-1 ring-red-400' : 'border-gray-300'}`}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Email</label>
                  {/* type="text" + inputMode="email" (NOT type="email") — the email
                      input type is the strongest autofill trigger; this keeps the
                      email keyboard on mobile without inviting the browser/PM to
                      inject the user's own saved address (Barry QA). */}
                  <input
                    type="text" inputMode="email" autoComplete="off" data-1p-ignore="true" data-lpignore="true" data-form-type="other"
                    placeholder="jane.smith@example.com" value={s.email}
                    onChange={(e) => { patchSigner(i, { email: e.target.value }); if (firstError === 'signers') setFirstError(null) }}
                    readOnly={isCreatorRow(s)}
                    title={isCreatorRow(s) ? 'Your account email: you’re signing as yourself. To sign from another address, add it as a separate signer.' : undefined}
                    className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900${isCreatorRow(s) ? ' bg-gray-50 text-gray-500 cursor-not-allowed' : ''} ${firstError === 'signers' && !s.email ? 'border-red-400 ring-1 ring-red-400' : 'border-gray-300'}`}
                  />
                </div>
              </div>
              <p className="text-xs text-gray-400">
                Full name appears in the signing email greeting and audit trail. Email is the identity used for signing.
              </p>

              {/* F-22.2 — signing on behalf of an organisation. Adds the declaration
                  to this signer's signing email + the bundle signature page. */}
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={s.onBehalf}
                  onChange={(e) => patchSigner(i, { onBehalf: e.target.checked, onBehalfOf: e.target.checked ? s.onBehalfOf : '' })}
                  className="rounded border-gray-300"
                />
                This person is signing on behalf of an organisation
              </label>
              {s.onBehalf && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Organisation name</label>
                  <input
                    type="text" autoComplete="organization" placeholder="e.g., Acme Corp" value={s.onBehalfOf}
                    onChange={(e) => patchSigner(i, { onBehalfOf: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    Added to this signer&rsquo;s legal declaration in the signing email and shown on the signing record&rsquo;s signature page.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* F-24 — auto-close vs manual seal */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={autoClose}
              onChange={(e) => setAutoClose(e.target.checked)}
              className="mt-0.5 rounded border-gray-300"
            />
            <span>
              <span className="font-medium">Send the signing record automatically when everyone has signed</span>
              <span className="block text-xs text-gray-400 mt-0.5">
                On by default. Turn this off to review the signers and seal the envelope yourself
                (&ldquo;Seal &amp; send&rdquo;) once all signatures are in.
              </span>
            </span>
          </label>
        </div>

        <button type="submit" disabled={submitting}
                className="w-full py-3 bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-800 disabled:opacity-40">
          {submitting ? 'Sending...' : 'Send for Signing'}
        </button>
      </form>
      )}
    </div>
  )
}
