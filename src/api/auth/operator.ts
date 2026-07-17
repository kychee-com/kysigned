/**
 * F-33.1 — operator authorization.
 *
 * An **operator** is a human running a kysigned instance (distinct from a creator
 * or a signer). Operator access reuses the creator session (F-18.1); the only
 * extra predicate is membership in an operator-config allowlist. This module is
 * that predicate and nothing else.
 *
 * The allowlist is a public `[both]` mechanism (`KYSIGNED_OPERATOR_EMAILS`);
 * kysigned.com's concrete list is `[service]` config set in the private deploy.
 * It is **fail-closed**: an empty/absent allowlist authorizes nobody, so a fresh
 * install and a fresh fork are locked until an operator email is configured
 * (AC-181). Matching is case-insensitive and trims surrounding whitespace.
 */
export function isOperator(
  email: string | null | undefined,
  operatorEmails: readonly string[],
): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return operatorEmails.some((e) => e.trim().toLowerCase() === normalized);
}
