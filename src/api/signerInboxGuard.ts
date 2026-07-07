/**
 * signerInboxGuard — reject same-inbox / plus-alias signer sets at envelope
 * creation (F-3.2a, #96; AC-88 + AC-89).
 *
 * The per-signer identity model binds each signer to their own forward,
 * authenticated by that signer's provider DKIM (F-3.4 / F-6.4). Two signers on
 * one inbox forward from the same address with the same DKIM identity, so the
 * operator cannot tell their signatures apart; and a plus-alias signer's forward
 * replies from the PRIMARY address, so it may never match the invited alias.
 * Both are forbidden at creation rather than guessed at afterward.
 */

import { firstUnsupportedNameChar } from '../pdf/nameFont.js';

export interface SignerAddressIssue {
  code: 'plus_alias' | 'same_inbox' | 'unrenderable';
  /** Client-facing 400 message naming the offending / colliding / unrenderable value. */
  message: string;
}

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

function splitEmail(email: string): { local: string; domain: string } {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 0) return { local: trimmed, domain: '' };
  return { local: trimmed.slice(0, at), domain: trimmed.slice(at + 1) };
}

/** True when the local part carries a plus-address tag (`name+tag@domain`). */
export function isPlusAlias(email: string): boolean {
  return splitEmail(email).local.includes('+');
}

/** The primary address a plus-alias collapses to (drops the `+tag`). */
function primaryOf(email: string): string {
  const { local, domain } = splitEmail(email);
  if (!domain) return local;
  return `${local.split('+')[0]}@${domain}`;
}

/**
 * Normalize an address to its underlying INBOX identity for collision detection:
 * lowercase + trim, drop a `+tag`, and — for gmail / googlemail only — strip dots
 * from the local part and unify the domain to `gmail.com`.
 */
export function normalizeInbox(email: string): string {
  const { local: rawLocal, domain: rawDomain } = splitEmail(email);
  if (!rawDomain) return rawLocal;
  let local = rawLocal.split('+')[0]!; // drop +tag
  let domain = rawDomain;
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, ''); // gmail ignores dots in the local part
    domain = 'gmail.com'; // googlemail.com === gmail.com
  }
  return `${local}@${domain}`;
}

/** Per-signer rendered text fields the cover / per-signer PDF draws (embedded font). */
const RENDERED_FIELDS: ReadonlyArray<
  ['address' | 'name' | 'organisation', 'email' | 'name' | 'on_behalf_of']
> = [
  ['address', 'email'],
  ['name', 'name'],
  ['organisation', 'on_behalf_of'],
];

/**
 * Inspect a submitted signer set. Returns the FIRST blocking issue, or null when
 * every signer is renderable and a distinct primary inbox.
 *   (0) any rendered field (address / name / organisation) the cover font can't
 *       encode → `unrenderable` (#101 — would otherwise 500 in cover assembly)
 *   (a) any plus-alias address → `plus_alias` (even a single, lone signer)
 *   (b) two addresses on one inbox → `same_inbox`
 */
export function checkSignerAddresses(
  signers: Array<{ email: string; name?: string; on_behalf_of?: string }>,
): SignerAddressIssue | null {
  // (0) Every rendered signer field must be drawable by the cover's embedded font
  // (#110 — Latin/Greek/Cyrillic/Hebrew/Arabic). A character outside that coverage
  // (CJK, etc.) would tofu / throw deep in cover assembly (an opaque 500 — #101), so
  // reject it up front with a clean, named 400 pointing at the FAQ. Cyrillic/Hebrew/
  // Greek/Arabic signer names now PASS (were rejected pre-#110).
  for (const s of signers) {
    for (const [label, key] of RENDERED_FIELDS) {
      const value = s[key];
      if (!value) continue;
      const bad = firstUnsupportedNameChar(value);
      if (bad) {
        return {
          code: 'unrenderable',
          message:
            `Signer ${label} "${value.trim()}" contains a character we can't put on ` +
            `the signed document (${bad.char} ${bad.label}). We support Latin, Greek, ` +
            `Cyrillic, Hebrew, and Arabic names; Chinese, Japanese, and Korean aren't ` +
            `supported yet. See our FAQ on supported languages.`,
        };
      }
    }
  }
  // (a) Plus-aliases are rejected outright — even a single signer (AC-89).
  for (const s of signers) {
    if (isPlusAlias(s.email)) {
      return {
        code: 'plus_alias',
        message:
          `Signer address "${s.email.trim()}" is a plus-alias. Use the primary address ` +
          `"${primaryOf(s.email)}" instead — kysigned needs each signer's primary mailbox so ` +
          `their signature can be told apart.`,
      };
    }
  }
  // (b) Same-inbox collision among the (now alias-free) addresses (AC-88).
  const seen = new Map<string, string>(); // normalized inbox → first raw address
  for (const s of signers) {
    const key = normalizeInbox(s.email);
    const prior = seen.get(key);
    if (prior !== undefined) {
      return {
        code: 'same_inbox',
        message:
          `Signers "${prior.trim()}" and "${s.email.trim()}" resolve to the same inbox. ` +
          `Each signer must use a distinct email address.`,
      };
    }
    seen.set(key, s.email);
  }
  return null;
}
