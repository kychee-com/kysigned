/**
 * /verify — the fully client-side bundle verifier (F-10.1 / AC-27).
 *
 * Drag a bundle PDF onto the page (or use the Upload button) and it is verified
 * ENTIRELY in your browser — the file never leaves your device, and the page works
 * with the network disabled. Runs the same documented algorithm as the reference
 * CLI (`kysigned-verify` = the WebCrypto engine, differential-tested to match the
 * mainstream mailauth verifier). The verdict comes only from the embedded evidence;
 * kysigned is not part of the trust set, and there is deliberately NO certificate /
 * seal / trust-badge UI — a kysigned bundle is a clean, unsigned PDF.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  verifyBundleWeb,
  confirmBitcoinAnchorsWeb,
  confirmKeyArchiveWeb,
  type BundleVerdict,
  type SignerVerdict,
  type BitcoinAnchor,
  type KeyArchiveConfirmation,
} from 'kysigned-verify'

type Verify = (bytes: Uint8Array) => Promise<BundleVerdict>
type Confirm = (bytes: Uint8Array) => Promise<Record<number, BitcoinAnchor>>
type ConfirmKey = (bytes: Uint8Array) => Promise<Record<number, KeyArchiveConfirmation>>
type Status = 'idle' | 'verifying' | 'done' | 'error'

// Persist the loaded record for THIS tab so a reload (F5) re-shows + re-checks the
// same document; cleared only by "Validate another document". sessionStorage keeps
// it local (the file never leaves the device) and tab-scoped.
const SESSION_KEY = 'kysigned-verify-record'
function bytesToB64(b: Uint8Array): string {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < b.length; i += CH) s += String.fromCharCode(...b.subarray(i, i + CH))
  return btoa(s)
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}
function saveSession(name: string, bytes: Uint8Array): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ name, b64: bytesToB64(bytes) }))
  } catch {
    /* over quota (very large record) — skip persistence; the page still works */
  }
}
function loadSession(): { name: string; bytes: Uint8Array } | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const { name, b64 } = JSON.parse(raw) as { name: string; b64: string }
    return { name, bytes: b64ToBytes(b64) }
  } catch {
    return null
  }
}
function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY)
  } catch {
    /* ignore */
  }
}

