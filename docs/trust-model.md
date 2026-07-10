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
because the two have opposite, complementary weaknesses. The TSA is *instant* and is the
format courts and eIDAS already recognise, but you must trust the authority not to lie
about the time. The Bitcoin anchor is *trustless* and cannot be back-dated, but it is
"pending" for the first few hours until a block confirms. So OpenTimestamps backstops a
misbehaving TSA (the chain can't be back-dated), and the TSA covers the window where the
OTS proof is not yet confirmed. They establish the same fact through two independent trust
roots — one institutional (a CA-backed authority), one physical (Bitcoin proof-of-work) —
so an attacker must defeat *both*, while a verifier can rely on *either* alone. Both are
free, so the default carries both (kysigned-spec F-6.6). The published technical page
mirrors this at length under "Why two timestamp anchors."

## 2. What is proven / not proven

**Proven** (cryptographically, from the signing record alone):

- A specific mailbox sent the intent line "I sign this document".
- The exact document that was signed (the forwarded attachment is SHA-256
  byte-identical to the canonical PDF in the signing record).
- The approximate time of signing (two independent timestamp anchors).
- That the DKIM key used was the provider's real published key at that time.

**NOT proven:**

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
  a later-published key is used to forge a historical "signature". *Defence:* every
  signature is joined to a **timestamp-in-window** check — the key must appear in
  the public archive within a window covering the signed email's anchored time, so
  a key forged or leaked *after* the signing window fails the join. A key
  compromised *during* its valid window is indistinguishable from legitimate use —
  the same residual risk as any PKI.
- **Malicious operator.** kysigned itself tries to fabricate, alter, or suppress a
  signature. *Defence:* it **cannot forge** (no provider private key) and **cannot
  swap the document** (the signer's DKIM signature byte-binds the attachment); at
  most it can refuse to process or fail to deliver. A signing record, once delivered, is
  wholly beyond operator reach — there is nothing central to tamper with.
- **Compromised timestamp authority (TSA).** A single RFC 3161 TSA colludes or is
  breached to back- or post-date. *Defence:* timestamps are **dual** — an RFC 3161
  token *and* an OpenTimestamps Bitcoin anchor. The Bitcoin anchor can't be
  back-dated, so it backstops a misbehaving TSA. Very recent OpenTimestamps proofs
  are "pending" until a block confirms; the TSA covers that gap.
- **Provider key-rotation race.** The provider rotates its DKIM key between signing
  and verification, so live DNS no longer has the key. *Defence:* the verifier
  never needs live DNS — the **key is embedded in the signing record** (`keys.json`),
  captured at receipt and corroborated against the archive. The operator also
  records the observed key with its own timestamp at receipt, so a later rotation
  changes nothing.
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
