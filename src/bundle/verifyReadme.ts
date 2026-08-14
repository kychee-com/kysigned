/**
 * VERIFY-README.txt — the documented verification algorithm embedded in every
 * bundle (F-8.1 / F-10.3 / F-10.5). Plain text so it reads in any viewer; it
 * points at the open-source verifier and states the trust set exactly (DKIM keys +
 * archives + TSA/OTS + math; kysigned is NOT in the trust set). NOT part of the
 * F-8.2 fingerprint (it is a static doc, not evidence).
 *
 * Deterministic given the envelope id + verifier URL.
 */
import type { BundleEnvelopeInput } from './types.js';

export function buildVerifyReadme(envelope: BundleEnvelopeInput, verifierBaseUrl: string): Uint8Array {
  const base = verifierBaseUrl.replace(/\/+$/, '');
  const text = `kysigned: SIGNING RECORD VERIFICATION
========================================

This PDF is a self-contained signing record for envelope:
  ${envelope.id}
  "${envelope.documentName}"

It opens like any normal PDF. There is NO digital signature, NO certificate, and
NO "validity unknown" warning, by design. Its trustworthiness does not come from
this file being signed; it comes from the evidence embedded INSIDE it, which anyone
can re-verify independently, offline, forever, even if kysigned no longer exists.

WHAT IS EMBEDDED
----------------
  document-original.pdf   The original document D, embedded once. SHA-256 of this
                          file is the original-document hash A.
  cover-<n>.pdf           Each signer's own cover page (page 1 of what they signed),
                          embedded separately so each signer's PDF is reconstructible.
  signer-<n>.eml          Each signer's original provider-signed email (the
                          forward whose first line is "I sign this document",
                          with the document attached). Byte-complete.
  proofs/signer-<n>.tsr   RFC 3161 timestamp token over SHA-256(signer-<n>.eml).
  proofs/signer-<n>.ots   OpenTimestamps (Bitcoin) proof over the same hash.
  proofs/signer-<n>-statement.jws
                          When present: the public archive's OWN signed statement
                          of its live-DNS observation of this signer's key (a
                          compact JWS, exactly as issued), with the operator's
                          RFC 3161 + OpenTimestamps proofs over those exact bytes
                          as -statement.tsr / -statement.ots.
  keys.json               The DKIM public keys observed for each signer, when
                          they were observed, and their public-archive
                          cross-reference (archive.zk.email).
  VERIFY-README.txt       This file.

HOW TO VERIFY (the algorithm)
-----------------------------
For each signer-<n>.eml:
  1. DKIM-verify the email against keys.json (and live DNS / the public archive
     when online). Require a full-body hash (bh=) with NO length tag (l=), and
     require From-domain alignment.
  2. Reconstruct this signer's canonical PDF = cover-<n>.pdf ++ document-original.pdf
     (the deterministic assembler) and require the forwarded attachment to be
     BYTE-IDENTICAL to that reconstruction. Every signer reconstructs against the
     SAME document-original.pdf, so this also proves they all signed the same
     document A (= SHA-256 of document-original.pdf).
  3. Confirm the first body line is exactly "I sign this document"
     (case-insensitive).
  4. Validate proofs/signer-<n>.tsr against the TSA chain and proofs/signer-<n>.ots
     against the Bitcoin chain (upgrading a pending OpenTimestamps proof when
     online) to establish the signing time T.
  5. Key-provenance gate. When proofs/signer-<n>-statement.jws is present, verify it
     OFFLINE: check the JWS signature against the archive's published statement keys
     (pinned in the verifier; also at
     https://archive.zk.email/.well-known/dkim-archive-jwks.json), require issuer
     "archive.zk.email", and require its record to carry this signer's exact
     (domain, selector, key). A verified statement IS the archive's attestation of its
     own live-DNS observation; no network is needed and the archive need only have
     existed at signing. Otherwise, look up (domain, selector) in the public archive
     and confirm the EXACT embedded key is the one the archive observed live (the
     archive fetches the provider's DNS itself). A DIFFERENT key for that
     (domain, selector) is a forged key and FAILS the verdict; an unreachable archive
     or a not-yet-recorded key is "pending" and does not fail. When confirmed, the
     durable tier also requires the signing time T to be at or before the key's
     last-observed-live time (plus a grace margin)
     -- a one-sided UPPER bound (a T before the key was first seen is fine).
  => The verdict is one of four assurance tiers, not a yes/no:
     - FAILED: a check above did not hold, or the archive published a different key than
       the one embedded (a forged key).
     - INTEGRITY VERIFIED: steps 1-4 hold offline, but the key's provenance is not yet
       confirmed (no embedded statement, archive pending). Internally consistent and
       unaltered, but not yet proven to be the provider's own key.
     - PROVIDER KEY CONFIRMED: plus step 5 confirmed the exact key was the provider's
       real published key (offline via the embedded statement, or online).
     - PROVEN (DURABLE): plus the OpenTimestamps proof is Bitcoin-block-confirmed and
       agrees with the RFC 3161 token, and T is within the key's live-observed lifetime
       window (last-observed-live plus grace).
     A record with an embedded statement reaches PROVIDER KEY CONFIRMED fully offline;
     a genuine record rises to PROVEN (DURABLE) once its Bitcoin anchor settles; a
     forged key FAILS. Forging a provider-key confirmation would take the operator and
     the archive colluding at the Bitcoin-pinned signing moment, and even that stays
     permanently falsifiable (an invented key exists nowhere else; a provider's genuine
     key of an era is recoverable from any two real emails it signed).

Then recompute the verification code: SHA-256 over document-original.pdf, each
signer-<n>.eml, the proofs/ files, and keys.json, concatenated in that order,
and compare it to the verification code printed on the signature page. A mismatch
means a byte was altered after assembly.

THE TRUST SET (who you must trust)
----------------------------------
  - The signer's email provider (it DKIM-signed the forward).
  - The public DKIM key archives + DNS.
  - The RFC 3161 TSA and the Bitcoin blockchain (for the timestamps).
  - SHA-256 and RSA/Ed25519 (the math).
kysigned is NOT in this set. We assemble the bundle; we do not vouch for it.

TOOLING
-------
  Web verifier:  ${base}/verify   (drag this PDF in; runs fully in your browser)
  Reference CLI + source:  the open-source kysigned repository.
`;
  return new TextEncoder().encode(text);
}
