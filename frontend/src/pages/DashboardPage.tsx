import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiGet, apiPost, formatUsd, type CreditBalance } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { trackEvent, GA_EVENTS } from '../lib/analytics'
import { PasskeyNudge } from '../components/PasskeyNudge'
import { getOperatorConfig } from '../config/operator'

interface EnvelopeBrief {
  id: string
  status: string
  created_at: string
  completed_at: string | null
}

interface DocumentSummary {
  documentHash: string
  documentName: string
  totalSigners: number
  signedCount: number
  envelopes: EnvelopeBrief[]
}

// F-11.1 / AC-30 — Open/Completed/Voided breakdown + affirmative-green status.
const STATUS_META: Record<string, { label: 'Open' | 'Completed' | 'Voided' | 'Expired'; cls: string }> = {
  active: { label: 'Open', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  completed: { label: 'Completed', cls: 'bg-green-50 text-green-700 border-green-200' },
  voided: { label: 'Voided', cls: 'bg-red-50 text-red-700 border-red-200' },
  expired: { label: 'Expired', cls: 'bg-gray-100 text-gray-600 border-gray-200' },
}
function statusMeta(s: string) {
  return STATUS_META[s] ?? { label: s as 'Open', cls: 'bg-gray-100 text-gray-600 border-gray-200' }
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * How many envelopes the current balance covers — floor(balance / per-envelope
 * cost). BigInt so it works on both the prod string micros and the numeric
 * test fixtures. Shown next to the dollar balance so "$5.00" reads as something
 * concrete ("≈ 20 envelopes").
 */
function envelopesAffordable(b: CreditBalance): number {
  const cost = BigInt(b.envelope_cost_usd_micros)
  if (cost <= 0n) return 0
  return Number(BigInt(b.balance_usd_micros) / cost)
}

/**
 * DashboardPage — list of envelopes + credit balance for the signed-in user.
 *
 * 2F.AUTH7 cleanup: this page no longer renders its own sign-in form,
 * identity strip, or sign-out button. RequireAuth (around this route in
 * App.tsx) renders the SignInScreen for anonymous visitors; AppHeader
 * renders the identity + sign-out widget for signed-in visitors. The
 * post-magic-link "you can close this tab" confirmation also moved into
 * the SignInScreen's URL-token handler.
 */
export function DashboardPage() {
  const { user } = useAuth()
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedHash, setExpandedHash] = useState<string | null>(null)
  const [balance, setBalance] = useState<CreditBalance | null>(null)
  // GH#108 — billing/balance is [service]/private: only fetch + show it when the
  // operator config enables billing. A fresh fork never touches /v1/credits/*.
  const { showBilling } = getOperatorConfig()

  // One-shot read of ?credits=success|cancelled from the payment-provider checkout
  // redirect URL. Stripped from the URL bar by the effect below.
  const [checkoutStatus] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return new URLSearchParams(window.location.search).get('credits')
  })

  const loadDocuments = async (email: string) => {
    const docs = await apiGet<DocumentSummary[]>(`/v1/documents?email=${encodeURIComponent(email)}`)
    setDocuments(docs)
    // Billing/balance is private (GH#108): a fork skips the /v1/credits read, so
    // `balance` stays null and every balance/top-up surface below stays hidden.
    if (showBilling) {
      setBalance(await apiGet<CreditBalance>('/v1/credits/balance').catch(() => null))
    }
  }

  useEffect(() => {
    // Strip payment-redirect params from the URL bar so a refresh doesn't
    // re-show the post-payment banner.
    const url = new URL(window.location.href)
    if (url.searchParams.has('credits') || url.searchParams.has('session_id')) {
      url.searchParams.delete('credits')
      url.searchParams.delete('session_id')
      window.history.replaceState({}, '', url.toString())
    }
  }, [])

  // GA4 key event (F-14.6 / AC-47): a credit top-up completed. Fires once
  // per redirect — `checkoutStatus` is captured from ?credits=success at mount and
  // the param is stripped above, so a reload won't re-fire. Consent-gated; a no-op
  // when no GA4 is configured.
  useEffect(() => {
    if (checkoutStatus === 'success') trackEvent(GA_EVENTS.CREDIT_PURCHASE)
  }, [checkoutStatus])

  useEffect(() => {
    if (!user) {
      // RequireAuth normally prevents this branch, but be defensive — if the
      // auth state ever flips to signed-out while we're here, stop loading
      // (AppHeader is showing Sign-in; nothing to render below).
      setLoading(false)
      return
    }
    setLoading(true)
    loadDocuments(user.email)
      .catch((e) => setError((e as Error).message ?? 'Failed to load documents'))
      .finally(() => setLoading(false))
  }, [user])

  if (!user) {
    // Should never render — RequireAuth gates us. Defensive blank.
    return null
  }

  const toggleExpand = (hash: string) => {
    setExpandedHash(expandedHash === hash ? null : hash)
  }

  // Start a checkout top-up (used by the balance banner's Add-credits button).
  // The session is created by the private billing fn; we redirect to the
  // returned provider checkout URL.
  const startCheckout = async () => {
    setError('')
    try {
      const result = await apiPost<{ url: string }>('/v1/credits/checkout', { email: user.email })
      window.location.href = result.url
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // Open/Completed/Voided breakdown across every envelope (GH#9 / AC-30).
  const summary = { Open: 0, Completed: 0, Voided: 0 }
  for (const doc of documents) {
    for (const env of doc.envelopes) {
      const label = statusMeta(env.status).label
      if (label === 'Open') summary.Open++
      else if (label === 'Completed') summary.Completed++
      else if (label === 'Voided') summary.Voided++
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {checkoutStatus === 'success' && (
        <div className="mb-4 px-4 py-3 rounded-lg border border-green-200 bg-green-50 text-green-800 text-sm">
          Payment received. Credits will appear in your balance shortly.
        </div>
      )}
      {checkoutStatus === 'cancelled' && (
        <div className="mb-4 px-4 py-3 rounded-lg border border-yellow-200 bg-yellow-50 text-yellow-800 text-sm">
          Checkout cancelled. No charge made.
        </div>
      )}
      {/* Suggest a passkey here (post-sign-in landing), only if the user has none. */}
      <PasskeyNudge />

      {/* Prominent balance — Barry QA 2026-06-17: "show my balance clear on top
          of the dashboard when I sign in." A full-width card with the dollar
          balance, how many envelopes it covers, and Add-credits. Amber when the
          balance won't cover a single envelope. */}
      {balance && (
        <div
          className={`mb-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border p-5 ${
            balance.sufficient_for_envelope ? 'border-gray-200 bg-white' : 'border-amber-300 bg-amber-50'
          }`}
        >
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Your balance</p>
            <p className="mt-0.5 text-3xl font-semibold tracking-tight text-gray-900">
              {formatUsd(balance.balance_usd_micros)}
            </p>
            <p className="mt-1 text-sm text-gray-600">
              {balance.sufficient_for_envelope ? (
                <>
                  ≈ {envelopesAffordable(balance)}{' '}
                  {envelopesAffordable(balance) === 1 ? 'envelope' : 'envelopes'} left
                  <span className="text-gray-600"> · {formatUsd(balance.envelope_cost_usd_micros)} each</span>
                </>
              ) : (
                <span className="text-amber-700">
                  Not enough to send — an envelope costs {formatUsd(balance.envelope_cost_usd_micros)}.
                </span>
              )}
            </p>
          </div>
          <button
            onClick={startCheckout}
            className="inline-flex items-center justify-center min-h-[44px] px-5 py-2.5 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-800 whitespace-nowrap"
          >
            Add credits
          </button>
        </div>
      )}

      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        {balance && !balance.sufficient_for_envelope ? (
          // UX-024 — a genuinely disabled control (not merely grey-styled): real
          // `disabled` + `aria-disabled`, out of the tab order, no handler. Semantics
          // now match the appearance, so it qualifies for the WCAG 1.4.3 disabled-control
          // contrast exemption (axe skips disabled controls) instead of failing
          // `color-contrast`. The amber balance banner above already carries the
          // "Add credits" call-to-action, so the click handler this replaced added nothing.
          <button
            type="button"
            disabled
            aria-disabled="true"
            tabIndex={-1}
            className="inline-flex items-center justify-center min-h-[44px] px-4 py-2 bg-gray-200 text-gray-500 rounded-lg text-sm font-medium cursor-not-allowed"
            title="Insufficient balance: add credits above to create an envelope"
          >
            New Envelope
          </button>
        ) : (
          <Link to="/dashboard/create"
                className="inline-flex items-center justify-center min-h-[44px] px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-800">
            New Envelope
          </Link>
        )}
      </div>

      {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

      {loading ? (
        <div className="text-center py-12">
          <div className="animate-spin h-6 w-6 border-4 border-gray-300 border-t-gray-900 rounded-full mx-auto" />
        </div>
      ) : documents.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
          {/* F-14.8 / AC-98 — a brand-new (grant-funded) account opens here with
              credit and no documents: surface the no-card trial offer. */}
          {balance && envelopesAffordable(balance) > 0 ? (
            <>
              <p className="text-gray-700 font-medium">
                You have {envelopesAffordable(balance)}{' '}
                {envelopesAffordable(balance) === 1 ? 'envelope' : 'envelopes'} ready to send. No credit card needed.
              </p>
              <p className="text-sm text-gray-600 mt-2">Click <strong>New Envelope</strong> to send your first one.</p>
            </>
          ) : (
            <>
              <p className="text-gray-500">No documents yet.</p>
              <p className="text-sm text-gray-600 mt-2">Click <strong>New Envelope</strong> to send your first one.</p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {/* AC-30 / GH#9 — Open/Completed/Voided status-summary header. */}
          <div className="flex flex-wrap gap-2 mb-1 text-xs">
            <span className="px-3 py-1 rounded-lg border border-blue-200 bg-blue-50 text-blue-700">Open: {summary.Open}</span>
            <span className="px-3 py-1 rounded-lg border border-green-200 bg-green-50 text-green-700">Completed: {summary.Completed}</span>
            <span className="px-3 py-1 rounded-lg border border-red-200 bg-red-50 text-red-700">Voided: {summary.Voided}</span>
          </div>
          {documents.map((doc) => {
            const complete = doc.totalSigners > 0 && doc.signedCount === doc.totalSigners
            return (
            <div key={doc.documentHash} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <button
                onClick={() => toggleExpand(doc.documentHash)}
                className="w-full flex items-center justify-between p-4 hover:bg-gray-50 text-left"
              >
                <div>
                  <p className="font-medium text-sm">{doc.documentName}</p>
                  {/* No bare UUID/hash (GH#26): a human "sent" date instead. */}
                  <p className="text-xs text-gray-600 mt-1">Sent {fmtDate(doc.envelopes[0]?.created_at ?? null)}</p>
                </div>
                <div className="flex items-center gap-3">
                  {/* Affirmative green when any progress / complete (GH#2). */}
                  <span className={`text-xs ${doc.signedCount > 0 ? 'text-green-700 font-medium' : 'text-gray-600'}`}>
                    {doc.signedCount}/{doc.totalSigners} signed{complete ? ' ✓' : ''}
                  </span>
                  <span className="text-xs text-gray-600">
                    {expandedHash === doc.documentHash ? '−' : '+'}
                  </span>
                </div>
              </button>

              {expandedHash === doc.documentHash && (
                <div className="border-t border-gray-100 px-4 py-3 space-y-1 bg-gray-50/50">
                  {doc.envelopes.map((env) => (
                    <Link
                      key={env.id}
                      to={`/dashboard/envelope/${env.id}`}
                      className="flex items-center justify-between text-xs py-1.5 px-2 rounded hover:bg-gray-100"
                    >
                      <span className="text-gray-600">
                        {fmtDate(env.created_at)}
                        {env.completed_at ? ` → completed ${fmtDate(env.completed_at)}` : ''}
                      </span>
                      <span className={`px-2 py-0.5 rounded border ${statusMeta(env.status).cls}`}>
                        {statusMeta(env.status).label}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
