# kysigned verification toolkit (independent reproduction)

This folder is a **self-contained, independent reproduction** of the kysigned bundle
verifier. It re-orchestrates the documented verification algorithm itself and does
**not** import the canonical engine (`src/bundle/verify.ts`, `verifyWeb.ts`,
`verifyCli.ts`, `hashCheck.ts`). So when its verdict matches the web and CLI
verifiers on the same bundle (the F-10.10 / AC-107 three-way parity harness), that
agreement is a genuine cross-implementation check that the algorithm is completely
and correctly specified — not the same code run twice.

It exists so an independent party — a forker, an auditor, or an AI agent — can
reproduce every verification procedure on their own and run it against the committed
fixtures, with no dependency on kysigned's running service.

## What it reuses vs. reproduces

It uses the **same third-party-vetted primitives** the canonical verifier uses — no
self-rolled crypto:

| Primitive | Used for |
|-----------|----------|
| `mailauth` | DKIM signature verification |
| `pkijs` + `@noble/hashes` + a public Bitcoin source | RFC 3161 / OpenTimestamps verification |
| `node:crypto` | SHA-256 |
| `pdf-lib` (via the format helpers `extract` + `assembleCanonicalPdf`) | embedded-file extraction; deterministic canonical-PDF assembly |

The **format helpers** (`src/bundle/extract.ts`, `src/pdf/assembleCanonicalPdf.ts`,
`src/bundle/evidenceOrder.ts`) define the bundle *layout* — how files are embedded,
how a signer's canonical PDF is assembled, the evidence order for the fingerprint.
An independent verifier following the spec produces byte-identical results from
these, so they are shared, not reinvented. What this toolkit reproduces independently
is the **verdict orchestration**: the fingerprint hashing, the per-signer
reconstruction and hash compares, the original-document hash `A`, the intent check,
and how they combine into the assurance tier (INTEGRITY VERIFIED / FAILED offline).

## Run it

```bash
# from the kysigned repo root (tsx is a devDependency):

# verify a single bundle — prints a report + tier, exits 0 (any non-FAILED tier) / 1 (FAILED)
node --import tsx scripts/verification-tools/verify-independent.mjs <bundle.pdf>

# self-test against every committed fixture — exits 0 if all reproduce the expected
# verdict, non-zero (naming the offending fixture/check) otherwise
node --import tsx scripts/verification-tools/self-test.mjs
```

Both run **fully offline**: the toolkit settles the four hard checks (DKIM, document
match, intent line, embedded `.tsr` timestamp) from the bundle alone, and when the
bundle embeds the archive's **signed observation statement**
(`proofs/signer-<n>-statement.jws`), it also settles the key-provenance gate offline by
verifying that statement against the archive's pinned statement keys and matching the
signer's exact key. Such a record reaches **PROVIDER KEY CONFIRMED** with no network at
all. A record without a statement caps at **INTEGRITY VERIFIED** offline, exactly as
before. **PROVEN (DURABLE)** additionally needs a confirmed Bitcoin anchor, which a
deliberately-offline reproduction does not fetch; the web verifier and the reference CLI
settle that. Under the same conditions all three surfaces agree on the same tier for a
genuine bundle (the AC-152 parity) and on FAILED for a tampered one.

## The algorithm, step by step

Given a signing-record (bundle) PDF, the toolkit:

1. **Extract** the embedded files: `document-original.pdf`, `cover-<n>.pdf`,
   `signer-<n>.eml`, `proofs/signer-<n>.{tsr,ots}`, `keys.json`, `VERIFY-README.txt`.
2. **Original-document hash `A`** = `SHA-256(document-original.pdf)`. This is the one
   shared document; every signer's reconstruction is checked against it.
3. **Bundle fingerprint** = `SHA-256` over the embedded evidence concatenated in the
   documented order, then confirm that value appears rendered on a PDF page (the
   "verification code" printed on the signature page). A mismatch means a byte was
   altered after assembly.
4. For **each** `signer-<n>.eml`:
   - **DKIM** — verify the signature against the embedded `keys.json` with `mailauth`
     (full body hash, no `l=` length tag, From-domain aligned).
   - **Document matches (and `A`)** — reconstruct that signer's canonical PDF
     `P_i = cover-<n>.pdf ++ document-original.pdf` with the deterministic assembler,
     and require the forwarded PDF attachment to be **byte-identical** to it. Because
     every signer reconstructs against the *same* `document-original.pdf`, this also
     proves they all signed the same document `A`.
   - **Intent line** — the first non-empty line of the forward (text/plain, or the
     text/html part for HTML-only forwards) is exactly `I sign this document`.
   - **Timestamp** — the RFC 3161 `.tsr` token commits to `SHA-256(signer-<n>.eml)`.
   - **Embedded statement (when present)** — verify `proofs/signer-<n>-statement.jws`
     against the archive's pinned statement keys, require issuer `archive.zk.email`,
     and require its record to carry this signer's exact `(domain, selector, key)`
     from a live-DNS observation. Confirms key provenance offline; the F-32.4 window
     (signing time at or before last-observed-live plus 90 days) is recomputed here
     from scratch.
   - A signer with all four hard checks reaches **INTEGRITY VERIFIED**, and **PROVIDER
     KEY CONFIRMED** when its embedded statement verifies; any hard-check failure is
     **FAILED**.
5. The bundle's tier is the weakest signer's tier: **INTEGRITY VERIFIED** iff there are no
   structural errors, the fingerprint matches, and every signer is INTEGRITY VERIFIED;
   **FAILED** otherwise.

### The online legs (settled by the web verifier / CLI, not this offline toolkit)

This toolkit is offline (AC-114), so it does not fetch these; the web and CLI verifiers
do.

- **Provider-key gate (live archive fallback)** — for a record WITHOUT an embedded
  statement: look up the bundle's EXACT `(domain, selector, key)` in the public DKIM
  archive (`archive.zk.email`, which fetches the provider's DNS itself). An exact match
  against a live-DNS observation confirms provenance → **PROVIDER KEY CONFIRMED**. A
  DIFFERENT key recorded for that `(domain, selector)` is a forged key and makes the
  verdict **FAILED** — this step CAN change the verdict; it is not merely additive.
  Unreachable / not-yet-recorded is `pending` and never fails.
- **Bitcoin anchor (OpenTimestamps)** — confirm `proofs/signer-<n>.ots` in a real Bitcoin
  block; with a signing time within the key's live-observed window (last-observed-live
  plus grace) this reaches **PROVEN (DURABLE)**. Pending/offline never fails the verdict.

kysigned is **not** in the trust set: the verdict comes only from the embedded
evidence (the signer's email provider via DKIM, the public key archives, the
timestamp authorities, and SHA-256 / RSA math).

## Replicating it in another language

Everything above is standard: parse PDF embedded files, SHA-256, concatenate in the
documented order, verify DKIM (RFC 6376), verify an RFC 3161 token (RFC 3161) and an
`.ots` proof (the OpenTimestamps format), and a first-line string match. The one
kysigned-specific definition you must follow exactly is the **canonical assembly** —
how `cover-<n>.pdf` and `document-original.pdf` are merged into the PDF a signer
signs — and the **evidence order** for the fingerprint. Both are in `src/pdf/` and
`src/bundle/evidenceOrder.ts`; match them and your verdict will match this toolkit's.
