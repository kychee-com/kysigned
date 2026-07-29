import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ApiError, apiGet, apiPatch, apiPost, formatUsd, type CreditBalance } from '../lib/api'
import { CEREMONY_ABANDONED_NOTICE, friendlyCreateError, friendlyGoogleError, friendlyRestoreError, RESTORE_LINK_FAILED, SAMPLE_LOAD_FAILED, SESSION_EXPIRED } from '../lib/friendlyError'
import { isPdfTooLarge, pdfTooLargeMessage } from '../lib/pdfSize'
import { useAuth } from '../auth/auth-core'
import { SignInScreen } from '../auth/SignInScreen'
import { trackEvent, GA_EVENTS } from '../lib/analytics'
import { telemetryEvent, telemetryEventOnce } from '../lib/telemetry'
import { getOperatorConfig } from '../config/operator'
import { hasUnsentDraft, DRAFT_LEAVE_WARNING } from './createEnvelopeDraft'
import { peekGoogleDraftStash, takeGoogleDraftStash } from '../auth/google'

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

/**
 * F-40 — what `GET /v1/pending-send/:id` returns: the draft's IDENTITY, never
 * its contents. The document is described (name, size) and reachable only by the
 * claim, so no unauthenticated caller can read the bytes back (AC-243).
 */
interface PendingSendView {
  email: string
  document_name: string
  byte_count: number
  signers: Array<{ email: string; name: string; on_behalf_of?: string }>
  auto_close: boolean
  claimed: boolean
  envelope_id?: string
  expires_at: string
}

/**
 * F-40/F-41.6 — the comparable shape of a draft's editable content, used to
 * tell "committed and unchanged" (safe to leave) from "edited since we saved
 * it" (a real unsaved change). The document FILE is excluded on purpose: it is
 * immutable for the life of a pending send.
 */
function currentSnapshot(v: { docName: string; signers: SignerInput[]; autoClose: boolean }) {
  return {
    docName: v.docName.trim(),
    autoClose: v.autoClose,
    signers: v.signers.map((s) => ({
      email: s.email.trim(),
      name: s.name.trim(),
      onBehalfOf: s.onBehalf && s.onBehalfOf.trim() ? s.onBehalfOf.trim() : '',
    })),
  }
}

/** The same shape, built from what the service says it holds. */
function restoredSnapshot(d: PendingSendView) {
  return {
    docName: d.document_name.trim(),
    autoClose: d.auto_close,
    signers: d.signers.map((s) => ({
      email: s.email.trim(),
      name: s.name.trim(),
      onBehalfOf: s.on_behalf_of?.trim() ?? '',
    })),
  }
}

/** F-40 — what the landing tab was asked to do, read once from the URL. */
function readHandover(search: string) {
  const params = new URLSearchParams(search)
  const draft = params.get('draft')
  return {
    // F-028 — the handle is `<id>.<secret>`; an id on its own reads nothing.
    draftId: draft && /^ps_[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,64}$/.test(draft) ? draft : null,
    claim: params.get('claim') === '1',
    signInFailed: params.get('signin_failed') === '1',
    // F-41.6 — a Google ceremony failure names its code so the restore notice
    // can give the specific next step (e.g. the linking guidance, AC-247).
    failReason: params.get('reason'),
  }
}

