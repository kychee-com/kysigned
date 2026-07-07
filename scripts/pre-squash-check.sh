#!/usr/bin/env bash
# scripts/pre-squash-check.sh
#
# Pre-squash gate for the Phase 14 private→public flip.
# Per kysigned-spec F17.11.1–F17.11.10 + plan DD-41.
#
# Run this IMMEDIATELY before `git checkout --orphan v1.0.0-public`. Each check
# below is a hard gate: ANY non-zero exit aborts the flip.
#
# Run from within the public `kysigned` repo working tree (not kysigned-private).
#
# Output goes to stdout + stderr and is intended to be captured to a log file
# in kysigned-private/evidence/pre-squash-check-<date>.log.
#
# Human operator (Barry) reviews the output line-by-line and signs off
# explicitly before initiating the squash + public-flip per F17.11.9.
#
# EXIT CODE: 0 if all checks pass, 1 if any fail. Failed checks are printed
# with enough context to trace back to the file + line that triggered.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAILED=0

pass() {
  echo "PASS: $1"
}

fail() {
  echo "FAIL: $1" >&2
  FAILED=$((FAILED + 1))
}

# check <label> <grep_pattern> [grep_args] [exclude_pathspecs]
#
# Scans TRACKED files for a leak pattern. `-I` makes grep skip binary files, so a
# byte-coincidence inside a binary fixture (e.g. a DER-encoded TSA cert) is never
# mistaken for a text match. `exclude_pathspecs` (space-separated git pathspecs
# like ':!path') drops files that MUST embed a literal value to exercise
# provider-specific behavior — after the PII scrub those hold only synthetic
# local-parts, so excluding them is accurate scoping, not suppression.
check() {
  local label="$1"
  local grep_pattern="$2"
  local grep_args="${3:-}"
  local exclude_pathspecs="${4:-}"

  # Use git ls-files to only scan tracked files (gitignored files don't get committed).
  local matches
  matches=$(cd "${ROOT}" && git ls-files -- . ${exclude_pathspecs} | xargs grep ${grep_args} -I -lE "${grep_pattern}" 2>/dev/null | grep -v '^scripts/pre-squash-check.sh$' || true)

  if [[ -n "${matches}" ]]; then
    fail "${label}"
    echo "  Hits in:" >&2
    echo "${matches}" | sed 's/^/    /' >&2
    echo "  Pattern: ${grep_pattern}" >&2
  else
    pass "${label}"
  fi
}

echo "=== kysigned pre-squash check (per F17.11 / DD-41) ==="
echo "Running in: ${ROOT}"
echo "Git commit: $(cd "${ROOT}" && git rev-parse HEAD 2>/dev/null || echo 'not a git repo')"
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

# ─── F17.11.1 — Canary addresses + wallet ─────────────────────────────────
echo "[F17.11.1] Canary addresses + KMS wallet scan"
echo "(values pulled from AWS Secrets Manager — requires aws profile + kysigned/canary-* secrets)"
if command -v aws &>/dev/null; then
  for secret in kysigned/canary-signature-registry-address \
                kysigned/canary-evidence-key-registry-address \
                kysigned/canary-wallet-address; do
    addr=$(aws secretsmanager get-secret-value --secret-id "${secret}" \
            --query SecretString --output text --profile kychee --region us-east-1 2>/dev/null || echo "")
    if [[ -z "${addr}" ]]; then
      echo "  (no ${secret} — skipping; expected if pre-Phase-13)"
      continue
    fi
    if cd "${ROOT}" && git ls-files | xargs grep -lF "${addr}" 2>/dev/null | grep -q .; then
      fail "F17.11.1 canary-address leak: ${secret} value found in tracked files"
    else
      pass "F17.11.1 ${secret} — zero hits"
    fi
  done
else
  echo "  (aws CLI not installed — skipping; run manually before flip)"
fi
echo

# ─── F17.11.2 — AWS identifiers ───────────────────────────────────────────
echo "[F17.11.2] AWS account IDs, Secrets Manager paths, IAM role ARNs, KMS key IDs"
check "F17.11.2 AWS account ID 472210437512"     "472210437512"
check "F17.11.2 AWS Secrets Manager paths"       "(aws secretsmanager|secret-id [\"']?(x402|kysigned|run402|agentdb)/)" "-i"
check "F17.11.2 IAM role ARNs"                   "arn:aws:iam::[0-9]+:role/"
check "F17.11.2 KMS key IDs/aliases"             "arn:aws:kms:[^ \"']+:[0-9]+:key/|alias/kychee-"
echo

# ─── F17.11.3 — Private-repo URLs + internal doc references ──────────────
echo "[F17.11.3] Private-repo URLs + internal-only references"
check "F17.11.3 kysigned-private references"     "kysigned-private"
check "F17.11.3 file:../<internal> deps"         'file:\.\./(kysigned-private|run402)'
check "F17.11.3 .kychee.internal hostnames"      "\\.kychee\\.internal"
check "F17.11.3 internal doc paths (consultations)" "docs/consultations/"
echo

