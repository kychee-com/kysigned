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
and how they combine into PROVEN / FAILED.

## Run it

```bash
# from the kysigned repo root (tsx is a devDependency):

# verify a single bundle — prints a report, exits 0 (PROVEN) / 1 (FAILED)
node --import tsx scripts/verification-tools/verify-independent.mjs <bundle.pdf>

# self-test against every committed fixture — exits 0 if all reproduce the expected
# verdict, non-zero (naming the offending fixture/check) otherwise
node --import tsx scripts/verification-tools/self-test.mjs
```

Both are fully **offline**. (The committed RFC 3161 `.tsr` token verifies offline; the
Bitcoin anchor and the public key-archive lookup are additive ONLINE steps, below,
that never change the PROVEN / FAILED verdict.)

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
   - A signer is **PROVEN** iff all four hold.
5. The bundle is **PROVEN** iff there are no structural errors, the fingerprint
   matches, and every signer is PROVEN.

### Additive online steps (never gate the verdict)

- **Bitcoin anchor (OpenTimestamps)** — upgrade `proofs/signer-<n>.ots` against the
  public OTS calendars + a Bitcoin block source; "confirmed" shows the block height
  and time. Pending/offline never fails the verdict.
- **Key-archive presence** — look up `(domain, selector, key)` in the public DKIM
  archive (`archive.prove.email`); "confirmed" shows the registration time. Absent /
  unreachable shows "pending", never red, and never gates the verdict.

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
