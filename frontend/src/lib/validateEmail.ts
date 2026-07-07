/**
 * Lightweight email-format check used to gate the sign-in screen's "Send
 * sign-in link" action — not a full RFC 5322 parser, just enough to stop an
 * empty or obviously-malformed address from triggering a magic-link request.
 */
export function isValidEmail(value: string): boolean {
  const v = value.trim();
  // local-part @ domain . tld — each segment is one+ chars with no space or @.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
