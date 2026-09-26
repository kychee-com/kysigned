# kysigned-mcp

Model Context Protocol (MCP) server for [kysigned](https://kysigned.com), DKIM-based e-signatures that produce a self-contained **evidence-bundle** PDF. Lets any MCP-compatible AI agent (Claude Desktop, Claude Code, Cursor, custom agents using the Anthropic SDK, etc.) send documents for signing, check status and verify the evidence bundle, without writing HTTP code.

## Web endpoint (no install)

A kysigned instance also serves MCP itself, over streamable HTTP, at `<instance>/mcp` (kysigned.com: `https://kysigned.com/mcp`). Nothing to install, no account and no key: point any MCP host that supports remote servers at that URL. In Claude Code:

```bash
claude mcp add --transport http kysigned https://kysigned.com/mcp
```

It has four tools:

- `explain_kysigned`: how signing works, every way to create and pay, tracking, and how to verify the bundle on your own machine. Free.
- `check_price`: the live per-envelope price, read from the x402 route's own challenge. Free.
- `check_envelope_status`: one envelope, with its tracking token (`ktt_…`). It accepts no API key.
- `create_envelope_x402`: the paid create, from the caller's own wallet, with x402 inside the tool call. The first call answers with the payment terms; an x402-capable MCP client (for example `@x402/mcp`) signs and calls again with the payment attached. The free preflight runs first, and a retry of the same request replays the envelope instead of paying twice.

Verifying a bundle is never a web tool: it stays on your machine (`npx kysigned verify <bundle.pdf>`, or this package's `verify_bundle`; for a person, `/verify` in a browser). The endpoint's server card is at `<instance>/.well-known/mcp/server-card.json`, its agent skills at `/.well-known/agent-skills/index.json`, the API catalog at `/.well-known/api-catalog`, and every way to authenticate at `/auth.md`.

Install this package (below) instead for the full tool set: creator API keys, listing, reminders and voids, or paying from a local run402 wallet.

## Install

```bash
npx -y kysigned-mcp
```

That's it. The first run launches the server over stdio, with no global install needed.

For permanent installation:

```bash
npm install -g kysigned-mcp
```

## Configure

The MCP server defaults to the hosted instance at `https://kysigned.com`. Two environment variables:

- `KYSIGNED_ENDPOINT`: point it at any kysigned deployment (your own self-hosted instance, staging, etc.).
- `KYSIGNED_AUTHORIZATION`: your creator **API key**. Sign in to the instance's dashboard and mint one at `/account/api-keys` (format `ksk_…`, shown exactly once). The key authorizes the creator envelope actions and nothing else; it cannot manage keys or the account.

```bash
KYSIGNED_ENDPOINT=https://kysigned.example.com \
KYSIGNED_AUTHORIZATION=ksk_your_key_here \
npx -y kysigned-mcp
```

`KYSIGNED_ENDPOINT` may include a trailing slash or a path prefix; it is normalized once at startup. If `KYSIGNED_AUTHORIZATION` is missing, the tools fail locally with actionable guidance instead of sending an unauthenticated request.

### Diagnostics (for humans configuring a host)

The bin is normally launched by an MCP host, but you can run it directly while wiring one up:

```bash
kysigned-mcp --version   # print the version
kysigned-mcp --help      # usage, env vars, and a host config example
kysigned-mcp doctor      # check the endpoint URL, auth presence, and /v1/health reachability
```

On normal startup a one-line masked banner (`kysigned-mcp <version> endpoint=… auth=ksk_…abcd`) is written to **stderr** so stdout stays clean for the MCP protocol.

## Wire it up to Claude Desktop

Edit your Claude Desktop MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "kysigned": {
      "command": "npx",
      "args": ["-y", "kysigned-mcp"],
      "env": { "KYSIGNED_AUTHORIZATION": "ksk_your_key_here" }
    }
  }
}
```

Restart Claude Desktop. The kysigned tools become available. Try asking *"Use kysigned to send the attached PDF to alice@example.com for signature."*

## Wire it up to Claude Code

```bash
claude mcp add kysigned -- npx -y kysigned-mcp
```

Then in any Claude Code session: *"List my recent kysigned envelopes."*

## Wire it up to Cursor

Cursor Settings → MCP → Add New Server:

- **Name:** kysigned
- **Command:** `npx`
- **Args:** `-y kysigned-mcp`

## Tools

The server exposes 8 tools: the five key-authenticated signing operations, a **no-key wallet pair** (`wallet_status`, `create_envelope_x402`) that pays per envelope from the host-local run402 wallet, and **`verify_bundle`**, which verifies a completed bundle on this machine with no key and no wallet. (Provisioning a new instance is a deploy-time concern, covered in the [main README](../README.md), not an MCP tool.) All take JSON arguments and return JSON results.

Each tool carries MCP **annotations** so a host can tell them apart: `check_envelope_status`, `list_envelopes`, `wallet_status` and `verify_bundle` are read-only; `create_envelope` and `send_reminder` send email (and create consumes a creator credit); `void_envelope` is **destructive** (irreversible cancellation); `create_envelope_x402` is also marked **destructive** because it spends real funds, so hosts that gate destructive tools will ask before it pays. A non-2xx API response or a transport failure comes back as an MCP result with `isError: true`, carrying the HTTP status and the stable error `code` (e.g. `[402] payment_required: …`), so agents branch correctly instead of treating a failure as success.

### `create_envelope`

Create a new signing envelope. Uploads a PDF (base64 or URL), defines signers, and returns the envelope ID + per-signer signing links.

**Arguments:**

```json
{
  "document_name": "Mutual NDA",
  "pdf_base64": "JVBERi0xLjQKJ...",
  "signers": [
    { "email": "alice@example.com", "name": "Alice" },
    { "email": "bob@example.com",   "name": "Bob"   }
  ],
  "message": "Please countersign our mutual NDA.",
  "callback_url": "https://your.app/webhooks/kysigned",
  "expiry_days": 14,
  "auto_close": true
}
```

Provide **exactly one** of `pdf_base64` or `pdf_url` (the server fetches `pdf_url` for you); the tool rejects zero or both locally before any network call. Optional fields: `message` (included in the signing-request email), `expiry_days` (omit for the operator default), `auto_close` (`false` = manual seal after all signers sign). Signer `email`s are validated locally and capped at 20. Every signer is notified at once.

`callback_url` (https only) arms a **signed completion webhook**: the create response includes `callback_secret` (`whs_…`, returned exactly once). At completion the instance POSTs `{ "type": "envelope.completed", … }` to your URL with `X-Kysigned-Signature: t=<unix>,v1=<hex hmac-sha256(callback_secret, "<t>." + rawBody)>`. Verify by recomputing the HMAC and rejecting stale timestamps. Deliveries retry (at-least-once), so make the receiver idempotent on `envelope_id`.

**Returns:** envelope ID, status URL, verify URL, list of `{ email, name, link, review_link }` per signer, `callback_secret` when a `callback_url` was supplied, and a spam notice for the sender to forward.

### `check_envelope_status`

Get the current status of an envelope by ID, including per-signer status and signing times.

```json
{ "envelope_id": "abc123-..." }
```

**No-key observer mode (F-30.7):** every create result carries `tracking.token` (`ktt_…`), an
envelope-scoped, READ-ONLY tracking token. Pass it as `tracking_token` and this tool needs no
`KYSIGNED_AUTHORIZATION` at all (the wallet-paid path polls through the same tool it created with):

```json
{ "envelope_id": "abc123-...", "tracking_token": "ktt_..." }
```

An explicit `tracking_token` wins over the ambient key. The token reads exactly its own envelope
(anything else 404s), every mutation refuses it (`auth_tracking_scope`), and it survives agent
restarts: the free preflight spending-intent replay returns the same create body, token included.

### `list_envelopes`

List the envelopes created by the authenticated creator (the key holder). No arguments.

```json
{}
```

### `send_reminder`

Resend the signing-request email to all pending signers on an active envelope.

```json
{ "envelope_id": "abc123-..." }
```

### `void_envelope`

Void an active envelope. All pending signers receive a cancellation notice. Voided envelopes cannot be revived.

```json
{ "envelope_id": "abc123-..." }
```

### `wallet_status` (no key needed)

Report the payer's payment readiness for wallet-paid creation: payer provenance (`payer_source` + public address + network, never key material), asset, on-chain balance, the live per-envelope price (read from the x402 route's own 402 challenge, never hardcoded), whether the balance covers it, and funding guidance when short. Read-only; never creates, spends, or initiates an on-chain transaction. No arguments.

```json
{}
```

If no payer exists it returns `configured: false` with the expected allowance path and the fixes (`run402 init`, or `KYSIGNED_RUN402_ALLOWANCE_PATH`). On an instance whose operator has not wired x402, it returns an error explaining the route is not payable.

**Payer sources (resolved once at startup, in precedence order):**

1. `KYSIGNED_RUN402_ALLOWANCE_PATH`: an **explicit run402 allowance file**. When set, it is the ONLY wallet consulted: an unreadable path fails closed (`payer_source_unavailable`) instead of falling back to the ambient wallet. Use this when a host manages per-agent allowance files (for example materialized from a secret store into a mode-0600 file).
2. An **opaque payment signer** injected programmatically by an embedder (`import { configurePaymentSigner } from 'kysigned-mcp'`-style hosting of the server module, before the first wallet tool call). The provider exposes only a public address plus signing operations, so key material can stay inside KMS/HSM/secret-broker boundaries. Mutually exclusive with the env path (`payer_source_conflict` if both are set).
3. The **ambient host-local run402 allowance** (`run402 init`), the default when nothing explicit is configured.

Readiness and payment share the one resolved payer: the address whose balance `wallet_status` reports is the address that signs the payment.

**Balance resilience:** the balance read retries with backoff and fails over across independent public RPC providers (the same lists the run402 SDK payment stack uses). If EVERY provider fails, the result is `balance_status: "unknown"` with a structured `balance_error` (`retryable: true`, `mutation_state: "not_started"`), never a fabricated zero and never an insufficient-funds verdict. `KYSIGNED_RPC_URL` optionally PREPENDS a private RPC; it is an advanced override, not required for ordinary reliability.

**Funding an underfunded wallet (fund → recheck → create):** an underfunded result carries a structured `next_actions[0]` of `type: "fund_wallet"`: destination address, CAIP-2 network, token contract/symbol/decimals, balance/price/shortfall in atomic AND exact decimal units, a concise human instruction, and an **ERC-681 payment URI requesting exactly the shortfall** (`ethereum:<token>@<chainId>/transfer?address=<wallet>&uint256=<shortfall>`) ready to render as a QR code. Flow: show the QR / send the URI → after funding, call `wallet_status` again to confirm `sufficient: true` → then `create_envelope_x402` (reusing your `idempotency_key` if this was a retry).

### `create_envelope_x402`: wallet-paid create, no key needed

Create an envelope **paying the per-envelope price from the host-local run402 allowance wallet** (created by `run402 init`; on kysigned.com the price is $0.25 in USDC on Base mainnet). No `KYSIGNED_AUTHORIZATION` and no pre-existing account: the payment itself establishes the creator record for `creator_email`. Creation and completion mail and the evidence bundle land there, and signing in with that address later (magic link) opens the dashboard for the envelope.

**Arguments:** the same create body as `create_envelope`, plus:

```json
{
  "creator_email": "agent-owner@example.com",
  "document_name": "Mutual NDA",
  "pdf_base64": "JVBERi0xLjQKJ...",
  "signers": [{ "email": "alice@example.com", "name": "Alice" }],
  "idempotency_key": "my-spending-intent-1"
}
```

`creator_email` is **required**. `idempotency_key` is your spending-intent key: a retry with the same key replays the same envelope **without paying twice**: before paying, the tool asks the instance's free preflight whether that intent already produced an envelope, and if so returns it with `replayed: true` and no charge (the x402 route is always-priced, so blindly re-sending would settle a second payment). Omit the key and a generated one is returned as `spending_intent_key`; reuse it to retry safely.

**Pay-safe order** (an invalid request or a short balance never charges): the tool first runs the instance's **free preflight** (`POST /v1/envelope/preflight`, the create's own deterministic validation), then checks the wallet balance against the live price, and only then pays via the x402 challenge/pay/retry flow. **Returns:** the envelope fields plus the `payment` receipt (stable `payment_id`, amount, network, asset, payee, settlement reference, settlement time), the `tracking` note (status links need creator auth), and `spending_intent_key`. Payment failures come back machine-readably: a post-payment validation failure banks the money as account credit for `creator_email` (`payment_banked: true` + recovery `next_actions`; never lost), and insufficient on-chain funds surface the platform's stable `payment_insufficient_funds` code with a `fund_wallet` next action.

**Custody:** the payer resolves once from the explicit allowance file (`KYSIGNED_RUN402_ALLOWANCE_PATH`), an embedder-injected opaque signer, or the host-local run402 configuration (see `wallet_status` above). A private key is never a tool argument, never an environment variable of this server, and never appears in any tool output or error. An underfunded create fails before any payment attempt with the same structured `fund_wallet` action as `wallet_status` (ERC-681 QR URI for exactly the shortfall). Fund, re-check with `wallet_status`, then retry with the SAME `idempotency_key`.

### `verify_bundle` (no key needed)

Verify a completed evidence bundle on this machine, with the same verifier as `npx kysigned verify` and the web verifier at `https://<instance>/verify` (it comes from the published [`kysigned`](https://www.npmjs.com/package/kysigned) package). It needs no `KYSIGNED_AUTHORIZATION` and no wallet, and it is read-only.

