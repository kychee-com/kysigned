/**
 * #155 — the ONE projection of a create-envelope result that kysigned-mcp
 * returns, shared by create_envelope, the create_envelope_x402 first 201, and
 * the spending-intent replay — so first success and replay carry the same
 * envelope-result fields by construction.
 *
 * Explicit allowlist, NOT a passthrough: the MCP keeps its deny-by-default
 * posture (undocumented fields — including anything payment-proof-shaped the
 * API might ever add — never reach agent context), while the documented safe
 * fields (delivery, spam_notice, the one-time callback_secret, suggestion)
 * are guaranteed through. Mirrors src/api/envelopeResultFields.ts in the root
 * package; the lockstep test in contract.test.ts fails if the lists drift.
 */
export const ENVELOPE_RESULT_FIELDS = [
  'envelope_id',
  'status',
  'document_hash',
  'status_url',
  'verify_url',
  'signing_links',
  'spam_notice',
  'delivery',
  'callback_secret',
  'suggestion',
] as const;

/** Allowlist-project a create-envelope result body; absent fields stay absent. */
export function projectEnvelopeResult(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ENVELOPE_RESULT_FIELDS) {
    if (d[k] !== undefined) out[k] = d[k];
  }
  return out;
}