function fmtTime(sec: number | null): string {
  if (!sec) return 'time pending online confirmation'
  const d = new Date(sec * 1000)
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`
}

// The key-archive registration time (ISO-8601 → UTC date+minute), for the green badge.
function fmtIso(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded ${ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
      <span aria-hidden>{ok ? '✓' : '✗'}</span>
      {label}
    </span>
  )
}

function BitcoinAnchorBadge({ a }: { a: BitcoinAnchor }) {
  if (a.status === 'absent') return null
  if (a.status === 'confirmed') {
    const detail = a.blockHeight ? ` (block ${a.blockHeight}${a.timeSec ? `, ${fmtTime(a.timeSec)}` : ''})` : ''
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-green-50 text-green-800">
        <span aria-hidden>✓</span>Bitcoin timestamp confirmed{detail}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">
      Bitcoin timestamp pending (up to 24h, this is normal)
    </span>
  )
}

// Key-archive presence (F-10.7), mirroring the Bitcoin badge: green when the exact
// key is found in the public archive (with its registration time), grey otherwise.
// There is NO red state — the key check is additive and never fails the bundle.
function KeyArchiveBadge({ s }: { s: SignerVerdict }) {
  if (s.checks.keyAuthenticity === 'archive-confirmed') {
    const when = fmtIso(s.keyObservedAt)
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-green-50 text-green-800">
        <span aria-hidden>✓</span>key in public archive{when ? ` (registered ${when})` : ''}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">
      key archive pending (extra check, this is normal)
    </span>
  )
}

function SignerCard({ s }: { s: SignerVerdict }) {
  return (
    <div className={`rounded-lg border p-4 ${s.proven ? 'border-green-200 bg-green-50/40' : 'border-red-200 bg-red-50/40'}`}>
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-gray-900">
          Signer {s.index}: {s.email ?? '(unknown)'}
        </h3>
        <span className={`text-sm font-semibold ${s.proven ? 'text-green-700' : 'text-red-700'}`}>
          {s.proven ? 'PROVEN' : 'FAILED'}
        </span>
      </div>
      {s.proven && (
        <p className="mt-1 text-sm text-gray-700">
          Authenticated by <strong>{s.signingDomain}</strong> as <strong>{s.email}</strong>, who sent
          {' '}&ldquo;{s.verbatimIntent}&rdquo; with exactly this document attached, at {fmtTime(s.signingTimeSec)}.
        </p>
      )}
      {s.originalDocSha256 && (
        <p className="mt-1 break-all font-mono text-xs text-gray-500">
          Original document (SHA-256): {s.originalDocSha256}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Check ok={s.checks.dkim} label="email signature" />
        <Check ok={s.checks.attachment} label="document matches" />
        <Check ok={s.checks.intent} label="intent line" />
        <Check ok={s.checks.timestamp} label="timestamp" />
        <KeyArchiveBadge s={s} />
        <BitcoinAnchorBadge a={s.bitcoinAnchor} />
      </div>
      {!s.proven && s.reasons.length > 0 && (
        <ul className="mt-3 list-disc pl-5 text-sm text-red-700">
          {s.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function VerifyPage({
  verify = (bytes: Uint8Array) => verifyBundleWeb(bytes),
  confirm = (bytes: Uint8Array) => confirmBitcoinAnchorsWeb(bytes),
  // The key-archive lookup goes through the operator's SAME-ORIGIN proxy (F-10.8):
  // archive.prove.email serves no CORS headers, so the browser can't call it directly.
  // (The CLI uses the direct archive default; the verdict stays client-side either way.)
  confirmKey = (bytes: Uint8Array) => confirmKeyArchiveWeb(bytes, { baseUrl: '', path: '/v1/key-archive' }),
}: { verify?: Verify; confirm?: Confirm; confirmKey?: ConfirmKey }) {
  const [status, setStatus] = useState<Status>('idle')
  const [verdict, setVerdict] = useState<BundleVerdict | null>(null)
  const [fileName, setFileName] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Verify, then AUTO-RUN the online confirmations (Bitcoin anchor + key-archive
  // presence) in the background. The verdict renders immediately from the offline
  // checks; each signer's Bitcoin + key-archive badges then upgrade to green on
  // their own when confirmed, degrading gracefully to pending offline. Both are
  // ADDITIVE — neither ever changes the PROVEN / FAILED verdict.
  const verifyAndConfirm = useCallback(
    async (bytes: Uint8Array) => {
      setStatus('verifying')
      setVerdict(null)
      try {
        const v = await verify(bytes)
        setVerdict(v)
        setStatus('done')
        if (v.signers.some((s) => s.bitcoinAnchor.status === 'pending')) {
          confirm(bytes)
            .then((anchors) =>
              setVerdict((cur) =>
                cur
                  ? { ...cur, signers: cur.signers.map((s) => ({ ...s, bitcoinAnchor: anchors[s.index] ?? s.bitcoinAnchor })) }
                  : cur,
              ),
            )
            .catch(() => {
              /* stays pending — offline, or not yet committed to a Bitcoin block */
            })
        }
        // AUTO-RUN the key-archive presence check too (F-10.7), same pattern: the
        // offline verdict shows the key `pending` (grey); this upgrades it to green
        // "key in public archive" when the exact key is found. Additive — it never
        // changes the verdict, and degrades to pending offline / when unreachable.
        if (v.signers.some((s) => s.checks.keyAuthenticity === 'pending-online')) {
          confirmKey(bytes)
            .then((keys) =>
              setVerdict((cur) =>
                cur
                  ? {
                      ...cur,
                      signers: cur.signers.map((s) => {
                        const k = keys[s.index]
                        return k
                          ? { ...s, checks: { ...s.checks, keyAuthenticity: k.keyAuthenticity }, keyObservedAt: k.observedAt }
                          : s
                      }),
                    }
                  : cur,
              ),
            )
            .catch(() => {
              /* stays pending — offline or the archive is unreachable */
            })
        }
      } catch {
        setStatus('error')
      }
    },
    [verify, confirm, confirmKey],
  )

  const handleFile = useCallback(
    async (file: File) => {
      setFileName(file.name)
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        saveSession(file.name, bytes)
        await verifyAndConfirm(bytes)
      } catch {
        setStatus('error')
      }
    },
    [verifyAndConfirm],
  )

  // Reload (F5): restore + re-verify the record loaded earlier in this tab.
  useEffect(() => {
    const saved = loadSession()
    if (saved) {
      setFileName(saved.name)
      void verifyAndConfirm(saved.bytes)
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const reset = useCallback(() => {
    setStatus('idle')
    setVerdict(null)
    setFileName('')
    clearSession()
  }, [])

  return (
    // min-h-screen reserves the above-the-fold space so the layout below the
    // content does not settle/jump as the page finishes loading (UX-002 / CLS).
    <div className="max-w-2xl mx-auto px-4 py-12 min-h-screen">
      <h1 className="text-2xl font-semibold mb-2">Verify a signed document</h1>
      <p className="mb-4 text-sm">
        <a href="/how-it-works-technical.html#verify" className="text-blue-600 hover:underline">
          How this page works?
        </a>
      </p>
      <p className="text-gray-600 mb-8">
        {status === 'done' ? (
          <>
            Checked <strong>entirely in your browser</strong>. Your file never left your device, and this works even
            offline.
          </>
        ) : (
          <>
            Drop a kysigned signing record below (the PDF kysigned emails you once a document is signed) to confirm it
            is genuine. It is checked <strong>entirely in your browser</strong>: your file never leaves your device, and
            this works even offline.
          </>
        )}
      </p>

      {(status === 'idle' || status === 'error') && (
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const f = e.dataTransfer.files?.[0]
          if (f) void handleFile(f)
        }}
        className={`rounded-xl border-2 border-dashed p-10 text-center transition-colors ${dragOver ? 'border-[#1a1a2e] bg-gray-50' : 'border-gray-300'}`}
      >
        <p className="text-gray-700">Drag the signing record PDF here</p>
        <p className="my-2 text-sm text-gray-600">or</p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center justify-center min-h-[44px] rounded-md bg-[#1a1a2e] px-4 py-2 text-sm font-medium text-white"
        >
          Upload a signing record
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          aria-label="Upload a signing record PDF"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleFile(f)
          }}
        />
      </div>
      )}

      {status === 'verifying' && <p className="mt-6 text-gray-600">Verifying {fileName}…</p>}
      {status === 'error' && (
        <p className="mt-6 text-red-700">Could not read that file. Make sure it is a kysigned signing record PDF.</p>
      )}

      {status === 'done' && verdict && (
        <div className="mt-8">
          {verdict.errors.length > 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-800">
              <p className="font-semibold">This doesn&rsquo;t look like a kysigned signing record.</p>
              <ul className="mt-2 list-disc pl-5 text-sm">
                {verdict.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <div
                className={`rounded-lg p-4 mb-4 ${verdict.proven ? 'bg-green-100 text-green-900' : 'bg-red-100 text-red-900'}`}
              >
                <p className="text-lg font-semibold">{verdict.proven ? 'Verified' : 'Not verified'}</p>
                <p className="text-sm">
                  {verdict.proven
                    ? 'Every signature is genuine and bound to this exact document.'
                    : 'One or more checks failed. See the details below.'}
                </p>
              </div>

              <div className="space-y-3">
                {verdict.signers.map((s) => (
                  <SignerCard key={s.index} s={s} />
                ))}
              </div>

              <div className="mt-4 rounded-lg border border-gray-200 p-4 text-sm text-gray-600">
                <p>
                  <strong>Verification code:</strong>{' '}
                  <span className={verdict.fingerprint.matchesPrinted ? 'text-green-700' : 'text-red-700'}>
                    {verdict.fingerprint.matchesPrinted ? 'matches' : 'does NOT match'} the value printed on the
                    document
                  </span>
                </p>
                <p className="mt-1 break-all font-mono text-xs text-gray-500">{verdict.fingerprint.computed}</p>
                {verdict.originalDocSha256 && (
                  <>
                    <p className="mt-3">
                      <strong>Original document:</strong> every signer signed this exact document.
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-gray-500">SHA-256: {verdict.originalDocSha256}</p>
                  </>
                )}
              </div>
            </>
          )}

          <p className="mt-6 text-xs text-gray-600">
            Verified in your browser using the open-source kysigned algorithm. kysigned is not part of the trust set:
            the verdict comes only from the embedded evidence (your email provider, the public key archives, the
            timestamp authorities, and the maths).
          </p>

          <div className="mt-8 text-center">
            <button
              type="button"
              onClick={reset}
              className="rounded-md bg-[#1a1a2e] px-5 py-2.5 text-sm font-medium text-white"
            >
              Validate another document
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
