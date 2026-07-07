/**
 * HashCheckPage (F-25) — the /hashcheck original-document confirmation tool.
 *
 * "Is my original document the one carried inside this artifact, untouched?" Drop the
 * original document on one side and EITHER a completed signing record OR a sign-request
 * PDF on the other. Runs the browser-safe `checkOriginalInArtifact` engine
 * (pdf-lib + @noble/hashes + the web extractor) entirely client-side — neither file
 * leaves the device — and works for any operator's artifact. kysigned is not in the
 * trust set: a byte-exact bundle match plus the verifier's reconstruction proves the
 * signers signed exactly this document.
 */
import { useEffect, useState, type ChangeEvent } from 'react'
import { checkOriginalInArtifact, extractEmbeddedFileMapWeb, type HashCheckResult } from 'kysigned-verify'

type Check = (original: Uint8Array, artifact: Uint8Array) => Promise<HashCheckResult>
const defaultCheck: Check = (o, a) => checkOriginalInArtifact(o, a, extractEmbeddedFileMapWeb)

interface Loaded {
  name: string
  bytes: Uint8Array
}

function FilePick({
  label,
  loaded,
  onPick,
}: {
  label: string
  loaded: Loaded | null
  onPick: (e: ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <label className="flex cursor-pointer flex-col rounded-lg border-2 border-dashed border-gray-300 p-4 hover:border-gray-400">
      <span className="text-sm font-semibold text-gray-900">{label}</span>
      <span className="mt-1 text-xs text-gray-500">{loaded ? loaded.name : 'Choose a PDF…'}</span>
      <input type="file" accept="application/pdf,.pdf" aria-label={label} className="sr-only" onChange={onPick} />
    </label>
  )
}

function ResultCard({ r }: { r: HashCheckResult }) {
  const ok = r.match
  return (
    <div className={`mt-6 rounded-lg p-4 ${ok ? 'bg-green-100 text-green-900' : 'bg-red-100 text-red-900'}`}>
      <p className="text-lg font-semibold">{ok ? 'Document matches' : 'Document does NOT match'}</p>
      <p className="mt-1 text-sm">{r.reason}</p>
      {r.guarantee && (
        <p className="mt-2 text-xs font-medium uppercase tracking-wide">
          {r.guarantee === 'byte-exact'
            ? 'Byte-exact check (completed signing record)'
            : 'Content match (sign-request: page content, not byte-identical)'}
        </p>
      )}
      <p className="mt-3 break-all font-mono text-xs text-gray-600">
        {r.guarantee === 'content-level' ? 'Your document (content hash): ' : 'Your document (SHA-256): '}
        {r.originalSha256}
      </p>
      {r.foundSha256 && (
        <p className="mt-1 break-all font-mono text-xs text-gray-600">
          {r.guarantee === 'content-level'
            ? 'Document in the sign-request, cover removed (content hash): '
            : 'Document in the signing record (SHA-256): '}
          {r.foundSha256}
        </p>
      )}
    </div>
  )
}

export function HashCheckPage({ check = defaultCheck }: { check?: Check }) {
  const [original, setOriginal] = useState<Loaded | null>(null)
  const [artifact, setArtifact] = useState<Loaded | null>(null)
  const [result, setResult] = useState<HashCheckResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (original && artifact) {
      setBusy(true)
      setError(null)
      setResult(null)
      check(original.bytes, artifact.bytes)
        .then((r) => {
          if (!cancelled) setResult(r)
        })
        .catch(() => {
          if (!cancelled) setError('Could not read those files. Make sure both are PDFs.')
        })
        .finally(() => {
          if (!cancelled) setBusy(false)
        })
    } else {
      setResult(null)
    }
    return () => {
      cancelled = true
    }
  }, [original, artifact, check])

  async function onPick(e: ChangeEvent<HTMLInputElement>, set: (l: Loaded) => void) {
    const f = e.target.files?.[0]
    if (!f) return
    set({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })
  }

  function reset() {
    setOriginal(null)
    setArtifact(null)
    setResult(null)
    setError(null)
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-bold text-gray-900">Check your document</h1>
      <p className="mt-2 text-gray-600">
        Confirm that your original document is the one carried inside a kysigned artifact, untouched. Drop your{' '}
        <strong>original document</strong> on one side and <strong>either</strong> a completed signing record{' '}
        <strong>or</strong> a sign-request PDF on the other. The check runs <strong>entirely in your browser</strong>:
        your files never leave your device, and it works for any operator&rsquo;s artifact.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <FilePick label="Original document" loaded={original} onPick={(e) => onPick(e, setOriginal)} />
        <FilePick label="Signing record or sign-request" loaded={artifact} onPick={(e) => onPick(e, setArtifact)} />
      </div>

      {busy && <p className="mt-6 text-gray-600">Checking…</p>}
      {error && <p className="mt-6 text-red-700">{error}</p>}
      {result && <ResultCard r={result} />}

      {(original || artifact) && (
        <button onClick={reset} className="mt-6 text-sm text-gray-500 underline">
          Check another pair
        </button>
      )}

      <p className="mt-8 text-xs text-gray-600">
        A byte-exact match against a completed signing record, combined with the verifier&rsquo;s reconstruction (every
        signer signed <code>cover ++ document-original</code>), proves the signers signed exactly this document.
        kysigned is not in the trust set.
      </p>
    </div>
  )
}