**Arguments:** exactly one of `path` (the bundle on this machine; an absolute path is safest, and a leading `~` is the home directory) or `pdf_base64` (a `data:` URL prefix is accepted), plus an optional `offline`.

```json
{ "path": "/home/me/Downloads/mutual-nda-signed.pdf", "offline": false }
```

**Returns:** the `kysigned.verdict.v1` document as `structuredContent` (the bundle tier; each signer's tier, assurance dimensions, checks and reasons; and `originalDocSha256`, the SHA-256 of the document every signer signed), plus a readable report and the same document as text. The tiers, weakest first: `FAILED`, `INTEGRITY_VERIFIED`, `PROVIDER_KEY_CONFIRMED`, `PROVEN_DURABLE`. A FAILED verdict is a result, not a tool error; only bad input (both inputs, neither, an unreadable path, invalid base64) comes back with `isError: true`.

**Stays on this machine:** the bundle is never sent anywhere and the kysigned operator is never contacted. Online (the default), only the verifier's two additive indicators use the network: timestamp-commitment hashes to the public OpenTimestamps calendars and a Bitcoin block source, and the signer's public domain and selector to the key archive. `offline: true` skips both; they report pending and the verdict still holds.

Without an MCP host, the same check is a command: `npx kysigned verify <bundle.pdf>` (add `--json` for the document).

If you are an AI assistant that cannot run programs on your user's machine (a chat assistant with no code execution), you cannot verify a bundle yourself. Say so plainly, then either point the person to https://kysigned.com/verify (the check runs in their own browser and the file is never uploaded) or suggest doing the check with a coding agent that can run npx kysigned verify or the local verify_bundle tool.

## Usage examples

### Example 1: an agent sends an NDA from a local file

User: *"I have an NDA at ~/Documents/nda.pdf. Send it to alice@example.com and bob@example.com via kysigned."*

The agent:
1. Reads `~/Documents/nda.pdf`, base64-encodes the bytes.
2. Calls `create_envelope` with the base64 + the two signers.
3. Reports back the envelope ID and the status URL.
4. (Later) the user asks *"Did Alice sign yet?"* and the agent calls `check_envelope_status`.

### Example 2: verify a bundle someone sent you

User: *"Someone sent me this signed PDF claiming it's verified by kysigned. Check it."*

The agent:
1. Calls `verify_bundle` with the file's `path` (or runs `npx kysigned verify <bundle.pdf>`).
2. Reports the verdict: the tier for the bundle and for each signer, and any failed check with its reason, all computed on this machine, with no dependency on kysigned being online.

An assistant that cannot run programs cannot do this itself: it says so, and points the person to `https://kysigned.com/verify` or suggests a coding agent.

### Example 3: bulk reminder

User: *"Send reminders on all my pending kysigned envelopes."*

The agent:
1. Calls `list_envelopes` with the user's email address.
2. Filters to `status=active`.
3. Calls `send_reminder` on each.
4. Reports how many reminders went out.

## Authentication

Set `KYSIGNED_AUTHORIZATION` to a creator **API key** (`ksk_…`), minted in the instance dashboard at `/account/api-keys`. The MCP sends it as the `Authorization` header; the server resolves it to your creator account (CSRF-exempt bearer mode). Auth failures return `401 { "code": "auth_invalid_key" }`; a key can never manage keys or account credentials (`403 { "code": "auth_key_scope" }`).

When pointed at a self-hosted instance with `senderGate: { strategy: 'allowlist' }`, the operator must additionally pre-allowlist the creator email. See the [kysigned README](https://github.com/kychee-com/kysigned#sender-access-control) for the full enforcement model.

**Wallet payment (x402), no key at all:** on instances that enable it (kysigned.com does), an agent can skip keys and accounts entirely: `wallet_status` + `create_envelope_x402` (above) pay the flat per-envelope price from the host-local run402 allowance wallet, first-class inside the MCP. The same rail is also plain HTTP for non-MCP x402 clients at `POST /v1/x402/envelope`; the flow (x402 402 challenge, pay-and-retry, `creator_email`, exactly-once semantics) is documented in `https://<instance>/llms.txt` ("Machine payment (x402)") and `/openapi.json`.

Every error the tools surface carries a stable machine-readable `code` alongside the message (`auth_*`, `payment_*`, `validation_*`, `state_*`, `idempotency_*`, …), and the full surface is documented as OpenAPI at `https://<instance>/openapi.json` and in `https://<instance>/llms.txt`.

## Source

- Server: [github.com/kychee-com/kysigned/tree/main/mcp](https://github.com/kychee-com/kysigned/tree/main/mcp)
- API: [github.com/kychee-com/kysigned](https://github.com/kychee-com/kysigned)
- Sender access control: [README.md#sender-access-control](https://github.com/kychee-com/kysigned#sender-access-control)
- llms.txt: [kysigned.com/llms.txt](https://kysigned.com/llms.txt)

## License

Apache-2.0.