# ─── F17.11.4 — Internal monorepo dependencies ────────────────────────────
echo "[F17.11.4] Internal monorepo dependency manifest scan"
for pkg in package.json mcp/package.json; do
  if [[ -f "${ROOT}/${pkg}" ]]; then
    if grep -qE '"(@kychee|@run402|@x402)/[^"]+"' "${ROOT}/${pkg}"; then
      # These scoped packages are PUBLISHED on the public npm registry, so a public
      # repo depending on them is fine: @run402/sdk, @x402/fetch, @x402/evm,
      # @x402/extensions. Anything ELSE under @kychee/@run402/@x402 would be an
      # unpublished internal package and must not ship — flag only those.
      internal=$(grep -oE '"(@kychee|@run402|@x402)/[^"]+"' "${ROOT}/${pkg}" \
        | grep -vE '"@run402/sdk"|"@x402/(fetch|evm|extensions)"' || true)
      if [[ -n "${internal}" ]]; then
        fail "F17.11.4 internal (unpublished) @kychee/@run402/@x402 dep in ${pkg}"
        echo "${internal}" | sed 's/^/    /' >&2
      fi
    fi
    if grep -qE '"file:' "${ROOT}/${pkg}"; then
      fail "F17.11.4 file:.. local dep in ${pkg}"
      grep -E '"file:' "${ROOT}/${pkg}" | sed 's/^/    /' >&2
    fi
    if grep -qE '"link:' "${ROOT}/${pkg}"; then
      fail "F17.11.4 link: local dep in ${pkg}"
    fi
  fi
done
if [[ ${FAILED} -eq 0 ]]; then
  pass "F17.11.4 manifest scan"
fi
echo

# ─── F17.11.5 — PII in fixtures ──────────────────────────────────────────
echo "[F17.11.5] PII scan on fixtures + test data"
# The provider-normalization guards (signerInboxGuard / signupGrant / signerEditing)
# MUST embed literal gmail.com + googlemail.com to test gmail's dot / +alias /
# domain-unification rules; their local-parts are synthetic (no real PII), so they
# are excluded from the Gmail scan rather than broken.
check "F17.11.5 real Gmail addresses"        "[a-zA-Z0-9._-]+@gmail\\.com" "-r" \
      ":!src/api/signerInboxGuard.test.ts :!src/api/signupGrant.test.ts :!src/api/signerEditing.test.ts"
check "F17.11.5 real Outlook addresses"      "[a-zA-Z0-9._-]+@(outlook|hotmail|live)\\.com" "-r"
check "F17.11.5 real iCloud addresses"       "[a-zA-Z0-9._-]+@(icloud|me|mac)\\.com" "-r"
check "F17.11.5 real Yahoo addresses"        "[a-zA-Z0-9._-]+@(yahoo|ymail)\\.com" "-r"
check "F17.11.5 volinskey personal"          "volinskey"
check "F17.11.5 barry@kychee.com"            "barry@kychee\\.com"
echo

# ─── F17.11.6 — Required public artifacts present ────────────────────────
echo "[F17.11.6] Required public artifacts"
for f in LICENSE LEGAL.md README.md \
         scripts/pre-squash-check.sh; do
  if [[ -f "${ROOT}/${f}" ]]; then
    pass "F17.11.6 present: ${f}"
  else
    fail "F17.11.6 MISSING: ${f}"
  fi
done
echo

# ─── F17.11.7 — Local AI-harness state ────────────────────────────────────
echo "[F17.11.7] Local AI-harness state exclusion"
# These are gitignored local AI-harness dirs. They may EXIST on disk (expected on
# any working machine); the gate condition is that NO file under them is TRACKED,
# since only tracked files get committed + published. Test git-tracking, not the
# working-tree, so a developer's local .claude/.agent never trips the gate.
harness_state_ok=1
for path in .claude .cursor .agent memory; do
  if cd "${ROOT}" && git ls-files -- "${path}/" | grep -q .; then
    fail "F17.11.7 ${path}/ has tracked files (must be gitignored + never committed)"
    harness_state_ok=0
  fi
done
# A subdirectory CLAUDE.md is operator state; a root-level CLAUDE.md is fine (project docs).
if cd "${ROOT}" && git ls-files | grep -E '(^|/)CLAUDE\.md$' | grep -v '^CLAUDE.md$' | grep -q .; then
  fail "F17.11.7 CLAUDE.md tracked in a subdirectory (operator state, not project docs)"
  harness_state_ok=0
fi
if [[ ${harness_state_ok} -eq 1 ]]; then
  pass "F17.11.7 AI-harness state"
fi
echo

# ─── F17.11.8 — git remotes sanity ────────────────────────────────────────
echo "[F17.11.8] git remote sanity"
# The PUSH TARGET is `origin`, and it must be the public kychee-com/kysigned repo.
# Operators legitimately keep OTHER remotes (e.g. a `private` remote for the
# private sibling repo), so validate `origin` specifically rather than flagging
# every configured remote.
origin_url=$(cd "${ROOT}" && git remote get-url origin 2>/dev/null || echo "")
if [[ -z "${origin_url}" ]]; then
  echo "  (no 'origin' remote configured — skipping; set it before pushing the public repo)"
elif echo "${origin_url}" | grep -qE "github\\.com[:/]kychee-com/kysigned(\\.git)?$"; then
  pass "F17.11.8 origin → kychee-com/kysigned (${origin_url})"
else
  fail "F17.11.8 origin remote is not kychee-com/kysigned: ${origin_url}"
fi
echo

# ─── Summary ──────────────────────────────────────────────────────────────
echo "=== Summary ==="
if [[ ${FAILED} -eq 0 ]]; then
  echo "ALL CHECKS PASS. Safe to proceed with Phase 14 squash per DD-41."
  echo "Human sign-off (Barry) still required per F17.11.9 before running:"
  echo "  git checkout --orphan v1.0.0-public"
  echo "  git add -A && git commit -m 'kysigned v1.0.0'"
  echo "  git push --force origin main"
  echo "Then run this script AGAIN (F17.11.10 post-squash re-verify) before flipping visibility."
  exit 0
else
  echo "${FAILED} CHECK(S) FAILED. Phase 14 ABORTED."
  echo "Fix every failing check, re-run this script, get clean output, then"
  echo "get human sign-off per F17.11.9."
  exit 1
fi
