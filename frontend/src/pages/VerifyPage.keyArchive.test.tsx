/**
 * VerifyPage.keyArchive.test.tsx — F-10.8a (spec 0.77.0, #102, DD-85): the web
 * verifier's key lookups go through the operator's proxy, which may answer from
 * memory, so the page must ask the shared verifier core to retry fresh when a
 * remembered answer lacks the bundle's exact key. The core's own test cannot see
 * this wiring; this one pins it.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { keyArchiveCalls } = vi.hoisted(() => ({ keyArchiveCalls: [] as unknown[][] }))

vi.mock('kysigned-verify', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return {
    ...actual,
    confirmKeyArchiveWeb: vi.fn(async (...args: unknown[]) => {
      keyArchiveCalls.push(args)
      return {}
    }),
  }
})

import { VerifyPage } from './VerifyPage'

describe('VerifyPage — F-10.8a key-archive wiring (AC-309)', () => {
  it('asks the core to retry fresh, through the same-origin proxy', async () => {
    const verdict = {
      proven: true,
      tier: 'INTEGRITY_VERIFIED',
      fingerprint: { computed: 'a'.repeat(64), matchesPrinted: true },
      originalDocSha256: 'd'.repeat(64),
      signers: [
        {
          index: 1,
          proven: true,
          tier: 'INTEGRITY_VERIFIED',
          assurance: { keyProvenance: 'pending', timestampDurability: 'confirmed', keyValidity: 'pending' },
          email: 'alice@example.com',
          signingDomain: 'example.com',
          verbatimIntent: 'I sign this document',
          signingTimeSec: 1_780_000_000,
          originalDocSha256: 'd'.repeat(64),
          checks: { dkim: true, attachment: true, intent: true, timestamp: true, keyAuthenticity: 'pending-online' },
          bitcoinAnchor: { status: 'confirmed' },
          reasons: [],
        },
      ],
      errors: [],
    }
    render(<VerifyPage verify={async () => verdict as never} confirm={async () => ({})} />)
    const input = screen.getByLabelText('Upload a signing record PDF') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'b.pdf', { type: 'application/pdf' })] } })
    await waitFor(() => expect(keyArchiveCalls.length).toBe(1))
    expect(keyArchiveCalls[0]![1]).toEqual({ baseUrl: '', path: '/v1/key-archive', retryFresh: true })
  })
})
