/**
 * F-35.4 — the operator-console internal-identity matcher.
 *
 * The operator console's exclude-internal toggle (F-35.1) hides the operator's
 * own data. A record is "internal" when its envelope is `internal_test` OR its
 * creator identity matches one of these configured rules. This module is that
 * identity predicate and nothing else.
 *
 * A rule is one of three forms, matched case-insensitively against the (trimmed,
 * lower-cased) email:
 *   - **exact email**        `volinskey@gmail.com`  — matches that address only
 *   - **whole domain**       `@kychee.com`          — matches every mailbox there
 *   - **domain-scoped glob** `redteam-*@kysigned.com` — a local-part prefix at one
 *                                                       domain; `*` never crosses `@`
 *
 * The rule list is a public `[both]` mechanism (`KYSIGNED_INTERNAL_IDENTITIES`);
 * kysigned.com's concrete list is `[service]` config in the private deploy. An
 * **empty** list matches nobody, so a fresh fork's toggle excludes only
 * internal_test envelopes until the fork configures its own identities (AC-192).
 */

/** Turn a `prefix*@domain` glob into an anchored regex; `*` matches within the
 *  local part only (`[^@]*`), so it never spans the `@`. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^@]*');
  return new RegExp(`^${escaped}$`);
}

export function isInternalIdentity(
  email: string | null | undefined,
  rules: readonly string[],
): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0 || at === e.length - 1) return false; // not a well-formed address → never internal
  const domain = e.slice(at + 1);

  for (const raw of rules) {
    const rule = raw.trim().toLowerCase();
    if (!rule) continue;
    if (rule.startsWith('@')) {
      if (domain === rule.slice(1)) return true; // whole-domain
    } else if (rule.includes('*')) {
      if (globToRegExp(rule).test(e)) return true; // domain-scoped glob
    } else if (rule === e) {
      return true; // exact email
    }
  }
  return false;
}
