import { domainToCheck, domainWarningMessages, type DomainWarning } from '../lib/signerDomainWarnings'

/**
 * F-3.9 (#113) — the per-signer heads-up under an address field: advice, never
 * a block. Wraps at any width (a long domain breaks inside the line rather than
 * pushing the row wider than a phone screen).
 */
export function SignerDomainWarning({ address, name, warnings }: { address: string; name: string; warnings: DomainWarning[] }) {
  const domain = domainToCheck(address)
  if (!domain || warnings.length === 0) return null
  return (
    <div
      data-testid="signer-domain-warning"
      role="status"
      className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 space-y-1 min-w-0 max-w-full [overflow-wrap:anywhere]"
    >
      {domainWarningMessages(warnings, { domain, name }).map((m) => (
        <p key={m}>{m}</p>
      ))}
    </div>
  )
}
