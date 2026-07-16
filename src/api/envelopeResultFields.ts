/**
 * #155 — the canonical field list of the create-envelope 201 result body
 * (handleCreateEnvelope's success response in envelope.ts).
 *
 * kysigned-mcp returns create results through an explicit allowlist projection
 * (mcp/src/envelopeResult.ts) that MIRRORS this list; a lockstep test in the
 * MCP contract suite compares the two. Adding a field to the 201 body without
 * adding it here (and to the MCP projection) fails the suite instead of the
 * field being silently dropped from MCP results.
 */
export const CREATE_201_RESULT_FIELDS = [
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

export type Create201ResultField = (typeof CREATE_201_RESULT_FIELDS)[number];
