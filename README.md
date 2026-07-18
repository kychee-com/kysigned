<p align="center">
  <img src="docs/kysigned-logo.png" alt="kysigned" width="120" height="120">
</p>

<h1 align="center">kysigned</h1>

<p align="center">
  <strong>E-signatures at $0.25 an envelope</strong> : simple, secure signing powered by your email.
</p>

kysigned uses **DKIM**, the cryptographic signature your email provider already puts on every message you send, as the signature itself. A signer forwards one email; the result is a self-contained **evidence bundle** (a single PDF) that anyone can verify on their own machine, even offline, even if this service disappears.

DKIM alone isn't durable evidence, so kysigned never relies on it alone: each signature is timestamped twice at receipt, and its DKIM key is pinned in a public timestamped archive. Later key rotation, or even a provider publishing its old private keys, can't retroactively forge or deny a signature (details: [docs/trust-model.md](docs/trust-model.md)).

## Quick Start

### 1. Sign a document right now (no setup)

Sign documents at [kysigned.com](https://kysigned.com). Buy credits, send. No install, no SDK.

### 2. Deploy your own

kysigned is a complete, self-hostable app: clone it, point it at your own [run402](https://run402.com) project (managed email + DB + compute), and you're operating your own instance. All run402 I/O goes through [`@run402/sdk`](https://www.npmjs.com/package/@run402/sdk).

```bash
git clone https://github.com/kychee-com/kysigned.git
cd kysigned
KYSIGNED_ALLOWED_CREATORS='you@example.com,*@example.org' run402 up --name my-kysigned
```

That command reads `run402.json`, creates or links a Run402 project, creates the
`forward-to-sign` and `notifications` mailboxes, sets generated runtime secrets,
runs the local build, deploys the database/site/function release, and verifies
the app. See [`docs/run402-cloud.md`](docs/run402-cloud.md) for the detailed
runbook and smoke-test checklist.

A forker following this path runs the identical public code on their own run402 project, under their own domain, and produces verifiable bundles end-to-end.

**Agent Native: drive day-to-day signing from any MCP agent.** Once your instance is live, the bundled MCP server (`kysigned-mcp`) exposes the signing operations, `create_envelope`, `check_envelope_status`, `list_envelopes`, `send_reminder`, `void_envelope`, against your endpoint (configurable via `KYSIGNED_ENDPOINT`, defaults to kysigned.com). Configure it in any MCP-capable agent (Claude, Cursor, …):

```json
{
  "kysigned": { "command": "npx", "args": ["kysigned-mcp"] }
}
```

Then ask: *"Send the attached PDF to alice@example.com for signature via kysigned."*

### Where does your instance live? (no domain needed on day 1)

kysigned deploys on [run402](https://run402.com), the same pattern as any other repo hosted there. You don't need to register a domain to get started:

- **Default (no domain):** your run402 project is reachable at a run402-issued subdomain like `<your-project>.run402.com`. Your dashboard, signing pages, and verify page all live there, no DNS to configure, no certificate to renew.
- **Bring your own domain (later):** register a domain (e.g., `lawyerxx.com`), point its DNS at run402 per the project settings, and run402 takes over TLS + CDN + routing. Existing signing emails keep working; new envelopes use the new domain.
- **Static information pages included:** `/faq`, `/pricing`, and `/how-it-works` are served from the same Run402 origin as the app, so the default clone path does not need a second marketing site.

The repo contains no hardcoded reference to a specific domain. References to `kysigned.com` here are illustrative, they refer to the canonical Kychee-operated instance.

### Operator configuration

An operator is configured entirely through environment / secrets, **no source edits**:

| Variable | Purpose |
|----------|---------|
| `KYSIGNED_ALLOWED_CREATORS` | comma-list of creator emails or exact-domain wildcards such as `you@example.com,*@example.org` allowed to send |
| `KYSIGNED_BILLING` | `hosted` to enable the prepaid-credit money-gate; unset = allowlist-gated |
| `KYSIGNED_UNSUBSCRIBE_MAILTO` | optional, the `List-Unsubscribe` contact on outbound mail |

`run402 up` generates and sets the Run402 substrate values:
`RUN402_PROJECT_ID`, `RUN402_SERVICE_KEY`, `RUN402_ANON_KEY`,
`RUN402_PUBLIC_ORIGIN`, `RUN402_MAILBOX_FORWARD_TO_SIGN_ID`,
`RUN402_MAILBOX_FORWARD_TO_SIGN_ADDRESS`, `RUN402_MAILBOX_NOTIFICATIONS_ID`,
and `RUN402_MAILBOX_NOTIFICATIONS_ADDRESS`. Migrations are declared in
`run402.json` and applied by the release.

### Branding, home page & pricing

This repository ships **generic, operator-free** content: a placeholder home hero, no
pricing page and no "Pricing" nav item, a generic footer, and no hardcoded domain. Your
own identity is injected at build time through a single JSON environment variable, so you
never edit source to rebrand:

| Variable | Purpose |
|----------|---------|
| `VITE_OPERATOR_CONFIG` | JSON string with your brand and home content. Fields: `brandName`, `companyName`, `companyUrl`, `contactEmail`, `showPricing` (adds the "Pricing" nav item), and `home` (`hero`, plus optional `comparison` and `audiences` marketing sections). See `frontend/src/config/operator.ts` for the full shape and the generic defaults. |

With no `VITE_OPERATOR_CONFIG` set, the SPA renders the generic defaults (a fork advertises
you, not the upstream). To customise, pass the variable into the frontend build:

```bash
VITE_OPERATOR_CONFIG='{"brandName":"Acme Sign","companyName":"Acme, Inc.","showPricing":true}' \
  npm run build --prefix frontend
```

### Static & legal pages

The passive pages in `frontend/public/` (`faq.html`, `how-it-works.html`,
`how-it-works-technical.html`) are plain HTML you can edit freely. The legal pages
(`terms.html`, `privacy.html`, `cookies.html`, `aup.html`, `dpa.html`) ship as **blank
placeholders**: replace them with your own before going live, since terms are specific to
each operator and jurisdiction. There is no pricing page in this repo; add one only if you
enable `showPricing` and want to link it.

### Sender access control

kysigned ships with a built-in **allowlist** (`allowed_senders`) so you decide exactly who may create envelopes from your instance. Set `KYSIGNED_ALLOWED_CREATORS` to a comma-list of exact emails and exact-domain wildcards such as `you@example.com,*@example.org`. Wildcards match only that domain, not subdomains. For local dev and tests the gate is off by default; `run402 up` fails fast when the required deployment secret is missing.

### Trial signature documents

Want to kick the tires before sending a real document? The repo ships two deliberately-silly trial forms in [`docs/test-assets/`](docs/test-assets/): the **ACME Approval Form 42-B** (`acme-approval.pdf`) and the **ACME Anvil Liability Waiver** (`acme-anvil-waiver.pdf`), both carrying a bold **TEST DOCUMENT, NOT LEGALLY BINDING** watermark. Use either as the first document in a freshly-deployed instance to exercise the forward-to-sign flow end-to-end. Regenerate at any time:

```bash
node docs/test-assets/build-acme-approval.mjs
node docs/test-assets/build-acme-anvil-waiver.mjs
```

## How signing works

1. A signer receives an email **from `forward-to-sign@<your-domain>`** with the document attached.
2. They **forward it back** and type **"I sign this document"** as the first line. No account, no app, no password.
3. Their email provider's **DKIM signature** on that forward *is* the signature, only the provider can produce it, so no one else can forge a message in their name.
4. kysigned verifies the DKIM signature, confirms the forwarded attachment is **byte-identical** to what was sent, **timestamps** the forwarded email, and records the signer.

When everyone has signed, every party receives one **evidence bundle**.

## The evidence bundle & verification

The bundle is a single PDF holding the document, a signature page, and **each signer's original DKIM-signed email**, plus the public keys and timestamps needed to check them. It's a clean, unsigned PDF (no certificate, no seal, it opens with no warnings) carrying a printed SHA-256 fingerprint over its evidence set.

Anyone can verify a bundle at `https://<your-domain>/verify` (drag-and-drop, fully client-side) or with the bundled CLI:

```bash
node bin/verify-bundle.mjs <bundle.pdf>
```

Verification runs **entirely on the verifier's own machine**, offline, and even if your instance no longer exists. **kysigned is not part of the trust set:** the proof rests on the signers' email providers (DKIM), the public key archives, the timestamp authorities, and the math. See [docs/trust-model.md](docs/trust-model.md) for the full trust set and threat model.

Want to try both tools right now, with nothing signed yet? [`docs/test-assets/`](docs/test-assets/) ships ready-made samples: drop `acme-anvil-waiver-signed-bundle.pdf` (a genuine signed record) on `/verify`, and pair `acme-anvil-waiver.pdf` with that bundle or with `acme-anvil-waiver-sign-request.pdf` on `/hashcheck` to confirm an original document. The folder also holds a full set of tampered bundles that must FAIL, each breaking one named check. [docs/test-assets/README.md](docs/test-assets/README.md) lists the expected verdict for every file, and [scripts/verification-tools/](scripts/verification-tools/) replicates every check independently of the app.

## Architecture

```
kysigned/
  src/
    api/            # envelope lifecycle, distribution, account + admin handlers
    api/signing/    # forward processing: DKIM verify, intent + attachment gates, reconciler
    bundle/         # evidence-bundle assembly + fingerprint + the verifier engine
    timestamp/      # RFC 3161 (TSA) + OpenTimestamps clients behind a TimestampProvider contract
    pdf/            # deterministic canonical PDF, cover page, signature page (pdf-lib)
    email/          # transport-agnostic EmailProvider + the HTML templates
    db/             # schema + data-access layer (runs over run402's HTTP SQL)
    integrations/   # run402 adapters (@run402/sdk email + HTTP SQL pool) + the route table
    functions/      # the run402 routed-HTTP entry + email-triggered durable work
  frontend/         # React + Vite + Tailwind: dashboard, signing review, /verify
  mcp/              # kysigned-mcp (agent surface)
  bin/              # verify-bundle.mjs (standalone CLI verifier)
```

## Tests

```bash
# Backend unit suite
npm run test:all

# Frontend
cd frontend && npx vitest run

# MCP
cd mcp && npm test

# Deployed e2e, set BASE_URL to a running instance
BASE_URL=https://your-instance npm run test:e2e
```

## Billing

**Hosted (kysigned.com):** **$0.25 per envelope**, flat, up to 20 signers. Creators buy prepaid credit packs by card, **$5 buys 20 envelopes**, and credits never expire. **Stripe** is the payment processor; card details never reach kysigned. The money-gate is config-gated (`KYSIGNED_BILLING=hosted`).

**Self-hosted (this repo):** you pay run402 for infrastructure (compute, email, DB). Gate who can create envelopes with the built-in `allowed_senders` allowlist, or wire your own billing using it as the authorization hook.

## Built on run402

kysigned runs **entirely** on [run402](https://run402.com): routed-HTTP functions for the API, email-triggered durable work for signing replies and bounces, run402's HTTP SQL for the database, and run402 mailboxes for email.

All run402 I/O **defaults to the [`@run402/sdk`](https://www.npmjs.com/package/@run402/sdk)**, the SDK owns the wire translation, so the app keeps no hand-maintained `snake_case` boundary adapters. The two raw-HTTP exceptions are documented and contained: the auth helpers call run402's `/auth/v1/*` endpoints directly (passing the project anon key), and the database pool wraps run402's HTTP SQL surface. Both map run402's `lower_snake_case` wire shape at the boundary.

### Business events, dashboard, and paging built in

Every deployment emits its business facts as run402 app events: `signature_completed`, `signer_declined`, `envelope_completed`, `envelope_undeliverable`, and `sweep_anomaly` from the two daily monitors. There is nothing to configure. Events land in your own project's feed, so you get an activity dashboard on your project page at console.run402.com, agent-readable catch-up via `run402 events --source app`, and optional Telegram paging through `run402 notifications` rules on your operator account.

Payloads carry opaque ids and counts only. No signer emails or names, no document names or content ever leave your deployment. Event emission is best-effort by design: if the events surface is unavailable, the signing flow is never affected.

## License

[Apache-2.0](LICENSE), the whole repository, with no per-file exceptions. Every dependency is permissive (MIT/Apache-2.0); there is no GPL or other copyleft anywhere in the tree, so forking and commercial use are unrestricted. See [LICENSES.md](LICENSES.md) for the dependency inventory and [LEGAL.md](LEGAL.md) for signature-validity disclaimers and jurisdictional limitations.
