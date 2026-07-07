const API_BASE = import.meta.env.VITE_API_BASE || ''

// v0.22.0 / 2F.AUTH4 / DD-72: cookie-based session, no JS-readable tokens.
//
// The operator's private Lambda issues an HttpOnly `kysigned_session` cookie
// scoped to `cookieDomain` (e.g. `.kysigned.com`) on successful sign-in.
// Every authenticated request rides on that cookie via `credentials:'include'`.
// Refresh rotation happens server-side inside the auth middleware — the SPA
// never sees the underlying run402 access/refresh tokens, never holds them in
// localStorage, and never calls a /v1/auth/refresh endpoint.
//
// CSRF defense: state-changing routes (POST/PUT/PATCH/DELETE) require the
// `X-Kysigned-Csrf` header. The security property comes from the browser's
// cross-origin custom-header preflight rule, not from value secrecy — any
// fixed value works.
const CSRF_HEADER_VALUE = '1'

function authHeaders(): Record<string, string> {
  // Cookie attaches automatically via `credentials: 'include'`. Nothing to
  // add here. Kept as a no-op for symmetry with the pre-v0.22.0 shape; the
  // caller doesn't need to know auth changed shape.
  return {}
}

// 2F.AUTH7: programmatic signOut moved into AuthContext (handles cookie
// clear + cross-tab broadcast + local state update in one place). The api.ts
// signOut helper was removed — callers should use `useAuth().signOut()`.

// 2F.X15 TEMP DEBUG: pre-launch testnet rehearsal — surface server-side error
// details (when KYSIGNED_EXPOSE_INTERNAL_ERRORS=1 on the Lambda) into the
// thrown Error message so the UI shows them. Removed once the rehearsal is
// green end-to-end.
function buildErrorMessage(data: { error?: string; reason?: string; debug_message?: string }): string {
  const parts: string[] = []
  if (data.error) parts.push(data.error)
  if (data.reason) parts.push(`(${data.reason})`)
  if (data.debug_message) parts.push(`— debug: ${data.debug_message}`)
  return parts.join(' ') || 'Request failed'
}

/**
 * ApiError — an Error carrying the HTTP status, so callers can tell an opaque
 * server fault (5xx) from a helpful client-side validation message (4xx). Used by
 * friendlyCreateError (2026-06-21). Extends Error, so existing `e.message` /
 * `instanceof Error` callers are unaffected.
 */
export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function fetchWithCookieAuth(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE}${path}`, { ...init, credentials: 'include' })
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetchWithCookieAuth(path, { headers: authHeaders() })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new ApiError(buildErrorMessage(body), res.status)
  }
  return res.json()
}

/**
 * apiGetPublic — GET a PUBLIC endpoint WITHOUT credentials (v0.29.0 / F5.13 / DD-93).
 *
 * Public proof/verify routes (`/v1/verify/:id`, `/v1/verify/email`) must render
 * regardless of auth state. Sending the session cookie makes the server's auth
 * middleware attempt a refresh; if a concurrent AuthContext call is rotating the
 * refresh token, the public request loses the race and 401s ("Refresh token
 * already used") — turning a public proof page into "Authentication failed".
 *
 * `credentials:'omit'` is REQUIRED (not just the default): under the v0.22.1
 * same-origin apex model the SPA and API share an origin, so a default fetch
 * (`credentials:'same-origin'`) WOULD send the cookie. Omitting it explicitly
 * keeps this request entirely out of the auth-refresh path.
 */
export async function apiGetPublic<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: 'GET', credentials: 'omit' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new ApiError(buildErrorMessage(body), res.status)
  }
  return res.json()
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithCookieAuth(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Kysigned-Csrf': CSRF_HEADER_VALUE,
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }))
    throw new ApiError(buildErrorMessage(data), res.status)
  }
  return res.json()
}

/** apiPatch — PATCH with cookie auth + CSRF header (F-23 recipient edit). */
export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithCookieAuth(path, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-Kysigned-Csrf': CSRF_HEADER_VALUE,
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }))
    throw new ApiError(buildErrorMessage(data), res.status)
  }
  return res.json()
}

/**
 * apiDelete — DELETE with cookie auth + CSRF header (2F.AUTH9 / passkey
 * management). HTTP 204 No Content responses are common for deletes; return
 * `null` in that case so callers don't try to JSON-parse an empty body.
 */
export async function apiDelete<T = null>(path: string): Promise<T | null> {
  const res = await fetchWithCookieAuth(path, {
    method: 'DELETE',
    headers: { 'X-Kysigned-Csrf': CSRF_HEADER_VALUE, ...authHeaders() },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }))
    throw new ApiError(buildErrorMessage(data), res.status)
  }
  if (res.status === 204) return null
  return res.json()
}

/**
 * v0.22.0 / 2F.AUTH4 full F9.8: credit balance API. The server returns balance + envelope
 * cost + a precomputed sufficient flag so the SPA doesn't need to know the
 * cost basis.
 */
export interface CreditBalance {
  balance_usd_micros: string // bigint serialized as string
  envelope_cost_usd_micros: string
  sufficient_for_envelope: boolean
}

export function formatUsd(usdMicros: string): string {
  const cents = Number(BigInt(usdMicros) / 10_000n)
  return `$${(cents / 100).toFixed(2)}`
}

export interface EnvelopeStatus {
  id: string
  document_name: string
  document_hash: string
  status: string
  /** F-24 — false = manual seal (the "Seal & send" action applies on all-signed). */
  auto_close: boolean
  created_at: string
  completed_at: string | null
  /** F-9.1 / AC-51 — when the evidence bundle was distributed to every party. */
  completion_distributed_at: string | null
  signers: Array<{
    email: string
    name: string
    /** F-22.2 — organisation this signer declared signing on behalf of (or null). */
    on_behalf_of: string | null
    /** pending | signed | superseded (re-requested after an edit) | declined. */
    status: string
    signing_method: string | null
    signed_at: string | null
    /** F-9.8 — non-null when the signing-request email hard-bounced (undeliverable). */
    undeliverable_at: string | null
    /** F-11 — per-signer evidence (mirrors the bundle signature page); null until signed. */
    signing_domain?: string | null
    signing_selector?: string | null
    eml_sha256?: string | null
  }>
}

/**
 * SigningInfo — v0.17.x shape per DD-61. The singular `contract_address` is
 * gone; `contracts` is the full deployment triple so SigningPage can show
 * the signer all three addresses (transparency — they can audit where their
 * reply lands).
 */
export interface SigningInfo {
  envelope_id: string
  document_name: string
  document_hash: string
  signer_name: string
  signer_email: string
  /**
   * Envelope creator's email (Sender). Surfaced so the signing page's
   * mismatch banner (F22.2.3) can render a Contact-sender mailto. May be
   * null for legacy wallet-sender envelopes; reply-to-sign envelopes always
   * carry an email. Added v0.19.0 / 2F.L3.2.
   */
  sender_email: string | null
  verification_level: number
  already_signed: boolean
  status: string
  /** ISO timestamp when the PDF blob was deleted per F8.6 ephemeral retention. */
  pdf_deleted_at: string | null
  /** ISO timestamp when the envelope completed (all signers signed). */
  completed_at: string | null
  /** Exact mailbox address for signer forwards when provided by the deployment. */
  signing_email?: string
}
