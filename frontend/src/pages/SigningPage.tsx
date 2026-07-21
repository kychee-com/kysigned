/**
 * Review Page — the signer's view of a document pending their signature.
 *
 * This page is READ-ONLY. Signing happens by email (the signer forwards the
 * signing-request email back with the document attached and `I SIGN THIS
 * DOCUMENT` as the first line). The page shows the document and the
 * forward-to-sign instructions.
 *
 * Routes: `/review/:envelopeId/:token` (the primary email-link target) and
 * `/sign/:envelopeId/:token` (an alias). The `GET /v1/sign/:envelopeId/:token/info`
 * API call below targets the apiRouter — a separate concern from the SPA route.
 *
 * NOTE (evidence-bundle pivot): the client-side pre-sign hash check was removed
 * per F-5.4 — byte-checking is the machines' job (the server's return-what-we-sent
 * check, F-6.4), never shown to the signer. The Sign block instructs the signer to
 * FORWARD the signing-request email (keeping the attached PDF) and type "I sign this
 * document" as the first line — their provider's DKIM signature on that forward IS
 * the signature. The dropped Mode-2 mailto/"I SIGN"/compose-a-new-email path is gone.
 */
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { apiGet, type SigningInfo } from '../lib/api'

type Step = 'loading' | 'review' | 'already-signed' | 'expired' | 'pdf-deleted' | 'error'
type PreviewState = 'loading' | 'ready' | 'error'

// Lazy pdf.js loader. pdf.js is ~1 MB, so it is dynamic-imported (a) to keep it out of
// the main SPA chunk and (b) so it loads only on the review page. The worker is pinned
// via Vite's `?url` asset import, which resolves to the hashed worker file Vite emits at
// build time (the correct way to pin a pdf.js worker under Vite — no CDN, no bare path).
// Memoized so repeated review views reuse the one module + worker registration.
let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null
function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist')
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
      return pdfjs
    })()
  }
  return pdfjsPromise
}

// One stable page shell used by EVERY state (loading + each terminal state), so the
// loading→loaded transition never morphs the root element's box — a CLS source the
// design sweep flagged on /review (task 40.5 / AC-12). Per-state differences live
// INSIDE the shell (an inner max-w wrapper), never on this outer element.
const PAGE_SHELL = 'max-w-3xl mx-auto px-4 py-8 md:py-12 min-h-screen'

