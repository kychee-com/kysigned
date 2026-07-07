/**
 * disposableDomains — exclude throwaway / disposable email domains from the
 * new-account trial grant (F-13.6c / AC-95).
 *
 * The list is the community-maintained `disposable-email-domains` package (MIT)
 * — a public, many-eyes list, NOT hand-rolled (per the no-self-rolled-setup
 * rule). Updates flow in by bumping the dependency. A disposable-domain signup
 * is still a valid account that may still PURCHASE credits; it just receives no
 * freebie, so scripted "spin up N throwaway inboxes for N×$1" abuse is removed
 * while magic-link confirmation already proves mailbox control for real domains.
 *
 * The JSON list is statically imported so the run402 bundle inlines it
 * (resolveJsonModule + bundler resolution); a Set gives O(1) lookup.
 */
import disposableList from 'disposable-email-domains';

const DISPOSABLE: ReadonlySet<string> = new Set(
  (disposableList as string[]).map((d) => d.toLowerCase()),
);

/** True when the email's domain is a known disposable / throwaway provider. */
export function isDisposableEmailDomain(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 && DISPOSABLE.has(domain);
}
