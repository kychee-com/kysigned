# kysigned — Trust & Threat Model

This is the canonical trust write-up for kysigned. The public technical
page (`/how-it-works-technical.html`) is the published version of this material. It states exactly what a
kysigned signature proves, what it does not, who you have to trust, and how the
system behaves under attack.

A kysigned signature is an ordinary email that the signer's own provider
cryptographically signs (a DKIM signature). kysigned collects that signed email,
anchors its time, and packages everything into a self-contained PDF — the
**signing record** — that anyone can re-verify with public math and public
archives, with no reliance on kysigned.

The best-known objection to DKIM-as-evidence is deliberate rotate-and-publish
(Matthew Green's proposal, implemented by tools like `dkim-rotate`): providers
publish their old private keys so that bare DKIM signatures on old mail become
deniable. kysigned assumes exactly that world. Evidence is anchored at signing
time, so a key published later cannot forge or deny a record sealed before
publication; what rotate-and-publish kills is after-the-fact DNS checking, which
this design never uses. See "Leaked or rotated-published DKIM key" and "Provider
key-rotation race" in §3.

---

## 1. The trust set

A kysigned signature is verifiable using only public inputs. To trust a verdict
you rely on:

1. **The signer's email provider** — it produces the DKIM signature that *is* the
   signature. Its private key is what makes the email unforgeable.
2. **The public DKIM-key archives** (e.g. `archive.prove.email`) — independent,
   third-party-timestamped records of which key a provider published, and when.
3. **The public timestamp authorities** — RFC 3161 TSAs and the Bitcoin chain via
   OpenTimestamps — which anchor *when* a signature existed.
4. **The mathematics** — RSA/DKIM verification and SHA-256, run by you, locally.

**kysigned (the operator) is NOT in the trust set.** A correct verdict never
requires trusting that kysigned behaved honestly, stayed online, or even still
exists. The whole evidence set lives inside the signing record PDF in your inbox.

**Why two timestamp anchors (item 3).** Each signature is timestamped twice over
`sha256(raw .eml)` — an RFC 3161 TSA token *and* an OpenTimestamps Bitcoin anchor —
because the two are *complementary, not interchangeable*. The TSA is *instant* and is the
format courts and eIDAS already recognise, but you must trust the authority not to lie
about the time. The Bitcoin anchor is *trustless* and cannot be back-dated, but it is
"pending" for the first few hours until a block confirms. They play different roles in
the verdict rather than substituting for each other: a signing record reaches its top
assurance tier, **PROVEN (DURABLE)**, only once the Bitcoin anchor has *confirmed in a
block* and its time does not contradict the TSA token — that block confirmation is what
makes the signing time un-back-datable. Until the block settles, the record rests on the
TSA alone and is graded one tier lower (a valid, but authority-trusted, time); and if the
two times contradict each other, the timestamp is treated as *inconclusive* rather than
durable. So the TSA covers the window where the OTS proof is not yet confirmed, and
Bitcoin is what ultimately backstops a misbehaving TSA — they establish the same fact
through two independent trust roots, one institutional (a CA-backed authority), one
physical (Bitcoin proof-of-work). Both are free, so the default carries both
(kysigned-spec F-6.6). The published technical page mirrors this at length under "Why two
timestamp anchors."

## 2. What is proven — the assurance tiers

A kysigned verdict is not a yes/no "PROVEN" stamp. It is one of four **assurance
tiers**, because "the signature math is internally consistent" and "the signing key was
genuinely the provider's" are different facts, established by different evidence — and
honesty means showing which one you actually hold:

- **FAILED** — a required check did not hold: the DKIM signature is invalid, the
  forwarded attachment is not SHA-256 byte-identical to the canonical PDF, the intent
  line is missing, no timestamp is present, or the public key archive publishes a
  *different* key for that domain/selector than the one embedded (an active forgery
  signal, see §3).
- **INTEGRITY VERIFIED** — every *offline* check holds: a valid DKIM signature, the
  attachment byte-identical to the canonical PDF, the intent line "I sign this document"
  present, and a timestamp token present. Anyone can reach this tier with no network. It
  proves the record is internally consistent and unaltered; on its own it does **not**
  yet prove the signing key was the provider's genuine key — the embedded key could be
  one an operator merely *claims* is the provider's.
- **PROVIDER KEY CONFIRMED** — additionally, the public DKIM-key archive confirms the
  **exact** key that signed was the provider's real published key. This is the step that
  turns "the math is consistent" into "the math is consistent *and* the key is
  authentic," and it is precisely what an offline check cannot establish alone.
- **PROVEN (DURABLE)** — additionally, the time is anchored durably: the OpenTimestamps
  proof is confirmed in a Bitcoin block (which cannot be back-dated) and agrees with the
  RFC 3161 token, and the signing time falls within the window during which the archive
  observed that key live. This is the strongest tier: authentic key, un-back-datable
  time, re-verifiable by anyone, forever.

A genuine record verified online reaches **PROVIDER KEY CONFIRMED** immediately and
**PROVEN (DURABLE)** once its Bitcoin anchor settles (typically a few hours after
signing). Offline, or while the archive and chain are still settling, that same genuine
record sits honestly at **INTEGRITY VERIFIED** — pending, never failed. The tiers never
weaken a real signature; they stop a forgery from borrowing the credibility of a real one.

**NOT proven** (at any tier):

- **Physical identity.** kysigned proves *mailbox control*, not who operated the
  mailbox. A compromised email account can produce a valid signature — exactly as
  a forged handwritten signature is "valid" if it fools the notary. This is the
  fundamental limit of every email- or device-based signature.
- **Legal enforceability.** That depends on jurisdiction and document type. A
  kysigned signature is at least a Simple Electronic Signature and is designed to
  meet the Advanced Electronic Signature (AES) properties under eIDAS Article 26;
  it is **not** a Qualified Electronic Signature (QES).

## 3. Threat model

Each item is a threat, then what stops it (and any residual risk).

- **Leaked or rotated-published DKIM key (the `dkim-rotate` model).** A provider's old private key leaks, or
  a later-published key is used to forge a historical "signature". *Defence:* an
  **anchored-time upper bound** on the key's recorded lifetime. The public archive records
  when each provider key was first and last seen; the durable timestamp fixes when the
  signature existed. If the anchored signing time is *later* than the key's recorded
  last-seen time (plus a grace margin), the signature cannot reach **PROVEN (DURABLE)** —
  which is exactly the retired-key / rotate-and-publish forgery. This is deliberately a
  one-sided *upper* bound: a signing time *earlier* than the archive first recorded the
  key is fine (a key is often observed only after it is already in use), so we never
  require a lower bound. *Known limitation:* the archive's public API does not label
  whether a recorded time came from its own live DNS observation or from an archival
  reconstruction (GCD key recovery from stored mail), so the bound consumes the times
  **as recorded**; an attacker who already holds a leaked provider private key could try
  to stretch a record's last-seen through the archive's recovery corpus. The defence for
  that residual lives on the archive side (upstream ask for per-source semantics:
  `zkemail/archive#46`); if the archive exposes them, this bound tightens to live
  observations only. A key compromised *during* its live window is indistinguishable
  from legitimate use — the same residual risk as any PKI.
- **Malicious operator (self-minted key forgery).** kysigned itself tries to fabricate a
  signature. It **cannot swap the document** (the signer's DKIM signature byte-binds the
  attachment) and holds **no provider private key** — but it *can* mint its own DKIM
  keypair, list the public half in the record's `keys.json`, and sign a fabricated email
  with the private half. That produces a DKIM signature that is *mathematically valid
  against the embedded key*, so the signature math alone does not catch it. *Defence:* the
  **key-provenance gate**. The embedded key is checked against the provider's real
  published key in the independent public archive: online, a self-minted key the provider
  never published does not match, and the verdict is **FAILED**; offline, where provenance
  cannot be confirmed, the record rises no higher than **INTEGRITY VERIFIED** and never
  claims the key was authentic. The honest tiers *are* the defence here — the old single
  "PROVEN" stamp hid this forgery behind a green verdict; the tiers make the difference
  between "the math checks out" and "the key is genuinely the provider's" visible. Beyond
  forgery, a malicious operator can still only refuse to process or fail to deliver; a
  signing record, once delivered, is wholly beyond operator reach.
- **Compromised timestamp authority (TSA).** A single RFC 3161 TSA colludes or is
  breached to back- or post-date. *Defence:* timestamps are **dual** — an RFC 3161
  token *and* an OpenTimestamps Bitcoin anchor — and the durable tier *requires* the
  Bitcoin anchor, which can't be back-dated. A back-dated TSA token that the chain
  contradicts does not yield **PROVEN (DURABLE)**: the contradiction is surfaced (the
  timestamp is graded *inconclusive*), not silently trusted. Very recent OpenTimestamps
  proofs are "pending" until a block confirms; until then the record rests on the TSA at
  a lower tier, never falsely elevated to durable.
- **Provider key-rotation race.** The provider rotates its DKIM key between signing
  and verification, so live DNS no longer has the key. *Defence:* the verifier never
  needs live DNS — the **key is embedded in the signing record** (`keys.json`), captured
  at receipt, and provenance is confirmed against the independent archive (which fetches
  providers' DNS itself and timestamps what it sees), not against volatile live DNS. A
  later rotation changes nothing: the archive's historical record still confirms the
  exact embedded key, and the anchored-time upper bound above still places signing within
  the key's recorded lifetime.
- **Replay / double-recording.** The same signed email is submitted twice, or two
  workers race to record it. *Defence:* recording is idempotent — a still-pending
  signer flips to `signed` exactly once, and a duplicate resolves to "already
  signed". Each signed email is unique and time-anchored, so it can't be
  re-presented as a different signing.
- **Oversize / quota abuse.** Huge documents, or a flood of envelopes, to exhaust
  resources or bounce delivery. *Defence:* envelope creation is **credit-gated**
  (spam is uneconomic), and a creation-time **size guard** rejects any envelope
  whose signing record would exceed the deliverability ceiling (with the math shown).
- **Stranger / bounce-channel abuse.** An attacker emails the signing mailbox, or
  probes it to learn envelope state. *Defence:* inbound is dropped unless it is a
  reply from a known envelope member; bounces never leak envelope state to
  non-members; executable attachments are never sent or accepted.
- **Mailbox compromise.** An attacker controls the signer's actual email account.
  *Defence:* **out of scope** — no e-signature product defends against a fully
  compromised signing credential (see §2). The signing record still records precisely
  *which* mailbox signed and *when*, which is the evidence a dispute turns on.

## 4. What the operator can see

Honesty about the operator's view: to assemble a signing record, kysigned necessarily
sees the **document content** and the **signing metadata** while an envelope is
active. This exposure is bounded by **ephemeral retention** — the working copy of
a document is deleted once the signing record is delivered (typically within hours; hard
cap 30 days). kysigned holds **no signing keys of any kind** — not for users and
not for "sealing" — so there is no signing secret to steal, and the signing record PDF
itself is unsigned (it carries an integrity *code*, not a certificate).

## 5. Forked instances stay independent

kysigned is Apache-2.0-licensed and self-hostable. A forked instance shares **no secret
and no central registry** with kysigned.com or any other instance. Each operator
runs under its own domain with its own infrastructure; trust still flows only
from the signer's provider, the public archives, the timestamp authorities, and
the math. A signing record produced by any instance verifies the same way, anywhere,
offline — because the trust set never included the operator.