export function SigningPage() {
  const { envelopeId, token } = useParams<{ envelopeId: string; token: string }>()
  const [step, setStep] = useState<Step>('loading')
  const [info, setInfo] = useState<SigningInfo | null>(null)
  const [error, setError] = useState('')
  const [previewState, setPreviewState] = useState<PreviewState>('loading')
  const canvasHostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    apiGet<SigningInfo>(`/v1/sign/${envelopeId}/${token}/info`)
      .then((data) => {
        setInfo(data)
        if (data.already_signed) setStep('already-signed')
        else if (data.status === 'expired') setStep('expired')
        else if (data.pdf_deleted_at) setStep('pdf-deleted')
        else setStep('review')
      })
      .catch((e) => { setError(e.message); setStep('error') })
  }, [envelopeId, token])

  // Desktop inline preview: rasterize the document to a <canvas> via pdf.js.
  //
  // Why not a framed PDF? The run402 gateway injects `Content-Security-Policy:
  // frame-ancestors 'none'` (plus `X-Frame-Options: DENY`) on EVERY project-site
  // response — a deliberate platform-wide clickjacking guard we cannot relax from our
  // side (meta CSP can't set/relax frame-ancestors; it governs <iframe>/<object>/
  // <embed> alike). A `blob:` URL INHERITS the CSP of the page that created it, so a
  // fetched-blob <iframe> still carries `frame-ancestors 'none'` and the browser
  // refuses to embed it (WebKit: "Refused to load blob:… frame-ancestors"; Chromium:
  // net::ERR_ABORTED) — that was UX-013. A <canvas> raster creates no nested browsing
  // context, so frame-ancestors never applies. The token-authed fetch path is the same
  // one that already worked; only the render surface changed. On any failure we fall
  // back to the Open-full-screen / Download links (top-level navigations, unaffected).
  useEffect(() => {
    if (step !== 'review') return
    // Desktop-only: phones use the full-screen CTA below, so don't spend a phone's
    // battery rasterizing a preview it never shows. jsdom (tests) has no matchMedia →
    // default to rendering so the canvas path stays covered.
    const desktop =
      typeof window === 'undefined' || typeof window.matchMedia !== 'function'
        ? true
        : window.matchMedia('(min-width: 768px)').matches
    if (!desktop) return

    let cancelled = false
    const renderTasks: Array<{ cancel: () => void }> = []
    setPreviewState('loading')

    void (async () => {
      try {
        const pdfUrl = `${import.meta.env.VITE_API_BASE || ''}/v1/envelope/${envelopeId}/${token}/pdf`
        const res = await fetch(pdfUrl)
        if (!res.ok) throw new Error(`pdf ${res.status}`)
        const bytes = new Uint8Array(await res.arrayBuffer())
        if (cancelled) return
        const pdfjs = await loadPdfjs()
        if (cancelled) return
        // pdfjs 6 removed PDFDocumentProxy.destroy from the public API — cleanup
        // goes through the loading task (also correct in v5).
        const loadingTask = pdfjs.getDocument({ data: bytes })
        const pdf = await loadingTask.promise
        if (cancelled) { void loadingTask.destroy?.(); return }
        const host = canvasHostRef.current
        if (!host) { void loadingTask.destroy?.(); return }
        host.replaceChildren() // clear any prior / StrictMode double-invoked render
        const cssWidth = host.clientWidth || 720
        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          if (cancelled) break
          const page = await pdf.getPage(pageNum)
          const base = page.getViewport({ scale: 1 })
          const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr })
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.floor(viewport.width))
          canvas.height = Math.max(1, Math.floor(viewport.height))
          canvas.style.width = '100%'
          canvas.style.height = 'auto'
          canvas.className = 'block mx-auto mb-3 max-w-full shadow-sm'
          host.appendChild(canvas)
          const task = page.render({ canvas, viewport })
          renderTasks.push(task)
          await task.promise
        }
        if (!cancelled) setPreviewState('ready')
      } catch {
        // pdf.js unavailable / render failed / fetch failed → show the fallback message
        // and the Open-full-screen / Download links. Never leave a silently blank box.
        if (!cancelled) setPreviewState('error')
      }
    })()

    return () => {
      cancelled = true
      for (const t of renderTasks) {
        try { t.cancel() } catch { /* task already settled */ }
      }
    }
  }, [envelopeId, token, step])

  if (step === 'loading') {
    // Top-aligned inside the SAME shell the loaded review uses, so the spinner→content
    // swap doesn't move the outer box (the CLS the sweep saw on /review).
    return <div className={PAGE_SHELL} data-testid="review-loading">
      <div className="flex items-center gap-3 text-gray-500">
        <div className="animate-spin h-6 w-6 border-4 border-gray-300 border-t-gray-900 rounded-full" />
        <p>Loading document&hellip;</p>
      </div>
    </div>
  }

  if (step === 'error') {
    return <div className={PAGE_SHELL}>
      <div className="max-w-lg mx-auto mt-8 text-center">
        <h1 className="text-xl font-semibold text-red-600 mb-2">Error</h1>
        <p className="text-gray-600">{error}</p>
      </div>
    </div>
  }

  if (step === 'already-signed') {
    return <div className={PAGE_SHELL}>
      <div className="max-w-lg mx-auto mt-8 p-8 bg-white rounded-xl shadow-sm text-center">
        <div className="text-4xl mb-4">&#10003;</div>
        <h1 className="text-xl font-semibold mb-2">Already Signed</h1>
        <p className="text-gray-600">You have already signed this document. No further action is needed.</p>
      </div>
    </div>
  }

  if (step === 'expired') {
    return <div className={PAGE_SHELL}>
      <div className="max-w-lg mx-auto mt-8 p-8 bg-white rounded-xl shadow-sm text-center">
        <h1 className="text-xl font-semibold mb-2">Link Expired</h1>
        <p className="text-gray-600">This signing link has expired. Contact the sender for a new link.</p>
      </div>
    </div>
  }

  if (step === 'pdf-deleted' && info) {
    // F-9.3 ephemeral retention — the document blob was removed from kysigned
    // storage after the envelope reached a terminal state. The durable copy is
    // the evidence bundle in the parties' inboxes ("proof in your inbox", F-9.4).
    const deletedAt = info.pdf_deleted_at ? new Date(info.pdf_deleted_at).toLocaleString() : 'unknown'
    const completedAt = info.completed_at ? new Date(info.completed_at).toLocaleString() : null
    let statusMessage: string
    if (info.status === 'completed') {
      statusMessage = `This envelope was completed${completedAt ? ` on ${completedAt}` : ''}. We deleted the document after delivering the signing record to every party.`
    } else if (info.status === 'voided') {
      statusMessage = `This envelope was voided by the sender. We deleted the document at that point — no further signing is possible.`
    } else if (info.status === 'expired') {
      statusMessage = `This envelope expired without all signatures. We deleted the document — contact the sender to start over.`
    } else {
      statusMessage = `This envelope's document is no longer stored on our servers (status: ${info.status}).`
    }
    return (
      <div className={PAGE_SHELL}>
       <div className="max-w-2xl mx-auto">
        <h1 className="text-xl font-semibold text-gray-900 mb-1">
          {info.document_name}
        </h1>
        <p className="text-sm text-gray-500 mb-6">
          Document removed from our servers: {deletedAt}
        </p>

        <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 mb-5">
          <p className="text-sm text-blue-900 mb-3"><strong>This document is no longer stored here.</strong></p>
          <p className="text-sm text-blue-900">{statusMessage}</p>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
          <h2 className="text-sm font-medium mb-2">What you can still do</h2>
          <ul className="text-sm text-gray-700 space-y-2 list-disc ml-5">
            <li>
              <strong>Find your signing record in your inbox.</strong>{' '}
              The completion email had it attached. We delete our copy after
              delivery, but your inbox copy survives forever. Search for
              &ldquo;{info.document_name}&rdquo; or the envelope ID below.
            </li>
            <li>
              <strong>Verify it yourself.</strong>{' '}
              Drop your signing record (the PDF from your inbox) onto{' '}
              <a href="/verify" className="text-blue-600 hover:underline">
                {(typeof window !== 'undefined' ? window.location.host : 'your-domain.example')}/verify
              </a>
              . The verification works without us being online.
            </li>
          </ul>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
          <h2 className="text-sm font-medium mb-3">Envelope details</h2>
          <dl className="text-xs space-y-2">
            <div>
              <dt className="inline text-gray-500">Status:</dt>{' '}
              <dd className="inline text-gray-700 font-medium">{info.status}</dd>
            </div>
            <div>
              <dt className="inline text-gray-500">Envelope ID:</dt>{' '}
              <dd className="inline font-mono text-gray-700">{info.envelope_id}</dd>
            </div>
            {/* F-5.4: no document hash shown to the signer, here either. */}
          </dl>
        </div>

        <p className="text-xs text-gray-500">
          <strong>Why did you delete it?</strong> kysigned holds documents only as long as
          operationally needed (active envelopes; completion emails not yet delivered).
          After delivery we delete them to minimize breach blast radius. The durable
          record is the signing record in every party's inbox, not anything on our servers.
        </p>
       </div>
      </div>
    )
  }

  return (
    <div className={PAGE_SHELL}>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-gray-900">
          {info?.document_name}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Hi {info?.signer_name}, please review this document.
        </p>
      </div>

      {/* PDF preview block. Three affordances:
          - "Open full screen ↗" — opens the token-authed PDF URL in a new tab, where the
            browser's native viewer takes over (zoom/scroll/search/print). A top-level
            navigation, not framing, so the platform CSP frame-ancestors never applies.
          - "Download PDF ↓" — saves the same authed PDF.
          - Desktop inline preview — the already-fetched bytes rasterized to a <canvas>
            via pdf.js (see the render effect above). Mobile skips the inline render for a
            clear full-screen CTA (the native inline viewer is unreliable on phones, GH#25).
          The links get a ≥44px tap target on mobile (md:min-h-0 keeps desktop compact). */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h2 className="text-base font-medium">Document</h2>
          <div className="flex items-center gap-4 text-sm">
            <a
              href={`${import.meta.env.VITE_API_BASE || ''}/v1/envelope/${envelopeId}/${token}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline flex items-center min-h-[44px] md:min-h-0"
            >
              Open full screen &#8599;
            </a>
            <a
              href={`${import.meta.env.VITE_API_BASE || ''}/v1/envelope/${envelopeId}/${token}/pdf`}
              download
              className="text-blue-600 hover:underline flex items-center min-h-[44px] md:min-h-0"
            >
              Download PDF &#8595;
            </a>
          </div>
        </div>
        {/* Desktop-only inline canvas preview (populated imperatively by the render
            effect). On phones the native viewer is unreliable (iOS traps on the cover;
            Android won't render inline) — GH#25 — so mobile gets the full-screen CTA. */}
        <div className="hidden md:block">
          <div
            ref={canvasHostRef}
            data-testid="pdf-canvas-preview"
            aria-label="Document preview"
            className={
              previewState === 'error'
                ? 'hidden'
                : 'w-full h-[80vh] overflow-y-auto border border-gray-300 rounded-lg bg-gray-50 p-3'
            }
          />
          {previewState === 'loading' && (
            <p data-testid="pdf-preview-loading" className="text-xs text-gray-500 mt-2 flex items-center gap-2">
              <span className="animate-spin h-3 w-3 border-2 border-gray-300 border-t-gray-700 rounded-full inline-block" />
              Rendering preview&hellip;
            </p>
          )}
          {previewState === 'error' && (
            <p data-testid="pdf-preview-fallback" className="text-sm text-gray-600 mt-2">
              We couldn&rsquo;t render an inline preview here. Use &ldquo;Open full
              screen&rdquo; or &ldquo;Download PDF&rdquo; above to view the document in
              your browser.
            </p>
          )}
          {previewState === 'ready' && (
            <p className="text-xs text-gray-500 mt-2">
              Preview of the document. Use &ldquo;Open full screen&rdquo; for zoom,
              search, and printing.
            </p>
          )}
        </div>
        <a
          data-testid="mobile-open-doc"
          href={`${import.meta.env.VITE_API_BASE || ''}/v1/envelope/${envelopeId}/${token}/pdf`}
          target="_blank"
          rel="noopener noreferrer"
          className="md:hidden flex flex-col items-center justify-center gap-1 w-full py-10 px-4 border border-gray-300 rounded-lg bg-gray-50 text-center"
        >
          <span className="text-base font-medium text-blue-600">Open the document &#8599;</span>
          <span className="text-xs text-gray-500">Opens the full PDF in your browser</span>
        </a>
      </div>

      {/* Document details — F-5.4 / AC-12: NO hash is shown for the signer to
          verify. Byte-checking is the machines' job (the server's return-what-we-
          sent check, F-6.4); a raw SHA-256 only confuses a non-technical signer and
          implies a manual check the model deliberately doesn't ask for. The Envelope
          ID stays as a plain support reference (not something "to verify"). */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <h2 className="text-base font-medium mb-4">Document Details</h2>
        <div className="space-y-3">
          <div>
            <span className="text-sm text-gray-500">Envelope ID:</span>
            <p className="font-mono text-xs text-gray-700 mt-1">{info?.envelope_id}</p>
          </div>
        </div>
      </div>

      {/* Sign instructions. */}
      <div
        className="bg-white rounded-xl border border-gray-200 p-6"
        data-testid="how-to-sign"
      >
        <h2 className="text-base font-medium mb-3">Sign</h2>
        {info && <SignBlock info={info} />}
        <p className="text-xs text-gray-500 mt-4">
          Your email provider's built-in signature is your proof of intent.
          No account, password, or app is needed.
        </p>
        <a
          href="/how-it-works"
          className="text-sm text-gray-700 underline hover:text-gray-900"
        >
          How it works &rarr;
        </a>
      </div>

      {/* Footer — gray-500 (≥4.5:1), not gray-400 (~2.8:1) which the sweep flagged (UX). */}
      <p className="text-xs text-gray-500 text-center mt-6">
        Powered by kysigned
      </p>
    </div>
  )
}

/**
 * The Sign block (evidence-bundle model, F-5/F-6.3): the signer FORWARDS the email
 * they received (keeping the attached PDF) to the signing mailbox and types the
 * intent line first. The page can't reach into their mailbox, so it gives clear,
 * copy-able steps; the routing token already rides in the forwarded subject (F-5.2),
 * and the provider's DKIM signature on the forward is the signature. No mailto, no
 * compose-a-new-email, no "I SIGN" (the dropped Mode-2 path).
 */
function SignBlock({ info }: { info: SigningInfo }) {
  // The operator domain is the live host at runtime (correct for every operator,
  // including forks); the literal fallback only applies under SSR/tests, so it
  // must stay generic — no hardcoded operator domain (GH#103 / F-17.7).
  const operatorDomain =
    (typeof window !== 'undefined' ? window.location.hostname : '') || 'your-domain.example'
  const forwardTo = `forward-to-sign@${operatorDomain}`
  return (
    <>
      <p className="text-sm text-gray-600 mb-4">
        You sign by <strong>forwarding the email we sent you</strong>, the one this
        document was attached to. Three steps:
      </p>
      <ol className="text-sm text-gray-700 space-y-3 list-decimal ml-5 mb-2">
        <li>
          Open the kysigned email in your inbox (its subject mentions
          &ldquo;{info.document_name}&rdquo;).
        </li>
        <li>
          <strong>Forward</strong> it to <CopyChip value={forwardTo} />, and keep the
          attached PDF.
        </li>
        <li>
          Type this as the <strong>very first line</strong> of your forward, then press{' '}
          <strong>Send</strong>:
          <div className="mt-2">
            <CopyChip value="I sign this document" />
          </div>
        </li>
      </ol>
    </>
  )
}

function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — the value is still visible to select manually */
    }
  }
  return (
    <span className="inline-flex items-center gap-1 align-baseline">
      <code className="font-mono text-xs bg-green-50 border border-green-200 text-green-900 rounded px-1.5 py-0.5">
        {value}
      </code>
      {/* UX-014: ≥44×44 tap target on mobile via min-h/min-w; md:min-h-0/md:min-w-0
          reverts to the compact inline size on desktop so the inline chip isn't bloated. */}
      <button
        type="button"
        onClick={copy}
        className="text-xs underline text-gray-600 hover:text-gray-900 inline-flex items-center justify-center align-middle min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0"
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  )
}
