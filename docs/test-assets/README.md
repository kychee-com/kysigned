# Test assets: verifier fixtures and trial documents

Two families live in this folder. The synthetic `sample-*` fixtures (first section)
exercise the verifier against a known oracle, tampered variants included. The
`acme-*` set ([below](#the-acme-set-trial-documents-and-a-real-signed-record)) holds
the two watermarked trial contracts plus a genuine signed record from the live
kysigned.com flow, for trying `/verify` and `/hashcheck` with real evidence.

## Evidence-bundle fixtures (Red Team verifier set)

These committed PDFs let you exercise the kysigned **verifier** end-to-end without
creating a live envelope. Drop each one on the deployed verifier at
**https://kysigned.com/verify** (or run it through the reference CLI verifier) and
confirm the verdict matches the table below.

They are generated from the **real** bundle assembler (`scripts/gen-test-assets.mjs`)
with a genuine RSA DKIM keypair (signed via `mailauth`) and a **real RFC-3161
timestamp token** from freeTSA over `sha256(.eml)` — so the valid bundle's timestamp
check verifies **offline** (the TSA-signed time needs no network; no Bitcoin-
confirmation wait). A real (pending) OpenTimestamps proof is also embedded; the
verifier accepts the `.tsr` alone for the timestamp check.

> **All data is DUMMY.** Signers are `alice@redteam.kysigned.test` /
> `bob@redteam.kysigned.test`, signing domain `redteam.kysigned.test`, creator
> `creator@redteam.kysigned.test`. No real person or mailbox is involved. The
> `redteam.kysigned.test` domain is non-routable (`.test` TLD) — these forwards
> were never actually sent.

## The 2-signer scenario

`sample-bundle.pdf` is a completed **Mutual NDA** envelope with two signers off one
shared document **D**:

- **Signer 1 — Alice Example** (`alice@redteam.kysigned.test`): an individual signer.
- **Signer 2 — Bob Example** (`bob@redteam.kysigned.test`): signs **on behalf of
  "Acme Corporation"** (exercises the on-behalf-of authority affirmation, F-22).

Each signer forwarded their own canonical PDF `P_i = cover_i ++ D`; the bundle
embeds `document-original.pdf` (D) once, `cover-1.pdf` / `cover-2.pdf`,
`signer-1.eml` / `signer-2.eml`, the timestamp `proofs/`, and `keys.json`.

## Expected verdicts

| File | Expected verdict | The broken check (what to look for) |
|------|------------------|-------------------------------------|
| `sample-bundle.pdf` | **PROVEN** | Both signers proven; bundle fingerprint matches the value printed on the signature page; identities/intent read from the `.eml`. |
| `sample-bundle-tampered-doc.pdf` | **FAILED** | `attachment` — the embedded `document-original.pdf` was swapped, so each signer's reconstruction `cover_i ++ D` no longer byte-matches their `.eml` attachment. |
| `sample-bundle-tampered-eml.pdf` | **FAILED** | `dkim` (+ `timestamp`) for signer 1 — one byte flipped inside the DKIM `b=` signature value breaks the signature, and `sha256(.eml)` no longer matches the stamped hash. |
| `sample-bundle-tampered-timestamp.pdf` | **FAILED** | `timestamp` for signer 1 — the proof commits to the wrong hash (not `sha256(.eml)`). |
| `sample-bundle-tampered-signer-email.pdf` | **FAILED** | `dkim` for signer 1 — the public key in `keys.json` is a different key than the one that signed, so the signature does not verify. |
| `sample-bundle-tampered-rendered-page.pdf` | **PROVEN** | None — the signature page's **displayed name** was changed, but the verifier derives every verdict from the embedded `.eml`, not the rendered page (AC-28e). The identity still resolves to `alice@redteam.kysigned.test`. |
| `sample-bundle-tampered-cover-substitution.pdf` | **FAILED** | `attachment` for signer 1 — a **different cover** is shipped than the one Alice signed, so `wrongCover ++ D` ≠ her `.eml` attachment. This is the operator-forgery defense: you cannot show one signer a different cover. |
| `sample-bundle-l-tag.pdf` | **FAILED** | `dkim` for signer 1 — the DKIM signature carries a length-limited `l=` body tag, which the verifier rejects (a partial-body signature would let an attacker append unsigned bytes). |

A PROVEN verdict means: exit code 0 / "PROVEN" in the CLI; a green "Verified"
banner on the web verifier with every per-signer check passing. A FAILED verdict
names the broken check in the per-signer reasons.

## `/hashcheck` assets (original-document confirmation, F-25)

Three more committed PDFs let you exercise the **`/hashcheck`** tool — "is my
original document the one carried inside this artifact, untouched?" — for both the
final package and a sign-request:

| File | What it is |
|------|------------|
| `sample-document-original.pdf` | The original document **D**, standalone (the `/hashcheck` "left" input). Byte-identical to the `document-original.pdf` embedded in `sample-bundle.pdf`. |
| `sample-sign-request.pdf` | A real sign-request `P_i = cover-1 ++ D` — the canonical PDF signer 1 received attached to their signing-request email. |
| `sample-sign-request-tampered-doc.pdf` | Same cover, a **different** document inside (the negative case). |

Expected `/hashcheck` results (drop `sample-document-original.pdf` as the original):

| Artifact dropped on the right | Result |
|-------------------------------|--------|
| `sample-bundle.pdf` | **MATCH (byte-exact)** — `A = SHA-256(original)` equals the bundle's embedded `document-original.pdf`. |
| `sample-sign-request.pdf` | **MATCH (content)** — the document inside the sign-request is the original (a content match, not byte-identical: prepending the cover re-serializes the document). |
| `sample-sign-request-tampered-doc.pdf` | **MISMATCH** — a different document is inside. |

Validated offline by `src/bundle/testAssets.test.ts`. Regenerate **without** a full
bundle rebuild (offline, derived from `sample-bundle.pdf`):

```bash
node --import tsx scripts/gen-sign-request-assets.mjs
```

(A full `gen-test-assets.mjs` run also emits these three, byte-consistent with the
bundle it generates.)

## Regenerating

These assets are validated by `src/bundle/testAssets.test.ts` (the oracle + a
permanent regression net — it runs the real verifier over each committed asset and
asserts the verdict above, fully offline). If the bundle format changes, regenerate:

```bash
node --import tsx scripts/gen-test-assets.mjs   # needs network for the freeTSA + OTS stamp
```

then re-run the regression test (`node --test --import tsx src/bundle/testAssets.test.ts`).

## The acme set: trial documents and a real signed record

The `sample-*` fixtures above are fully synthetic (dummy domain, dummy signers). The
`acme-*` files are the complementary set: two watermarked trial contracts you can
actually send through a kysigned instance, plus a **genuine** completed signing
record for trying `/verify` and `/hashcheck` against real production evidence.

> The signed bundle is real: creator and signer are both `info@kysigned.com` (the
> kysigned.com service address; no personal mailbox involved). Its embedded signer
> `.eml` carries TWO DKIM signatures, the aligned `d=kysigned.com` key plus Amazon's
> `d=amazonses.com` co-signature, which makes it the permanent regression fixture
> for multi-signature mail (`src/bundle/signedFixture.test.ts` pins the web and Node
> verdicts together on it, offline).

| File                                  | What it is                                                                                                          | Use it for                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `acme-approval.pdf`                   | Trial contract template 1: the ACME Approval Form 42-B                                                              | Your first trial envelope (see the repo README)                       |
| `acme-anvil-waiver.pdf`               | Trial contract template 2: the ACME Anvil Liability Waiver. Byte-identical to the document inside the signed bundle | Trial envelopes; the `/hashcheck` original (left input)               |
| `acme-anvil-waiver-sign-request.pdf`  | The sign-request package (cover ++ document) exactly as a signer received it                                        | `/hashcheck` right side (content-level match)                         |
| `acme-anvil-waiver-signed-bundle.pdf` | A genuine completed signing record from the live kysigned.com flow. Creator and signer are both `info@kysigned.com` | `/verify` (expect PROVEN (DURABLE) online, INTEGRITY VERIFIED offline); `/hashcheck` right side (byte-exact match) |
| `sample-bundle-forged-key.pdf`        | A #136 self-minted-key FORGERY: a DKIM-valid bundle whose embedded key is claimed for `gmail.com/20251104` but is the attacker's, not gmail's real published key | `/verify` (INTEGRITY VERIFIED offline; FAILED online via the archive gate — provider-key mismatch) |

Expected results:

| Drop this                                   | On           | Expected result                                                                             |
| ------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------- |
| `acme-anvil-waiver-signed-bundle.pdf`       | `/verify`    | PROVEN (DURABLE) online, INTEGRITY VERIFIED offline. One signer, `info@kysigned.com`, signing domain `kysigned.com`; fingerprint matches |
| `sample-bundle-forged-key.pdf`              | `/verify`    | INTEGRITY VERIFIED offline (self-consistent forgery, honestly NOT proven), then FAILED online: the archive gate finds gmail.com/20251104's real key ≠ the embedded self-minted key → provider-key mismatch (#136 forgery defense) |
| `acme-anvil-waiver.pdf` + the signed bundle | `/hashcheck` | MATCH (byte-exact). The original equals the bundle's embedded `document-original.pdf`       |
| `acme-anvil-waiver.pdf` + the sign-request  | `/hashcheck` | MATCH (content). The document inside the sign-request is the original                       |
| `acme-approval.pdf` + the signed bundle     | `/hashcheck` | MISMATCH. A different document is inside                                                    |

**Regenerating the acme files.** `build-acme-approval.mjs` and
`build-acme-anvil-waiver.mjs` rebuild the two trial documents offline (`node
docs/test-assets/build-acme-approval.mjs`), and `build-acme-anvil-waiver-sign-request.mjs`
re-derives the sign-request from the committed bundle (offline, stays
byte-consistent with it; run with `node --import tsx`). One caution: pdf-lib stamps
fresh dates, so a regenerated `acme-anvil-waiver.pdf` is a NEW document and will no
longer byte-match the document inside the committed signed bundle. Keep the
committed file for the byte-exact demo. The signed bundle itself is minted through
the live signing flow by operator tooling; a forker gets an equivalent by completing
any envelope on their own instance and keeping the emailed record.
