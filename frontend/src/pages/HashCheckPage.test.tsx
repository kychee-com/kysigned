/**
 * HashCheckPage.test.tsx (F-25) — the /hashcheck original-document confirmation tool.
 * Asserts the two-input flow renders a MATCH / MISMATCH result with the guarantee
 * label, and the fully-client-side framing. The match ENGINE is unit-tested in the
 * kysigned package (hashCheck.test.ts); this asserts the page wiring.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { HashCheckPage } from './HashCheckPage'
import type { HashCheckResult } from 'kysigned-verify'

const A = 'a'.repeat(64)
const bundleMatch: HashCheckResult = {
  kind: 'bundle', match: true, guarantee: 'byte-exact', originalSha256: A, foundSha256: A,
  reason: 'Byte-exact match: the original document is identical to the document embedded in the signing record.',
}
const signReqMatch: HashCheckResult = {
  kind: 'sign-request', match: true, guarantee: 'content-level', originalSha256: A, foundSha256: A,
  reason: 'Content match: the document inside this sign-request is the supplied original.',
}
const mismatch: HashCheckResult = {
  kind: 'bundle', match: false, guarantee: 'byte-exact', originalSha256: A, foundSha256: 'b'.repeat(64),
  reason: 'Mismatch: the document embedded in the signing record is not the supplied original.',
}

function uploadBoth(result: HashCheckResult) {
  render(<HashCheckPage check={async () => result} />)
  const orig = screen.getByLabelText(/original document/i) as HTMLInputElement
  const art = screen.getByLabelText(/signing record or sign-request/i) as HTMLInputElement
  fireEvent.change(orig, { target: { files: [new File([new Uint8Array([1])], 'orig.pdf', { type: 'application/pdf' })] } })
  fireEvent.change(art, { target: { files: [new File([new Uint8Array([2])], 'artifact.pdf', { type: 'application/pdf' })] } })
}

describe('HashCheckPage — original-document confirmation (F-25)', () => {
  it('byte-exact MATCH against a signing record shows both SHA-256 hashes (no leaked "A" label)', async () => {
    uploadBoth(bundleMatch)
    await waitFor(() => expect(screen.getByText(/document matches/i)).toBeInTheDocument())
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/byte-exact/i)
    expect(text).toMatch(/sha-256/i)
    expect(text.includes(A)).toBe(true)
    expect(text).not.toMatch(/document a\b/i) // the internal variable name must not leak into copy
  })

  it('content-level MATCH shows the inner content hash that was compared, labelled a content hash', async () => {
    uploadBoth(signReqMatch)
    await waitFor(() => expect(screen.getByText(/document matches/i)).toBeInTheDocument())
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/content match/i)
    expect(text).toMatch(/content hash/i) // labelled as a content hash, not a raw file hash / not "A"
    expect(text.includes(A)).toBe(true) // the compared hash is shown
    expect(text).not.toMatch(/document a\b/i)
  })

  it('MISMATCH is shown clearly, never a false match', async () => {
    uploadBoth(mismatch)
    await waitFor(() => expect(screen.getByText(/does not match/i)).toBeInTheDocument())
  })

  it('states it runs entirely in the browser — files never leave the device', () => {
    render(<HashCheckPage />)
    const text = document.body.textContent ?? ''
    expect(/in your browser/i.test(text)).toBe(true)
    expect(/never leave/i.test(text)).toBe(true)
  })
})
