/**
 * VerifyPage.test.tsx — F-10.1 / AC-27 UI. The verification ENGINE is tested in
 * the kysigned package (verifyWeb.test, differential vs mailauth); this asserts the
 * page renders a verdict correctly: PROVEN banner + per-signer detail, FAILED with
 * reasons, a non-bundle notice, and the fully-client-side framing (no seal/cert UI).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { VerifyPage } from './VerifyPage'
import type { BundleVerdict, SignerVerdict, BitcoinAnchor, KeyArchiveConfirmation } from 'kysigned-verify'

function signer(over: Partial<SignerVerdict> = {}): SignerVerdict {
  const proven = over.proven ?? true
  return {
    index: 1,
    proven,
    tier: proven ? 'INTEGRITY_VERIFIED' : 'FAILED',
    assurance: { keyProvenance: 'pending', timestampDurability: 'confirmed', keyValidity: 'pending' },
    email: 'alice@example.com',
    signingDomain: 'example.com',
    verbatimIntent: 'I sign this document',
    signingTimeSec: 1_780_000_000,
    originalDocSha256: 'd'.repeat(64),
    checks: { dkim: true, attachment: true, intent: true, timestamp: true, keyAuthenticity: 'pending-online' },
    bitcoinAnchor: { status: 'pending' },
    reasons: [],
    ...over,
  }
}

function verdict(over: Partial<BundleVerdict> = {}): BundleVerdict {
  const proven = over.proven ?? true
  return {
    proven,
    tier: proven ? 'INTEGRITY_VERIFIED' : 'FAILED',
    fingerprint: { computed: 'a'.repeat(64), matchesPrinted: true },
    originalDocSha256: 'd'.repeat(64),
    signers: [signer()],
    errors: [],
    ...over,
  }
}

async function uploadWith(
  v: BundleVerdict,
  confirm: (b: Uint8Array) => Promise<Record<number, BitcoinAnchor>> = async () => ({}),
  confirmKey: (b: Uint8Array) => Promise<Record<number, KeyArchiveConfirmation>> = async () => ({}),
) {
  render(<VerifyPage verify={async () => v} confirm={confirm} confirmKey={confirmKey} />)
  const input = screen.getByLabelText('Upload a signing record PDF') as HTMLInputElement
  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'bundle.pdf', { type: 'application/pdf' })
  fireEvent.change(input, { target: { files: [file] } })
}

afterEach(() => {
  sessionStorage.clear()
})

describe('VerifyPage — client-side verifier (AC-27)', () => {
  it('renders a PROVEN verdict with the human-first per-signer claim', async () => {
    await uploadWith(verdict())
    await waitFor(() => expect(screen.getByTestId('overall-verdict')).toHaveTextContent('INTEGRITY VERIFIED'))
    expect(screen.getByText(/Signer 1: alice@example\.com/)).toBeInTheDocument()
    expect(screen.getByText(/Authenticated by/)).toBeInTheDocument()
    expect(screen.getByText('document matches')).toBeInTheDocument()
    expect(screen.getByText(/matches the value printed/)).toBeInTheDocument()
  })

  it('surfaces the original document hash labelled SHA-256, never the internal "A" (F-10.9 / AC-105)', async () => {
    await uploadWith(verdict())
    await waitFor(() => expect(screen.getByTestId('overall-verdict')).toHaveTextContent('INTEGRITY VERIFIED'))
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/Original document \(SHA-256\):/) // labelled SHA-256 (not "A")
    expect(text).not.toMatch(/Original document A|Original document \(A\)/) // internal symbol never customer-facing
    expect(text).toMatch(/every signer signed this exact document/i) // envelope-level assertion
    expect(text.includes('d'.repeat(64))).toBe(true) // the hash value is rendered
  })

  it('renders a FAILED verdict naming the broken check', async () => {
    await uploadWith(
      verdict({
        proven: false,
        fingerprint: { computed: 'b'.repeat(64), matchesPrinted: false },
        signers: [signer({ proven: false, checks: { dkim: false, attachment: true, intent: true, timestamp: true, keyAuthenticity: 'pending-online' }, reasons: ['DKIM invalid_signature'] })],
      }),
    )
    await waitFor(() => expect(screen.getByText('Not verified')).toBeInTheDocument())
    expect(screen.getByText('FAILED')).toBeInTheDocument()
    expect(screen.getByText('DKIM invalid_signature')).toBeInTheDocument()
    expect(screen.getByText(/does NOT match the value printed/)).toBeInTheDocument()
  })

  it('shows a friendly notice for a non-bundle PDF', async () => {
    await uploadWith(verdict({ proven: false, signers: [], errors: ['no signer-<n>.eml evidence found'] }))
    await waitFor(() => expect(screen.getByText(/doesn.t look like a kysigned signing record/i)).toBeInTheDocument())
  })

  it('states it runs entirely in the browser and shows NO certificate/seal UI', () => {
    render(<VerifyPage verify={async () => verdict()} />)
    const text = document.body.textContent ?? ''
    expect(/entirely in your browser/i.test(text)).toBe(true)
    expect(/never leaves your device/i.test(text)).toBe(true)
    expect(/certificate|seal|trust badge/i.test(text)).toBe(false)
  })

  it('after a result the dropzone vanishes; "Validate another document" resets it (Barry QA)', async () => {
    await uploadWith(verdict())
    await waitFor(() => expect(screen.getByTestId('overall-verdict')).toHaveTextContent('INTEGRITY VERIFIED'))
    // the drop UI + the "drop below" subtitle are gone once a record is loaded...
    expect(screen.queryByText('Drag the signing record PDF here')).toBeNull()
    expect(document.body.textContent).not.toMatch(/Drop a kysigned signing record below/i)
    // ...replaced by a reset button at the bottom.
    const again = screen.getByRole('button', { name: /validate another document/i })
    fireEvent.click(again)
    expect(screen.getByText('Drag the signing record PDF here')).toBeInTheDocument()
    expect(document.body.textContent).toMatch(/Drop a kysigned signing record below/i)
    expect(screen.queryByTestId('overall-verdict')).toBeNull()
  })

  it('auto-runs the Bitcoin confirmation on load → green with block + time, NO button (F-10.6 / AC-99)', async () => {
    await uploadWith(verdict(), async () => ({ 1: { status: 'confirmed', blockHeight: 750000, timeSec: 1_700_000_000 } }))
    await waitFor(() => expect(screen.getByText(/Bitcoin timestamp confirmed/i)).toBeInTheDocument())
    expect(screen.getByText(/block 750000/i)).toBeInTheDocument()
    expect(screen.getByTestId('overall-verdict')).toHaveTextContent('INTEGRITY VERIFIED') // additive — never changes the verdict
    expect(screen.queryByRole('button', { name: /confirm on bitcoin/i })).toBeNull() // no manual button
  })

  it('a Bitcoin confirmation that stays pending leaves the anchor grey (graceful offline, AC-100)', async () => {
    await uploadWith(verdict(), async () => ({ 1: { status: 'pending' } }))
    await waitFor(() => expect(screen.getByTestId('overall-verdict')).toHaveTextContent('INTEGRITY VERIFIED'))
    expect(screen.getByText(/Bitcoin timestamp pending/i)).toBeInTheDocument()
    // Pending is a normal technicality, not a problem — the copy must reassure and
    // state the expected wait (up to 24h) so it never reads as a failure.
    const pending = document.body.textContent ?? ''
    expect(pending).toMatch(/up to 24h/i)
    expect(pending).toMatch(/normal/i)
  })

  it('auto-runs the key-archive GATE → exact key confirmed within the window UPGRADES the tier to PROVIDER KEY CONFIRMED (F-32.3 / AC-152)', async () => {
    await uploadWith(
      verdict(),
      async () => ({}),
      async () => ({
        1: { keyAuthenticity: 'archive-confirmed', keyProvenance: 'confirmed', observedAt: '2026-06-29T11:42:02.820Z', lastSeenAt: '2026-06-29T11:42:02.820Z' },
      }),
    )
    await waitFor(() => expect(screen.getByText(/key in public archive/i)).toBeInTheDocument())
    expect(screen.getByText(/registered 2026-06-29/i)).toBeInTheDocument()
    // The provenance gate confirmed the exact key → the tier deterministically upgrades.
    await waitFor(() => expect(screen.getByTestId('overall-verdict')).toHaveTextContent('PROVIDER KEY CONFIRMED'))
  })

  it('the key-archive gate FAILS the verdict when the archive publishes a DIFFERENT key (forgery signal, F-32.3 / AC-157)', async () => {
    await uploadWith(
      verdict(),
      async () => ({}),
      async () => ({ 1: { keyAuthenticity: 'pending-online', keyProvenance: 'failed', observedAt: null, lastSeenAt: null } }),
    )
    await waitFor(() => expect(screen.getByTestId('overall-verdict')).toHaveTextContent('Not verified'))
    expect(screen.getByText(/provider key mismatch/i)).toBeInTheDocument()
  })

  it('a key-archive check that stays pending leaves the badge grey, never red (AC-102)', async () => {
    await uploadWith(verdict(), async () => ({}), async () => ({ 1: { keyAuthenticity: 'pending-online', keyProvenance: 'pending', observedAt: null, lastSeenAt: null } }))
    await waitFor(() => expect(screen.getByTestId('overall-verdict')).toHaveTextContent('INTEGRITY VERIFIED'))
    expect(screen.getByText(/key archive pending/i)).toBeInTheDocument()
    // Pending here is an additive/optional corroboration, not a failure — copy reassures.
    const kt = document.body.textContent ?? ''
    expect(kt).toMatch(/extra check/i)
    expect(kt).toMatch(/normal/i)
    expect(document.body.textContent).not.toMatch(/NOT in the archive|key NOT/i) // no red key state
  })

  it('persists across reload (F5): restores + re-checks the record; "Validate another" clears it (AC-100)', async () => {
    // A record loaded earlier in this tab — what a reload reads back.
    sessionStorage.setItem('kysigned-verify-record', JSON.stringify({ name: 'bundle.pdf', b64: btoa('%PDF') }))
    render(<VerifyPage verify={async () => verdict()} confirm={async () => ({})} />)
    // restored + verified on mount, with no manual upload
    await waitFor(() => expect(screen.getByTestId('overall-verdict')).toHaveTextContent('INTEGRITY VERIFIED'))
    expect(screen.queryByText('Drag the signing record PDF here')).toBeNull()
    // "Validate another document" clears the persisted record
    fireEvent.click(screen.getByRole('button', { name: /validate another document/i }))
    expect(screen.getByText('Drag the signing record PDF here')).toBeInTheDocument()
    expect(sessionStorage.getItem('kysigned-verify-record')).toBeNull()
  })

  it('the "Upload a signing record" button reserves a >=44px tap target (UX-003 / F-visual)', () => {
    render(<VerifyPage verify={async () => verdict()} />)
    const btn = screen.getByRole('button', { name: 'Upload a signing record' })
    // jsdom does not compute Tailwind px, so assert the reserved min-height utility
    // (maps to min-height:44px). The design-validation sweep verifies the rendered px.
    expect(btn.className).toContain('min-h-[44px]')
  })

  it('renders each assurance dimension state VERBATIM — no UI relabel (F-020 cross-surface parity)', async () => {
    // The engine-parity harness (parity.test.ts) compares ENGINE outputs; F-020 slipped through
    // because the divergence was a DISPLAY-layer relabel (the web rendered a genuine `inconclusive`
    // state as `pending`, while the CLI/toolkit printed `inconclusive`). Lock the rendered word to
    // the model state so a future relabel of any dimension fails here.
    await uploadWith(verdict({ signers: [signer({ assurance: { keyProvenance: 'confirmed', timestampDurability: 'pending', keyValidity: 'inconclusive' } })] }))
    await waitFor(() => expect(screen.getByTestId('overall-verdict')).toBeInTheDocument())
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/Key validity window:\s*inconclusive/i) // shown verbatim, matching CLI/toolkit
    expect(text).toMatch(/Timestamp durability:\s*pending/i)
    expect(text).not.toMatch(/Key validity window:\s*pending/i) // the retired relabel hack must stay gone
  })
})
