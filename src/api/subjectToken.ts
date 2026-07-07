/**
 * F-5.2 — envelope routing token carried in the email subject (AC-11).
 *
 * The signing-request / reminder subject embeds `[ksgn-<envHex>]` (the envelope
 * UUID, dashes stripped, 32 hex chars). When a signer forwards the email their
 * client prepends "Fwd:"/"Fw:"/localized prefixes but keeps the rest, so the
 * fixed signing mailbox parses the token to route the forward back to its
 * envelope — no per-envelope addresses needed.
 */

const TOKEN_RE = /\[ksgn-([0-9a-f]{32})\]/i;

/** Build the subject token for an envelope UUID. */
export function buildEnvelopeToken(envelopeId: string): string {
  return `[ksgn-${envelopeId.replace(/-/g, '').toLowerCase()}]`;
}

/**
 * Extract the envelope UUID (dashed) from a subject, or null if no token is
 * present. Tolerant of forward prefixes and case (the regex is unanchored +
 * case-insensitive). Returns the FIRST token when more than one is present.
 */
export function parseEnvelopeToken(subject: string): string | null {
  const m = TOKEN_RE.exec(subject);
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
