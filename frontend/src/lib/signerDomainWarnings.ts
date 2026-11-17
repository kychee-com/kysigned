/**
 * F-3.9 (#113, DD-87) — the editor's live heads-up about a signer's email
 * DOMAIN: "cannot receive email", "disposable address", "no sender protection".
 *
 * Advice only: nothing here ever delays or disables Send. Only the part after
 * `@` is sent (`GET /v1/signer-domain-check?domain=`), and never for an address
 * that is malformed or carries a `+` (F-3.2a refuses those anyway): a third
 * party's full address never travels in a URL. A failed or slow call shows
 * nothing. Answers are kept per domain and looked up by the field's CURRENT
 * value, so a late answer for a value the field no longer holds is never shown.
 */
import { useCallback, useRef, useState } from 'react'
import { apiGetPublic } from './api'
import { isValidEmail } from './validateEmail'

export type DomainWarning = 'cannot_receive' | 'disposable' | 'no_sender_protection'

const KNOWN: ReadonlySet<string> = new Set(['cannot_receive', 'disposable', 'no_sender_protection'])

/** The domain to check for an address, or null when the address must not be checked. */
export function domainToCheck(address: string): string | null {
  const v = address.trim()
  if (!isValidEmail(v)) return null
  const at = v.lastIndexOf('@')
  if (v.slice(0, at).includes('+')) return null
  return v.slice(at + 1).toLowerCase()
}

/** Ask the service about ONE domain. Null when the call failed (show nothing, ask again later). */
export async function fetchDomainWarnings(domain: string): Promise<DomainWarning[] | null> {
  try {
    const r = await apiGetPublic<{ warnings?: unknown }>(`/v1/signer-domain-check?domain=${encodeURIComponent(domain)}`)
    if (!r || !Array.isArray(r.warnings)) return null
    return r.warnings.filter((w): w is DomainWarning => typeof w === 'string' && KNOWN.has(w))
  } catch {
    return null
  }
}

/** The reference wording (F-3.9), with the domain and the signer's name filled in. */
export function domainWarningMessages(warnings: DomainWarning[], o: { domain: string; name: string }): string[] {
  const name = o.name.trim()
  const who = name || 'this signer'
  const whose = name ? `${name}’s` : 'this signer’s'
  return warnings.map((w) => {
    switch (w) {
      case 'cannot_receive':
        return `${o.domain} can’t receive email. Check the spelling of this address.`
      case 'disposable':
        return `This looks like a temporary email address. It may stop working before ${who} signs.`
      case 'no_sender_protection':
        return `${o.domain} doesn’t publish email security settings. If ${whose} signature is refused, they may need their email administrator’s help.`
    }
  })
}

/**
 * Per-page state: `check(address)` when a field loses focus (or a row appears
 * with an address already in it); `warningsFor(address)` when rendering.
 */
export function useSignerDomainWarnings() {
  const [byDomain, setByDomain] = useState<Record<string, DomainWarning[]>>({})
  const asked = useRef(new Set<string>())

  const check = useCallback((address: string) => {
    const domain = domainToCheck(address)
    if (!domain || asked.current.has(domain)) return
    asked.current.add(domain)
    void fetchDomainWarnings(domain).then((warnings) => {
      if (warnings === null) {
        asked.current.delete(domain) // not remembered: a later check may ask again
        return
      }
      setByDomain((prev) => ({ ...prev, [domain]: warnings }))
    })
  }, [])

  const warningsFor = useCallback(
    (address: string): DomainWarning[] => {
      const domain = domainToCheck(address)
      return domain ? byDomain[domain] ?? [] : []
    },
    [byDomain],
  )

  return { check, warningsFor }
}