export function CreateEnvelopePage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, loading: authLoading, refresh: refreshAuth } = useAuth()
  // F-40 — this render may BE the magic-link landing. Read once: the URL is the
  // rail that survives a failed exchange (DD-57), so it is what tells us there
  // is a document to bring back even when sign-in produced nothing.
  const [handover] = useState(() => readHandover(location.search))
  // F-39.1 — the editor is open to guests; the sign-in moment is the SEND
  // (F-39.3), not the way in. Guest mode hides the self-sign row (its values
  // belong to a signed-in creator, F-39.2) and shows the trial line instead.
  //
  // 2026-07-25 — `loading` is NOT `guest`. AuthContext starts loading=true with
  // user=null, and this is the ONE route without a RequireAuth wrap, so nothing
  // else covers the hydration window: reading `user` alone rendered the guest UI
  // to a signed-in creator and, on Send, pushed them into the sign-in gate they
  // had already passed. We claim no identity until auth settles; the submit path
  // stays optimistic (signed-in) because a wrong guess now lands on the 401 route
  // in dispatchEnvelope, which keeps the draft and offers sign-in.
  const isGuest = !authLoading && !user
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
  // Why the gate is showing, when it isn't the ordinary guest one (the 401
  // recovery below). Kept OUT of `error` so leaving the gate doesn't strand a
  // sign-in notice on the form.
  const [gateNotice, setGateNotice] = useState('')
  // One 401 recovery per Send. If the retry after sign-in 401s again, the
  // session is not the problem: fall back to the form rather than ping-pong
  // between the gate and a create that keeps failing.
  const authRetryRef = useRef(false)

  // ── F-40: the pending send ────────────────────────────────────────────────
  // The handle of the draft this page is working on. Set when the gate stores a
  // guest draft, or read from the URL when this tab IS the magic-link landing.
  // F-41.6 (AC-252) — read at mount, non-destructively: when this load carries no
  // `?draft`, a stashed ceremony handle means the visitor came back from Google
  // without finishing, and their committed draft is what should be on screen.
  const [ceremonyStash] = useState<string | null>(() =>
    handover.draftId ? null : peekGoogleDraftStash(),
  )
  /** The draft this load restores, from the URL (email path) or the stash (Google). */
  const restoreHandle = handover.draftId ?? ceremonyStash
  const [draftHandle, setDraftHandle] = useState<string | null>(restoreHandle)
  // A restored draft's document: the file is immutable for the life of the
  // pending send, so we carry its IDENTITY (name, size) and never its bytes.
  const [restoredFile, setRestoredFile] = useState<{ name: string; size: number } | null>(null)
  // The bound address, so a resend prefills what the visitor already gave.
  const [restoredEmail, setRestoredEmail] = useState('')
  // Why this page is showing a restored document rather than an empty editor.
  const [restoreNotice, setRestoreNotice] = useState(
    handover.signInFailed ? (handover.failReason ? friendlyGoogleError(handover.failReason) : RESTORE_LINK_FAILED) : '',
  )
  // The composing tab's ending: another browser claimed the draft and sent it.
  const [sentElsewhere, setSentElsewhere] = useState<string | null>(null)
  const claimFiredRef = useRef(false)
  const restoreFiredRef = useRef(false)
  /** What the service holds for this draft; null until something is committed.
   *  STATE, not a ref: the nav guard reads it during render, and a ref change
   *  would not re-render — the value the guard reads must be the rendered one. */
  const [committedSnapshot, setCommittedSnapshot] = useState<ReturnType<typeof currentSnapshot> | null>(null)
  const isRestored = restoredFile !== null

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
    // AFTER the send-gate sign-in (F-39.4), not before. `authLoading` is neither
    // case yet: waiting for the settle keeps a guest page load from firing one
    // doomed balance request on the way past.
    if (authLoading || !showBilling || isGuest) return
    apiGet<CreditBalance>('/v1/credits/balance').then(setBalance).catch(() => setBalance(null))
  }, [authLoading, showBilling, isGuest])
  const insufficientCredit = balance != null && !balance.sufficient_for_envelope

  // F-025 — guard the held draft against EVERY exit vector, not just the gate's
  // own links (F-024 already opens those in new tabs). The persistent site
  // header is a SEPARATE component the gate can't reach, and browser Back /
  // typed URL / tab close bypass links entirely. This app uses BrowserRouter
  // (not a data router), so useBlocker is unavailable — instead we guard
  // NAVIGATION router-agnostically:
  //   (1) a CAPTURE-phase click on any anchor leaving this page — a soft SPA
  //       <Link> OR a hard static-page link — is confirmed; decline cancels
  //       both the client-side and the hard navigation (preventDefault +
  //       stopPropagation, before React's own handler runs);
  //   (2) beforeunload catches the non-anchor exits (browser Back, typed URL,
  //       refresh, tab close).
  // A successful send flips allowNavRef so its own result navigation is never
  // guarded; an accepted hard-nav click marks the unload approved so
  // beforeunload does not double-prompt.
  const allowNavRef = useRef(false)
  const draftDirty = hasUnsentDraft({ gatePhase, file, docName, signers })
  /**
   * F-40/F-41.6 — a draft that is COMMITTED to the service has nothing unsaved
   * about it: leaving is safe by construction, which is the entire premise of
   * the pending send. Warning anyway is a lie, and a lie in a scary modal
   * teaches people to fear a safe action (Barry, human pass 2026-07-26: the
   * warning fired when leaving for Google AND on browser Back from the gate).
   *
   * So the guard arms only for work that would REALLY be lost:
   *   - no committed handle → arm (a local-only draft; the original F-025 case);
   *   - committed + edited since → arm (the edits are not on the service yet);
   *   - committed + unedited → do not arm.
   */
  const committedAndClean =
    draftHandle !== null &&
    JSON.stringify(committedSnapshot) ===
      JSON.stringify(currentSnapshot({ docName, signers, autoClose }))
  const guardArmed = draftDirty && !committedAndClean
  useEffect(() => {
    if (!guardArmed) return
    const approvedUnload = { current: false }
    const onClickCapture = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a) return
      const href = a.getAttribute('href') ?? ''
      if (a.target === '_blank' || href === '' || href.startsWith('#') || href.startsWith('mailto:')) return
      if (allowNavRef.current) return
      if (window.confirm(DRAFT_LEAVE_WARNING)) {
        approvedUnload.current = true // a hard-nav anchor unloads next — don't double-prompt
      } else {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (allowNavRef.current || approvedUnload.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    document.addEventListener('click', onClickCapture, true)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      document.removeEventListener('click', onClickCapture, true)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [guardArmed])

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
  // F-44.1 (AC-261) — the cover-page disclosure's expand state: per page load
  // only, collapsed default for guest and signed-in alike, never persisted.
  // The expand FACT rides the once-rail exactly like draft_started (DD-52).
  const [coverDetailsOpen, setCoverDetailsOpen] = useState(false)
  const toggleCoverDetails = () => {
    const next = !coverDetailsOpen
    if (next) telemetryEventOnce('cover_details_expanded')
    setCoverDetailsOpen(next)
  }

  // F-44.2 (AC-262) — the researcher's path: load the demo waiver from OUR
  // origin into the SAME state a hand-picked file enters (a native file input
  // cannot be programmatically filled; React state is the truth the form
  // reads). The signer fields stay untouched on purpose: sending it to
  // yourself is the aha the microcopy sells. A failed fetch shows the
  // standard inline error and leaves the button live for a retry.
  // F-44.3 (AC-263, DD-68) — ONE pick path for the picker's onChange and the
  // drop zone, so re-pick refresh, name prefill, and the oversize guard can
  // never drift between the two ways in. (The sample keeps its own explicit
  // display name, F-44.2.)
  const acceptPickedFile = (f: File) => {
    markDraftStarted() // F-39.5 — the fact of the pick, never the file
    setFile(f)
    // Always reflect the chosen file in the display name, overwriting a
    // prior value — so re-picking a file refreshes the name. The user can
    // still tweak it afterward (Barry QA).
    setDocName(f.name.replace(/\.pdf$/i, ''))
    // Instant feedback: flag an oversize PDF the moment it's picked.
    if (isPdfTooLarge(f.size)) { setError(pdfTooLargeMessage(f.size)); setFirstError('file') }
    else if (firstError === 'file') { setFirstError(null); setError('') }
  }
  // F-44 (AC-265) — autofocusing the first signer SCROLLS a phone past the
  // Document card on load (the 76.7 probe measured scrollY 647 at 390×844):
  // the visitor lands mid-form and never meets the upload zone or the sample
  // button. Keep the desktop nicety (Barry QA), never the mobile scroll:
  // focus only where the form has a chance to fit, decided once at mount.
  const [autoFocusFirstSigner] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(min-width: 768px)').matches,
  )
  const [dragActive, setDragActive] = useState(false)
  const handlePdfDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(false)
    const f = e.dataTransfer?.files?.[0]
    if (!f) return
    // The picker's accept=".pdf" cannot filter a DROP — check here, with the
    // same standard copy the empty-Send validation uses.
    if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) {
      setError('Please upload a PDF')
      setFirstError('file')
      scrollToTop()
      return
    }
    acceptPickedFile(f)
  }

  const [sampleLoading, setSampleLoading] = useState(false)
  const loadSampleDocument = async () => {
    telemetryEventOnce('sample_doc_clicked')
    setSampleLoading(true)
    try {
      const res = await fetch('/samples/acme-anvil-waiver.pdf')
      if (!res.ok) throw new Error(`sample fetch ${res.status}`)
      const blob = await res.blob()
      const f = new File([blob], 'acme-anvil-waiver.pdf', { type: 'application/pdf' })
      markDraftStarted() // F-39.5 — a sample draft is a started draft
      setFile(f)
      setDocName('ACME Anvil Liability Waiver')
      setError('')
      if (firstError === 'file') setFirstError(null)
    } catch {
      setError(SAMPLE_LOAD_FAILED)
      scrollToTop()
    } finally {
      setSampleLoading(false)
    }
  }
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

  /** F-40 — pull a stored draft back into the editor's own fields. */
  const applyRestored = (d: PendingSendView) => {
    // What the SERVICE currently holds. The nav guard compares against this to
    // tell "nothing to lose" from "unsaved edits" (see committedAndClean).
    setCommittedSnapshot(restoredSnapshot(d))
    setDocName(d.document_name)
    setRestoredFile({ name: `${d.document_name}.pdf`, size: d.byte_count })
    setRestoredEmail(d.email)
    setAutoClose(d.auto_close)
    setSigners(
      d.signers.length > 0
        ? d.signers.map((s) => ({
            email: s.email,
            name: s.name,
            onBehalf: !!s.on_behalf_of,
            onBehalfOf: s.on_behalf_of ?? '',
          }))
        : [emptySigner()],
    )
  }

  // F-40.3 (AC-240) — this tab landed from the sign-in email with a draft handle.
  // F-41.6 (AC-252) — OR the visitor abandoned the Google ceremony (browser Back
  // at Google's screen), which re-mounts this editor with NO `?draft` and an
  // empty form; the sessionStorage stash still holds the ceremony's handle, so
  // it is the restore target instead.
  //
  // Both cases restore IN PLACE. An earlier cut re-entered the ceremony case by
  // router-navigating to `?draft=…`, which does not work and shipped broken:
  // `handover` is read ONCE at mount, and a same-route navigate never remounts,
  // so this effect's dependency never changed and the visitor got a blank editor
  // (Barry, human pass 2026-07-26). Restoring in place also keeps the handle out
  // of the URL entirely on this path, which is strictly better for F-40.6.
  useEffect(() => {
    if (!restoreHandle || restoreFiredRef.current) return
    restoreFiredRef.current = true
    // Consume the stash the moment it becomes the restore target: single-use,
    // exactly like the handle the emailed link carries.
    if (!handover.draftId) takeGoogleDraftStash()
    let cancelled = false
    void (async () => {
      try {
        const d = await apiGet<PendingSendView>(`/v1/pending-send/${restoreHandle}`)
        if (cancelled) return
        applyRestored(d)
        // An abandoned ceremony leaves no error behind, so say plainly why the
        // document is on screen — a silent re-fill reads as a glitch. Names no
        // status code and no vendor (AC-252).
        if (!handover.draftId && !d.claimed) setRestoreNotice(CEREMONY_ABANDONED_NOTICE)
        // Someone else already sent it — say so instead of offering to send it again.
        if (d.claimed && d.envelope_id) setSentElsewhere(d.envelope_id)
      } catch (e) {
        if (cancelled) return
        // A draft we cannot fetch is one we cannot restore: say which, plainly.
        setRestoreNotice(friendlyRestoreError(e))
        setDraftHandle(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [restoreHandle, handover.draftId])

  // F-40.2 (AC-239) — the tab that landed FINISHES the job: claim the draft and
  // send it, then land on that envelope. Exactly once, guarded by a ref so no
  // re-render can produce a second envelope or a second charge.
  useEffect(() => {
    if (!handover.claim || !handover.draftId || !user || claimFiredRef.current) return
    claimFiredRef.current = true
    setGatePhase('sending')
    void (async () => {
      try {
        const result = await apiPost<{ envelope_id: string; already_sent?: boolean }>(
          `/v1/pending-send/${handover.draftId}/claim`,
          {},
        )
        allowNavRef.current = true
        navigate(`/dashboard/envelope/${result.envelope_id}`, { state: { justSent: true } })
      } catch (e) {
        // A refusal (no credit, allowlist, a create-time rule) is retryable after
        // the creator fixes it — the server released the claim, so the restored
        // form below is a live draft, not a corpse (F-39.4 through the handover).
        setError(friendlyCreateError(e instanceof ApiError ? e.status : undefined, e instanceof Error ? e.message : undefined))
        setGatePhase('form')
        scrollToTop()
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handover.claim, handover.draftId, user])

  // F-40.2 (AC-239) — the composing tab gets an ENDING. Before F-40 a tab whose
  // link was opened in a separate storage context (Gmail iOS, Outlook) waited on
  // a session cookie it would never see, forever. Now it watches its own draft:
  // once another browser claims it, this tab says the document was sent.
  useEffect(() => {
    if (gatePhase !== 'gate' || !draftHandle || sentElsewhere) return
    const id = setInterval(() => {
      void apiGet<PendingSendView>(`/v1/pending-send/${draftHandle}`)
        .then((d) => {
          if (d.claimed && d.envelope_id) setSentElsewhere(d.envelope_id)
        })
        .catch(() => {
          /* a transient read failure just means we look again next tick */
        })
    }, 3000)
    return () => clearInterval(id)
  }, [gatePhase, draftHandle, sentElsewhere])


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
      allowNavRef.current = true // F-025 — the send's own result navigation must never be guarded
      navigate(`/dashboard/envelope/${result.envelope_id}`, {
        state: { justSent: true, ...(deliveryProblems.length ? { deliveryProblems } : {}) },
      })
    } catch (e) {
      const status = e instanceof ApiError ? e.status : undefined
      // 2026-07-25 — a 401 is not an error to READ, it is a sign-in to DO. The
      // session can die between page load and Send, and the hydration window
      // makes the SPA guess signed-in optimistically. Either way the answer is
      // the SAME gate the guest flow uses: hold the draft, offer sign-in, and
      // let the held send fire by itself. Correct the SPA's stale belief FIRST
      // (refresh re-reads /v1/auth/user) so the gate renders its form instead of
      // instantly re-firing onSignedIn against a session that is already gone.
      if (status === 401 && !authRetryRef.current) {
        authRetryRef.current = true
        // Never let the belief-correction itself break the recovery: a refresh
        // that throws (or a provider that returns no promise) still lands the
        // creator on a gate that can sign them back in.
        try { await refreshAuth() } catch { /* stale belief stays; the gate still works */ }
        heldPayloadRef.current = payload
        gateSentOnceRef.current = false
        setError('')
        setFirstError(null)
        setGateNotice(SESSION_EXPIRED)
        setGatePhase('gate')
        scrollToTop()
        return
      }
      // Don't leak an opaque server fault (run402's "Internal function error") —
      // show a calm fallback for 5xx/opaque, keep helpful 4xx validation messages
      // (2026-06-21). scroll-to-top so the banner is seen. A held-send failure
      // (e.g. the F-39.4 insufficient-credit outcome) returns to the FORM with
      // the draft intact — never a dead end.
      setError(friendlyCreateError(status, e instanceof Error ? e.message : undefined))
      setFirstError(null)
      setGateNotice('')
      setGatePhase('form')
      scrollToTop()
    } finally {
      setSubmitting(false)
    }
  }

  /**
   * Build the create body from the draft (shared by preflight + dispatch).
   *
   * F-029 — this reads the LOCAL file, so it is only ever valid for a draft
   * composed in this browser. A restored draft has no local file (its document
   * lives on the service) and must never reach here; the guard is explicit
   * rather than a `file!` assertion, because the assertion is exactly what let
   * a raw FileReader crash reach a visitor's screen.
   */
  const buildPayload = async (): Promise<Record<string, unknown>> => {
    if (!file) throw new Error('buildPayload called without a locally selected document')
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
    // A fresh Send press is a fresh attempt: the one-shot 401 recovery re-arms.
    authRetryRef.current = false
    setGateNotice('')
    // A RESTORED draft already has its document on the service, so "no file
    // picked" is not a defect there — the picker is deliberately absent.
    if (!file && !isRestored) { setError('Please upload a PDF'); setFirstError('file'); scrollToTop(); return }
    // Reject oversize PDFs here, with a clear message — otherwise the base64 upload
    // inflates past the 6 MiB Lambda invoke cap and the gateway returns an opaque 502.
    if (file && isPdfTooLarge(file.size)) { setError(pdfTooLargeMessage(file.size)); setFirstError('file'); scrollToTop(); return }
    if (!docName.trim()) { setError('Please enter a document name'); setFirstError('docName'); scrollToTop(); return }
    if (signers.some((s) => !s.email || !s.name)) { setError('All signers need name and email'); setFirstError('signers'); scrollToTop(); return }
    setFirstError(null)

    // F-029 (red team cycle 23) — a RESTORED draft is neither of the two cases
    // below, and it must be handled BEFORE them. Its document lives on the
    // service and was never picked in this browser, so every path that reads the
    // local `file` is wrong here: the guest branch used to run anyway and crash
    // in FileReader with a raw "parameter 1 is not of type 'Blob'" on the page,
    // submitting nothing. F-40.4's own principle is that a form the visitor
    // cannot act on is a lie, and this was the most prominent button on it.
    //
    // Signed in → claim and send. Not signed in (the usual case here, since this
    // view exists BECAUSE sign-in failed) → save the edit and ask for a fresh
    // link, which is what the visitor came back to do.
    if (isRestored && draftHandle) {
      setSubmitting(true)
      try {
        await saveRestoredEdits()
        if (user) await claimRestored()
        else setGatePhase('gate')
      } catch (e) {
        setError(friendlyCreateError(e instanceof ApiError ? e.status : undefined, e instanceof Error ? e.message : undefined))
        scrollToTop()
      } finally {
        setSubmitting(false)
      }
      return
    }

    if (!isGuest) {
      // Signed-in Send: unchanged — immediate dispatch, no gate, and no pending
      // send is ever written for it (AC-236).
      const payload = await buildPayload()
      await dispatchEnvelope(payload)
      return
    }

    // Guest Send (F-39.3 + F-40.1): validate FIRST — the free public preflight
    // runs the same server-side rejections a signed-in create would hit (F-3.2a
    // address rules, size guards), so nobody signs in just to learn the form is
    // invalid. Only a draft that passes is stored, and only a stored draft opens
    // the gate: the store is what lets the tab the visitor LANDS in finish the
    // send, so a gate without one would be the old dead end again.
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

  /**
   * F-40.1 — store the held draft, at the moment the visitor's address is known
   * and BEFORE the sign-in email goes out. The binding is the draft's whole
   * security model (only a session for this address may claim it), so it cannot
   * be written earlier than the address. Throwing here means no link is sent and
   * the gate stays put: fail closed, never a gate holding nothing.
   */
  const storeDraftForLink = async (email: string): Promise<string> => {
    if (draftHandle) return draftHandle // a restored draft is already stored
    const payload = heldPayloadRef.current ?? (await buildPayload())
    const { draft_id } = await apiPost<{ draft_id: string }>('/v1/pending-send', { email, ...payload })
    setDraftHandle(draft_id)
    setCommittedSnapshot(currentSnapshot({ docName, signers, autoClose }))
    return draft_id
  }

  /**
   * F-41.6 — the Google path stores the SAME draft with no address: the
   * ceremony's claim binds the establishing session's address (DD-59). Stored
   * immediately before the ceremony starts, same fail-closed rule as the email
   * path: a storage failure starts no ceremony and keeps the filled-in form.
   */
  const storeDraftForCeremony = async (): Promise<string> => {
    // The ceremony LEAVES this page (a same-tab redirect to Google), so the
    // nav guard must yield to it exactly as it yields to the send's own result
    // navigation (F-025's allowNavRef). Otherwise the browser raises "Leave
    // site? Changes that you made may not be saved." on the happy path — both
    // alarming and FALSE, since the draft is committed to the service on the
    // very next line, which is the whole point of F-40/F-41.6. Flipped only
    // AFTER a successful store: if the store throws we stay here with a real
    // unsaved draft, and the guard must still protect it.
    if (draftHandle) {
      allowNavRef.current = true
      return draftHandle // a restored draft is already stored
    }
    const payload = heldPayloadRef.current ?? (await buildPayload())
    const { draft_id } = await apiPost<{ draft_id: string }>('/v1/pending-send', { ceremony: true, ...payload })
    setDraftHandle(draft_id)
    setCommittedSnapshot(currentSnapshot({ docName, signers, autoClose }))
    allowNavRef.current = true
    return draft_id
  }

  /** F-40.4 — save a restored draft's edits before anything acts on it. */
  const saveRestoredEdits = async (): Promise<void> => {
    if (!draftHandle || !isRestored) return
    await apiPatch(`/v1/pending-send/${draftHandle}`, {
      document_name: docName,
      signers: signers.map((s) => ({
        email: s.email,
        name: s.name,
        on_behalf_of: s.onBehalf && s.onBehalfOf.trim() ? s.onBehalfOf.trim() : undefined,
      })),
      auto_close: autoClose,
    })
    setCommittedSnapshot(currentSnapshot({ docName, signers, autoClose }))
  }

  /** Claim + send a restored draft (the signed-in path onto an existing draft). */
  const claimRestored = async (): Promise<void> => {
    if (!draftHandle) return
    setGatePhase('sending')
    try {
      const result = await apiPost<{ envelope_id: string }>(`/v1/pending-send/${draftHandle}/claim`, {})
      allowNavRef.current = true
      navigate(`/dashboard/envelope/${result.envelope_id}`, { state: { justSent: true } })
    } catch (e) {
      setError(friendlyCreateError(e instanceof ApiError ? e.status : undefined, e instanceof Error ? e.message : undefined))
      setGatePhase('form')
      scrollToTop()
    }
  }

  /** F-40.3 — the restored form's "send me a fresh link", edits saved first. */
  const resendFromRestore = async () => {
    setError('')
    try {
      await saveRestoredEdits()
      setGatePhase('gate')
    } catch (e) {
      setError(friendlyCreateError(e instanceof ApiError ? e.status : undefined, e instanceof Error ? e.message : undefined))
      scrollToTop()
    }
  }

  // F16.10 suggestion-prompt render branch removed in v0.18.x — see note in
  // handleSubmit. Future fix will reinstate with correct filter logic and
  // a sensible message template.

  // F-39.3 — the gate view: the draft is HELD (state + heldPayloadRef live on;
  // the form is merely unmounted) while the one SignInScreen runs in-flow. The
  // back link abandons nothing — it just re-renders the form.
  // F-40.2 (AC-239) + F-030-obs (red team cycle 23) — the document IS sent, so
  // say that, whichever view this tab happens to be in. It used to render only
  // while waiting at the gate, so a visitor who opened an already-used link fell
  // through to the generic restore form and saw EMPTY fields: the claim scrubs
  // the draft to a receipt (F-028), leaving nothing to prefill. Empty boxes for a
  // document that was successfully sent is the worst of both readings.
  if (sentElsewhere) {
      return (
        <div className="max-w-2xl mx-auto px-4 py-8 text-center" data-testid="gate-sent-elsewhere">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-green-50 mb-5">
            <svg className="w-7 h-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold mb-3">Your document was sent</h1>
          <p className="text-gray-600 mb-6">
            You finished signing in somewhere else, and your document went out from there.
          </p>
          <Link
            to={`/dashboard/envelope/${sentElsewhere}`}
            onClick={() => { allowNavRef.current = true }}
            className="inline-flex items-center justify-center min-h-[44px] px-6 py-3 bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-700"
          >
            Track who has signed
        </Link>
      </div>
    )
  }

  if (gatePhase === 'gate') {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8">
        <button
          type="button"
          data-testid="gate-back"
          onClick={() => { setGateNotice(''); setGatePhase('form') }}
          className="inline-flex items-center gap-1 min-h-[44px] text-sm text-gray-500 hover:text-gray-900 mb-3 cursor-pointer"
        >
          <span aria-hidden>←</span> Back to your document
        </button>
        {/* Why this gate is showing, when it isn't the ordinary guest one: the
            401 recovery. A notice, not an error, so it reads as the next step. */}
        {gateNotice && (
          <p
            data-testid="gate-notice"
            className="text-sm text-gray-700 bg-amber-50 border border-amber-100 rounded-lg px-4 py-3 mb-4"
          >
            {gateNotice}
          </p>
        )}
        <SignInScreen
          title="Sign in to send your document"
          telemetryTrigger="send"
          onSignedIn={handleGateSignedIn}
          prepareDraft={storeDraftForLink}
          prepareCeremonyDraft={storeDraftForCeremony}
          {...(draftHandle ? { draftId: draftHandle } : {})}
          {...(restoredEmail ? { initialEmail: restoredEmail } : {})}
        />
      </div>
    )
  }

  // The held send is dispatching (a session just appeared) — F-39.3.
  if (gatePhase === 'sending') {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8 text-center" data-testid="gate-sending">
        <div className="animate-spin h-6 w-6 border-4 border-gray-300 border-t-gray-900 rounded-full mx-auto mt-16" />
        <p className="text-sm text-gray-500 mt-4">Sending your document…</p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <Link
        to={isGuest ? '/' : '/dashboard'}
        className="inline-flex items-center gap-1 min-h-[44px] text-sm text-gray-500 hover:text-gray-900 mb-3"
      >
        <span aria-hidden>←</span> {isGuest ? 'Back to Home' : 'Back to Dashboard'}
      </Link>
      <h1 className="text-2xl font-semibold mb-6">Send a document for signing</h1>
      {/* F-39.1 — the cost question answered before the gate ever appears: the
          F-39.7 v2 trial line (document vocabulary, F-2.2), guest-only (a
          signed-in creator has the credit pill). */}
      {isGuest && !isRestored && !restoreNotice && (
        <p className="text-sm text-gray-600 -mt-4 mb-6" data-testid="guest-trial-line">
          Your first 4 documents are free. No credit card needed.
        </p>
      )}

      {/* F-40.3 (AC-240) — the landing tab's failure surface. Not an error page:
          the visitor's own document is right below this, and the next step is
          one button. No status code, no vendor, no transport detail. */}
      {restoreNotice && (
        <div
          data-testid="restore-notice"
          className="mb-6 text-sm text-gray-800 bg-amber-50 border border-amber-100 rounded-xl px-4 py-4"
        >
          <p>{restoreNotice}</p>
          {isRestored && (
            <button
              type="button"
              data-testid="restore-resend"
              onClick={() => void resendFromRestore()}
              className="mt-3 inline-flex items-center justify-center min-h-[44px] px-5 py-2.5 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-700 cursor-pointer"
            >
              Send me a fresh link
            </button>
          )}
        </div>
      )}

      {/* The replacing credit card serves its ORIGINAL purpose only — stopping
          someone from FILLING a form they can't send (Barry QA 2026-06-16). A
          draft that already exists must never be swallowed by it (F-39.4 /
          AC-226): with a file picked, the form stays and the inline top-up
          strip below carries the referral instead. */}
      {/* A RESTORED draft is a draft that already exists, so the replacing card
          must never swallow it either — its document lives on the service rather
          than in `file`, and reading `!file` alone hid the visitor's own document
          behind the top-up card (found by the live handover probe, 2026-07-25). */}
      {insufficientCredit && !file && !isRestored ? (
        <div className="bg-white border border-gray-200 rounded-xl p-8 text-center space-y-4">
          <div
            className="mx-auto w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center text-amber-600 text-2xl font-semibold"
            aria-hidden
          >
            $
          </div>
          <h2 className="text-lg font-semibold">Add credits to send your document</h2>
          <p className="text-sm text-gray-600 max-w-md mx-auto">
            Sending a document for signing costs a flat{' '}
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
          <p className="text-xs text-gray-500">
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
        {insufficientCredit && (file || isRestored) && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900" data-testid="topup-inline">
            <p className="font-medium mb-2">
              Add credits to send. Your document is saved in this tab: top up, then press Send again.
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

        {/* Document */}
        <div
          className={`bg-white border rounded-xl p-6 space-y-4 ${firstError === 'file' || firstError === 'docName' ? 'border-red-300 ring-1 ring-red-300' : 'border-gray-200'}`}
        >
          <h2 className="text-sm font-medium">Document</h2>
          {isRestored ? (
            /* F-40.4 (AC-241) — the file is IMMUTABLE for the life of a pending
               send: it is content-addressed and already stored, so there is no
               picker here at all. Swapping the document means starting a new
               draft. Everything else on this form stays editable. */
            <div data-testid="restored-draft-file">
              <span className="block text-sm text-gray-600 mb-1">PDF file</span>
              <div className="flex items-center gap-3 min-h-[44px] border border-gray-200 bg-gray-50 rounded-lg px-3 py-2">
                <span className="text-sm text-gray-900 font-medium truncate">{restoredFile!.name}</span>
                <span className="text-xs text-gray-500 shrink-0">
                  {(restoredFile!.size / 1024).toFixed(0)} KB
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Your document is saved and ready. To use a different one, start a new document.
              </p>
            </div>
          ) : (
          <div>
            {/* F-023 (AC-231) — the label is BOUND so the file input has an
                accessible name (it was the sweep's unlabeled-control finding). */}
            <label htmlFor="pdf-file-input" className="block text-sm text-gray-600 mb-1">PDF file</label>
            {/* F-44.3 (AC-263, DD-68) — the drop zone: the SAME native input,
                stretched transparent over the whole zone. Every click/tap/
                keyboard activation IS the native browse (no proxy click), so
                the F-026 44px tap surface stays literally true and the AC-231
                label binding is untouched. Drag events ride the wrapper and
                feed the exact pick path the picker uses; focus-within draws
                the keyboard ring the invisible input cannot. */}
            <div
              data-testid="pdf-drop-zone"
              onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handlePdfDrop}
              className={`relative rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors focus-within:ring-2 focus-within:ring-gray-900 ${
                dragActive ? 'border-gray-900 bg-gray-50' : firstError === 'file' ? 'border-red-400' : 'border-gray-300 hover:border-gray-500'
              }`}
            >
              <input
                id="pdf-file-input"
                type="file" accept=".pdf"
                // Clear the value before the picker opens so re-selecting the SAME
                // file still counts as a change — otherwise the browser fires no
                // onChange on an identical re-pick and the name never refreshes
                // (Barry QA). State keeps the File, so the picker just re-derives.
                onClick={(e) => { e.currentTarget.value = '' }}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null
                  if (f) acceptPickedFile(f)
                  else setFile(null)
                }}
                className="absolute inset-0 h-full w-full min-h-[44px] cursor-pointer opacity-0"
              />
              {file ? (
                <div data-testid="chosen-file-display">
                  <div className="flex items-center justify-center gap-3">
                    <span className="text-sm text-gray-900 font-medium truncate">{file.name}</span>
                    <span className="text-xs text-gray-500 shrink-0">{(file.size / 1024).toFixed(0)} KB</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">Drop another PDF here, or click to replace it.</p>
                </div>
              ) : (
                <div>
                  <p className="text-sm font-medium text-gray-700">Drag and drop your PDF here</p>
                  <p className="text-xs text-gray-500 mt-1">or click to browse</p>
                </div>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-1">Max 3 MB per PDF.</p>
            {/* F-44.3 — the retention trust line: exactly the F-9.3 claim
                (deleted shortly after delivery to all parties), never more. */}
            <p className="text-xs text-gray-500 mt-0.5" data-testid="retention-trust-line">
              Your PDF is deleted from our servers shortly after everyone receives the signed record. Your inbox keeps the proof.
            </p>
            {/* F-44.2 (AC-262) — the researcher's path, directly under the
                picker: guest and signed-in alike. Lives with the picker, so a
                restored draft (no picker, F-40.4) never shows it. */}
            <div className="mt-3">
              {/* 76.9 (Barry 2026-07-29) — emphasized: green frame + bold label
                  so the researcher's path stands out against the zone above. */}
              <button
                type="button"
                data-testid="sample-doc-btn"
                onClick={() => void loadSampleDocument()}
                disabled={sampleLoading}
                className="inline-flex items-center min-h-[44px] px-4 py-2 border-2 border-green-600 rounded-lg text-sm font-bold text-gray-900 hover:bg-green-50 disabled:opacity-40 cursor-pointer"
              >
                {sampleLoading ? 'Loading the sample…' : 'Try it with a sample document'}
              </button>
              <p className="text-xs text-gray-500 mt-1">
                No PDF handy? Use our demo waiver and send it to yourself to see exactly what your signers get.
              </p>
            </div>
          </div>
          )}
          <div>
            <label className="block text-sm text-gray-600 mb-1">Display name</label>
            <input
              type="text" value={docName}
              onChange={(e) => { setDocName(e.target.value); if (firstError === 'docName') setFirstError(null) }}
              className={`w-full min-h-[44px] border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 ${firstError === 'docName' ? 'border-red-400 ring-1 ring-red-400' : 'border-gray-300'}`}
              placeholder="e.g., NDA for Acme Corp"
            />
            <p className="text-xs text-gray-500 mt-1">
              Shown to signers in the email subject and signing page. Auto-filled from the filename, edit if you want something nicer.
            </p>
          </div>
        </div>

        {/* F-44.1 (AC-261) — the cover-page disclosure, demoted from the
            always-open box that used to stand ABOVE the picker. One calm line;
            every fact stays reachable pre-send via the inline expand. Document
            vocabulary only (AC-234) — the moved content may not say "envelope". */}
        <div className="text-sm text-gray-600" data-testid="cover-disclosure">
          <p>
            We add a one-page cover with the signer&rsquo;s legal consent record.{' '}
            <button
              type="button"
              data-testid="cover-disclosure-toggle"
              aria-expanded={coverDetailsOpen}
              aria-controls="cover-disclosure-details"
              onClick={toggleCoverDetails}
              className="inline-flex items-center min-h-[44px] text-gray-900 underline hover:text-gray-600 cursor-pointer"
            >
              {coverDetailsOpen ? 'Hide details' : 'What’s on it →'}
            </button>
          </p>
          {coverDetailsOpen && (
            <div id="cover-disclosure-details" className="mt-2 bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-900">
              <p className="text-xs text-blue-800 mb-1">
                Every document you send ships with a kysigned-generated cover page (page 1) before your content. The cover carries:
              </p>
              <ul className="text-xs text-blue-800 list-disc ml-5 space-y-0.5">
                <li>The document name, your email (shown to signers as &ldquo;Sender&rdquo;), the document&rsquo;s technical reference ID, and timestamp</li>
                <li>The signer&rsquo;s consent to sign electronically instead of with a wet-ink signature, and to be legally bound, satisfying US (ESIGN, UETA) and EU (eIDAS) e-signature law in a single reply (<a href="/how-it-works" target="_blank" rel="noopener noreferrer" className="text-blue-900 underline">how this works &rarr;</a>)</li>
                <li>Instructions so the signer can independently verify the document hash before replying</li>
              </ul>
              <p className="text-xs text-blue-700 mt-2">
                Keep your original PDF: you can re-check it later from the document&rsquo;s detail page to confirm we didn&rsquo;t tamper with your upload.
              </p>
            </div>
          )}
        </div>

        {/* Signers */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Signers</h2>
            <button type="button" onClick={addSigner} className="inline-flex items-center min-h-[44px] text-sm text-blue-600 hover:underline">
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
                <span className="text-xs text-gray-500">Signer {i + 1}{isCreatorRow(s) ? ' (you)' : ''}</span>
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
                    autoFocus={i === 0 && autoFocusFirstSigner} placeholder="e.g., Jane Smith" value={s.name}
                    onChange={(e) => { patchSigner(i, { name: e.target.value }); if (firstError === 'signers') setFirstError(null) }}
                    className={`w-full min-h-[44px] border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 ${firstError === 'signers' && !s.name ? 'border-red-400 ring-1 ring-red-400' : 'border-gray-300'}`}
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
                    className={`w-full min-h-[44px] border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900${isCreatorRow(s) ? ' bg-gray-50 text-gray-500 cursor-not-allowed' : ''} ${firstError === 'signers' && !s.email ? 'border-red-400 ring-1 ring-red-400' : 'border-gray-300'}`}
                  />
                </div>
              </div>
              <p className="text-xs text-gray-500">
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
                    className="w-full min-h-[44px] border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                  />
                  <p className="text-xs text-gray-500 mt-1">
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
              <span className="block text-xs text-gray-500 mt-0.5">
                On by default. Turn this off to review the signers and seal the document yourself
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
