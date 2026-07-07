import { useEffect, useState } from 'react'
import { useParams, useLocation, useNavigate, Link } from 'react-router-dom'
import { apiGet, apiPost, apiPatch, apiDelete, type EnvelopeStatus } from '../lib/api'
import { trackEventOnce, GA_EVENTS } from '../lib/analytics'

export function EnvelopeDetailPage() {
  const { id } = useParams<{ id: string }>()
  // Arriving straight from "Send for Signing" carries justSent in router state:
  // jump to the top of the page and show a green confirmation banner. Captured
  // once on mount; the flag is then consumed so a refresh/back won't re-show it
  // (Barry QA 2026-06-19).
  const location = useLocation()
  const navigate = useNavigate()
  const [justSent] = useState(() => !!(location.state as { justSent?: boolean } | null)?.justSent)
  // 2026-06-21 — addresses an invite couldn't reach (undeliverable/transient) at
  // create time; drives a warning banner instead of the all-green "sent" one.
  const [deliveryProblems] = useState<string[]>(
    () => (location.state as { deliveryProblems?: string[] } | null)?.deliveryProblems ?? [],
  )
  const [data, setData] = useState<EnvelopeStatus | null>(null)
  const [error, setError] = useState('')
  const [reminding, setReminding] = useState(false)
  // F-23 recipient editing (until seal) + F-24 manual seal.
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addForm, setAddForm] = useState({ email: '', name: '', onBehalf: false, onBehalfOf: '' })
  const [editEmail, setEditEmail] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ name: '', onBehalf: false, onBehalfOf: '', newEmail: '' })

  useEffect(() => {
    apiGet<EnvelopeStatus>(`/v1/envelope/${id}`).then((envelope) => {
      setData(envelope)
      // GA4 key events (F-14.6 / AC-47), observed creator-side + deduped so a
      // reload/poll never double-counts: each newly-signed signer fires
      // signature_completed; a completed envelope fires envelope_completed.
      // Consent-gated upstream; a no-op when no GA4 is configured.
      for (const s of envelope.signers) {
        if (s.status === 'signed') {
          trackEventOnce(`sig:${envelope.id}:${s.email}`, GA_EVENTS.SIGNATURE_COMPLETED, {
            envelope_id: envelope.id,
          })
        }
      }
      if (envelope.status === 'completed') {
        trackEventOnce(`complete:${envelope.id}`, GA_EVENTS.ENVELOPE_COMPLETED, {
          envelope_id: envelope.id,
        })
      }
    }).catch((e) => setError(e.message))
  }, [id])

  // Post-send: jump to the top so the green banner is the first thing seen, then
  // strip justSent from history so a manual refresh doesn't re-show it.
  useEffect(() => {
    if (!justSent) return
    window.scrollTo({ top: 0 })
    navigate(location.pathname, { replace: true, state: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleRemind = async () => {
    setReminding(true)
    try {
      await apiPost(`/v1/envelope/${id}/remind`, {})
      alert('Reminders sent to pending signers.')
    } catch (e: any) {
      alert(e.message)
    } finally {
      setReminding(false)
    }
  }

  const refetch = async () => {
    setData(await apiGet<EnvelopeStatus>(`/v1/envelope/${id}`))
  }

  const handleVoid = async () => {
    if (!window.confirm('Cancel this whole envelope? Every pending signing request is voided. To fix one signer instead, edit or remove just that signer below.')) return
    try {
      await apiPost(`/v1/envelope/${id}/void`, {})
      await refetch()
    } catch (e: any) {
      alert(e.message)
    }
  }

  // F-24.2 — manual "Seal & send": assemble + distribute the bundle now and freeze.
  const handleSeal = async () => {
    if (!window.confirm('Seal this envelope and send the signing record to everyone? This cannot be undone.')) return
    setBusy(true)
    try {
      await apiPost(`/v1/envelope/${id}/seal`, {})
      await refetch()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setBusy(false)
    }
  }

  // F-23.1 — add a signer to the open envelope.
  const handleAddSigner = async () => {
    if (!addForm.email.trim() || !addForm.name.trim()) { alert('Name and email are required.'); return }
    setBusy(true)
    try {
      await apiPost(`/v1/envelope/${id}/signers`, {
        email: addForm.email.trim(),
        name: addForm.name.trim(),
        on_behalf_of: addForm.onBehalf && addForm.onBehalfOf.trim() ? addForm.onBehalfOf.trim() : undefined,
      })
      setAdding(false)
      setAddForm({ email: '', name: '', onBehalf: false, onBehalfOf: '' })
      await refetch()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setBusy(false)
    }
  }

  // F-23.1/2 — start editing a signer (prefill from the current row).
  const startEdit = (s: EnvelopeStatus['signers'][number]) => {
    setEditEmail(s.email)
    setEditForm({ name: s.name, onBehalf: !!s.on_behalf_of, onBehalfOf: s.on_behalf_of ?? '', newEmail: s.email })
  }

  // F-23.1/2/4 — submit an edit. A changed email rides as new_email → the backend
  // performs delete-old (cancellation) + add-new (F-23.4).
  const submitEdit = async (currentEmail: string) => {
    setBusy(true)
    try {
      const newEmail = editForm.newEmail.trim()
      await apiPatch(`/v1/envelope/${id}/signers?email=${encodeURIComponent(currentEmail)}`, {
        name: editForm.name.trim() || undefined,
        on_behalf_of: editForm.onBehalf ? (editForm.onBehalfOf.trim() || null) : null,
        ...(newEmail && newEmail.toLowerCase() !== currentEmail.toLowerCase() ? { new_email: newEmail } : {}),
      })
      setEditEmail(null)
      await refetch()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setBusy(false)
    }
  }

  // F-23.3 — delete a signer (a cancellation email goes to them).
  const handleDeleteSigner = async (signerEmail: string) => {
    if (!window.confirm(`Remove ${signerEmail}? They'll be emailed that their signing request was cancelled.`)) return
    setBusy(true)
    try {
      await apiDelete(`/v1/envelope/${id}/signers?email=${encodeURIComponent(signerEmail)}`)
      await refetch()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (error) return <div className="max-w-lg mx-auto mt-20 p-6 text-center text-red-600">{error}</div>
  if (!data) return <div className="flex items-center justify-center min-h-screen">
    <div className="animate-spin h-8 w-8 border-4 border-gray-300 border-t-gray-900 rounded-full" />
  </div>

  const signedCount = data.signers.filter((s) => s.status === 'signed').length
  const totalCount = data.signers.length
  const allSigned = totalCount > 0 && signedCount === totalCount
  // OPEN = not yet frozen (sealed/voided/expired). The Cancel control hangs off this.
  const open = data.status === 'active' || data.status === 'awaiting_seal'
  // F-24.1 — AUTO-close + fully signed + not yet distributed: the bundle is being
  // assembled & auto-distributed ("manufacturing"). The envelope is no longer out for
  // signature, no longer editable, and can no longer be cancelled (Barry QA 2026-06-21).
  const completePending = data.auto_close === true && allSigned && !data.completion_distributed_at && open
  // "Finalizing" = everyone signed but the bundle hasn't gone out yet — covers BOTH
  // auto (auto-distributing) and manual (awaiting the creator's seal). The page must
  // NEVER render this window as "active + editable + check-spam" (Barry QA 2026-06-21).
  const finalizing = allSigned && !data.completion_distributed_at && open
  // F-23.5 — the signer set is editable only while still OUT FOR SIGNATURE. A MANUAL
  // envelope stays editable until the creator seals (edit-until-seal); an AUTO one locks
  // the instant everyone has signed (it's finalizing).
  const editable = open && !completePending
  // F-24.2 — "Seal & send" for a MANUAL, fully-signed, still-open envelope. Appears the
  // moment the last signature lands (no 5-min wait for the cron to park it in
  // awaiting_seal). HIDES if the envelope is no longer all-signed (e.g. a signed signer
  // is edited → superseded → reverts to out-for-signature), and "Send Reminders" returns.
  const canSeal = allSigned && data.auto_close === false && open
  // The status pill never says "active" once everyone has signed: AUTO → "finalizing",
  // MANUAL → "ready to seal"; once the bundle is delivered → "completed".
  const displayStatus =
    data.status === 'completed' || data.completion_distributed_at ? 'completed' :
    completePending ? 'finalizing' :
    canSeal ? 'ready to seal' :
    data.status

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      {/* Post-send confirmation (Barry QA 2026-06-19) — shown at the very top so
          it's the first thing the creator sees after "Send for Signing". When an
          address couldn't be reached we warn instead of showing all-green
          (2026-06-21). */}
      {justSent && deliveryProblems.length === 0 && (
        <div className="mb-4 px-4 py-3 rounded-lg border border-green-300 bg-green-50 text-green-800 text-sm font-medium flex items-center gap-2">
          <span aria-hidden>&#10003;</span>
          Envelope sent successfully. Signing requests are on their way to your signers.
        </div>
      )}
      {justSent && deliveryProblems.length > 0 && (
        <div className="mb-4 px-4 py-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 text-sm">
          <strong>Envelope created</strong>, but we couldn&rsquo;t deliver the signing request to{' '}
          <strong>{deliveryProblems.join(', ')}</strong>. Double-check the address: fix it below
          (remove the signer and add them back at the corrected address) to retry.
        </div>
      )}
      <Link to="/dashboard" className="text-sm text-gray-600 hover:text-gray-900 mb-4 inline-flex items-center min-h-[44px] md:min-h-0">&larr; Dashboard</Link>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">{data.document_name}</h1>
          <p className="text-sm text-gray-600 font-mono mt-1">{data.document_hash.slice(0, 16)}...</p>
        </div>
        <span className={`text-xs px-2 py-1 rounded font-medium ${
          displayStatus === 'completed' ? 'bg-green-100 text-green-700' :
          displayStatus === 'finalizing' || displayStatus === 'ready to seal' || displayStatus === 'awaiting_seal' ? 'bg-amber-100 text-amber-700' :
          displayStatus === 'active' ? 'bg-blue-100 text-blue-700' :
          displayStatus === 'voided' ? 'bg-red-100 text-red-700' :
          'bg-gray-100 text-gray-600'
        }`}>{displayStatus.replace(/_/g, ' ')}</span>
      </div>

      {/* F-9.1 / AC-51 — evidence-bundle distribution state. */}
      {data.completion_distributed_at && (
        <div className="mb-4 px-4 py-2 rounded-lg border border-green-200 bg-green-50 text-green-800 text-sm">
          Signing record delivered to all parties on{' '}
          {new Date(data.completion_distributed_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}.
        </div>
      )}

      {/* Progress */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium">Progress</h2>
          <span className="text-sm text-gray-500">{signedCount} / {totalCount} signed</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div className="bg-green-500 h-2 rounded-full transition-all" style={{ width: `${(signedCount / totalCount) * 100}%` }} />
        </div>
      </div>

      {/* Signers (F-23 recipient editing until seal) */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium">Signers</h2>
          {editable && !adding && (
            <button onClick={() => setAdding(true)} disabled={busy}
                    className="text-sm text-blue-600 hover:underline disabled:opacity-40">
              + Add signer
            </button>
          )}
        </div>

        {/* Add-signer form (F-23.1) */}
        {editable && adding && (
          <div className="border border-blue-100 bg-blue-50/40 rounded-lg p-4 mb-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <input type="text" placeholder="Full name" value={addForm.name}
                     onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                     className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              <input type="email" placeholder="email@example.com" value={addForm.email}
                     onChange={(e) => setAddForm({ ...addForm, email: e.target.value })}
                     className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-600">
              <input type="checkbox" checked={addForm.onBehalf}
                     onChange={(e) => setAddForm({ ...addForm, onBehalf: e.target.checked })}
                     className="rounded border-gray-300" />
              Signing on behalf of an organisation
            </label>
            {addForm.onBehalf && (
              <input type="text" placeholder="Organisation name" value={addForm.onBehalfOf}
                     onChange={(e) => setAddForm({ ...addForm, onBehalfOf: e.target.value })}
                     className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            )}
            <div className="flex gap-2">
              <button onClick={handleAddSigner} disabled={busy}
                      className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-800 disabled:opacity-40">
                {busy ? 'Adding…' : 'Add & send request'}
              </button>
              <button onClick={() => { setAdding(false); setAddForm({ email: '', name: '', onBehalf: false, onBehalfOf: '' }) }}
                      className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="space-y-4">
          {data.signers.map((s, i) => {
            const badge =
              s.undeliverable_at && s.status === 'pending' ? { label: 'undeliverable', cls: 'bg-red-100 text-red-700' } :
              s.status === 'signed' ? { label: 'signed', cls: 'bg-green-100 text-green-700' } :
              s.status === 'superseded' ? { label: 'awaiting re-sign', cls: 'bg-orange-100 text-orange-700' } :
              s.status === 'declined' ? { label: 'declined', cls: 'bg-red-100 text-red-700' } :
              { label: 'pending', cls: 'bg-yellow-100 text-yellow-700' }
            const isEditing = editEmail === s.email
            return (
              <div key={i} className="border-b border-gray-50 pb-3 last:border-0">
                <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{s.name}</p>
                    <p className="text-xs text-gray-600 truncate" title={s.email}>{s.email}</p>
                    {s.on_behalf_of && <p className="text-xs text-gray-600">on behalf of {s.on_behalf_of}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-xs px-2 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
                    {editable && !isEditing && (
                      <>
                        <button onClick={() => startEdit(s)} disabled={busy}
                                className="text-xs text-gray-500 hover:text-gray-900 disabled:opacity-40">Edit</button>
                        <button onClick={() => handleDeleteSigner(s.email)} disabled={busy}
                                className="text-xs text-red-600 hover:text-red-700 disabled:opacity-40">Delete</button>
                      </>
                    )}
                  </div>
                </div>

                {s.status === 'signed' && !isEditing && (
                  <div className="mt-2 text-xs text-gray-500 space-y-0.5">
                    {/* No "Method:" line — Forward-to-sign (DKIM) is the only signing
                        method, so naming it every row is noise (Barry QA). */}
                    {s.signed_at && <p>Signed: {new Date(s.signed_at).toLocaleString()}</p>}
                    {/* F-11 — the evidence the bundle signature page carries, surfaced live. */}
                    {s.signing_domain && (
                      <p>Provider: {s.signing_domain}{s.signing_selector ? ` (selector ${s.signing_selector})` : ''}</p>
                    )}
                    {s.eml_sha256 && <p className="break-all font-mono text-xs">.eml SHA-256: {s.eml_sha256}</p>}
                  </div>
                )}

                {/* Inline edit form (F-23.1/2/4) */}
                {isEditing && (
                  <div className="mt-3 border border-gray-100 rounded-lg p-3 space-y-3">
                    {s.status === 'signed' && (
                      <p className="text-xs text-amber-700 bg-amber-50 rounded p-2">
                        This signer has already signed. Editing re-sends their request and drops the old signature (they&rsquo;ll need to sign again).
                      </p>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Full name</label>
                        <input type="text" value={editForm.name}
                               onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                               className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Email <span className="text-gray-600">(changing re-sends to the new address)</span></label>
                        <input type="email" value={editForm.newEmail}
                               onChange={(e) => setEditForm({ ...editForm, newEmail: e.target.value })}
                               className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-gray-600">
                      <input type="checkbox" checked={editForm.onBehalf}
                             onChange={(e) => setEditForm({ ...editForm, onBehalf: e.target.checked })}
                             className="rounded border-gray-300" />
                      Signing on behalf of an organisation
                    </label>
                    {editForm.onBehalf && (
                      <input type="text" placeholder="Organisation name" value={editForm.onBehalfOf}
                             onChange={(e) => setEditForm({ ...editForm, onBehalfOf: e.target.value })}
                             className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                    )}
                    <div className="flex gap-2">
                      <button onClick={() => submitEdit(s.email)} disabled={busy}
                              className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-800 disabled:opacity-40">
                        {busy ? 'Saving…' : 'Save & resend'}
                      </button>
                      <button onClick={() => setEditEmail(null)}
                              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2 justify-center">
        {/* F-24.2 — manual "Seal & send" (only when all-signed + parked). */}
        {canSeal && (
          <button onClick={handleSeal} disabled={busy}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-800 disabled:opacity-40">
            {busy ? 'Sealing…' : 'Seal & send signed envelope'}
          </button>
        )}
        {editable && !allSigned && (
          <button onClick={handleRemind} disabled={reminding}
                  className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40">
            {reminding ? 'Sending...' : 'Send Reminders'}
          </button>
        )}
        {/* F-9.6 — void = cancel the WHOLE envelope (to fix one signer, use the
            per-signer Edit/Delete above; void-and-recreate is retired, F-9.7).
            No "Download PDF" here: Family B generates a per-signer PDF (each
            signer's own cover), so there is no single "what signers see" file. */}
        {open && (
          <button onClick={handleVoid} disabled={completePending}
                  title={completePending ? 'Everyone has signed, the completed signing record is on its way, so this envelope can no longer be cancelled.' : undefined}
                  className={`px-4 py-2 text-sm border rounded-lg ${completePending ? 'border-gray-200 text-gray-300 cursor-not-allowed' : 'border-red-200 text-red-600 hover:bg-red-50'}`}>
            Cancel Envelope
          </button>
        )}
      </div>

      {/* Spam notice — only while still WAITING on signatures. Vanishes atomically the
          moment everyone has signed, in both auto & manual modes (Barry QA 2026-06-21). */}
      {data.status === 'active' && !allSigned && (
        <div className="mt-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-700">
          If signers haven't received the email, ask them to check their spam folder.
        </div>
      )}

      {/* Finalizing ("manufacturing") — everyone has signed; the bundle is on its way
          (AUTO) or awaiting the creator's seal (MANUAL). Replaces the spam notice so the
          all-signed state never looks like it's still waiting (Barry QA 2026-06-21). */}
      {finalizing && (
        <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
          {completePending
            ? 'All signed ✓. We’re assembling your signing record and emailing it to every party. This usually takes a minute or two; you can safely leave this page.'
            : 'All signed ✓. Review the signatures above, then “Seal & send” to deliver the signing record to everyone.'}
        </div>
      )}

      {/* The bundle-model "verify this envelope" guidance (download the
          completed evidence bundle, verify it at /verify) is rebuilt in
          Phase 12. */}
    </div>
  )
}
