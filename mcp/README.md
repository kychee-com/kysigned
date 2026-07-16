# kysigned-mcp

Model Context Protocol (MCP) server for [kysigned](https://kysigned.com) — DKIM-based e-signatures that produce a self-contained **evidence-bundle** PDF. Lets any MCP-compatible AI agent (Claude Desktop, Claude Code, Cursor, custom agents using the Anthropic SDK, etc.) send documents for signing and check status, without writing HTTP code.

## Install

```bash
npx -y kysigned-mcp
```

That's it. The first run launches the server over stdio — no global install needed.

For permanent installation:

```bash
npm install -g kysigned-mcp
```

## Configure

The MCP server defaults to the hosted instance at `https://kysigned.com`. Two environment variables:

- `KYSIGNED_ENDPOINT` — point it at any kysigned deployment (your own self-hosted instance, staging, etc.).
- `KYSIGNED_AUTHORIZATION` — your creator **API key**. Sign in to the instance's dashboard and mint one at `/account/api-keys` (format `ksk_…`, shown exactly once). The key authorizes the creator envelope actions and nothing else — it cannot manage keys or the account.

```bash
KYSIGNED_ENDPOINT=https://kysigned.example.com \
KYSIGNED_AUTHORIZATION=ksk_your_key_here \
npx -y kysigned-mcp
```

`KYSIGNED_ENDPOINT` may include a trailing slash or a path prefix — it is normalized once at startup. If `KYSIGNED_AUTHORIZATION` is missing, the tools fail locally with actionable guidance instead of sending an unauthenticated request.

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

Restart Claude Desktop. The kysigned tools become available — try asking *"Use kysigned to send the attached PDF to alice@example.com for signature."*

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

The server exposes 7 tools — the five key-authenticated signing operations plus a **no-key wallet pair** (`wallet_status`, `create_envelope_x402`) that pays per envelope from the host-local run402 wallet. (Provisioning a new instance is a deploy-time concern — see the [main README](../README.md) — not an MCP tool.) All take JSON arguments and return JSON results.

Each tool carries MCP **annotations** so a host can tell them apart: `check_envelope_status`, `list_envelopes`, and `wallet_status` are read-only; `create_envelope` and `send_reminder` send email (and create consumes a creator credit); `void_envelope` is **destructive** (irreversible cancellation); `create_envelope_x402` is also marked **destructive** because it spends real funds — hosts that gate destructive tools will ask before it pays. A non-2xx API response or a transport failure comes back as an MCP result with `isError: true`, carrying the HTTP status and the stable error `code` (e.g. `[402] payment_required: …`), so agents branch correctly instead of treating a failure as success.

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

Provide **exactly one** of `pdf_base64` or `pdf_url` (the server fetches `pdf_url` for you) — the tool rejects zero or both locally before any network call. Optional fields: `message` (included in the signing-request email), `expiry_days` (omit for the operator default), `auto_close` (`false` = manual seal after all signers sign). Signer `email`s are validated locally and capped at 20. Every signer is notified at once.

`callback_url` (https only) arms a **signed completion webhook**: the create response includes `callback_secret` (`whs_…`, returned exactly once). At completion the instance POSTs `{ "type": "envelope.completed", … }` to your URL with `X-Kysigned-Signature: t=<unix>,v1=<hex hmac-sha256(callback_secret, "<t>." + rawBody)>` — verify by recomputing the HMAC and rejecting stale timestamps. Deliveries retry (at-least-once), so make the receiver idempotent on `envelope_id`.

**Returns:** envelope ID, status URL, verify URL, list of `{ email, name, link, review_link }` per signer, `callback_secret` when a `callback_url` was supplied, and a spam notice for the sender to forward.

### `check_envelope_status`

Get the current status of an envelope by ID, including per-signer status and signing times.

```json
{ "envelope_id": "abc123-..." }
```

### `list_envelopes`

List the envelopes created by the authenticated creator (the key holder). No arguments.

```json
{}
```

> **Verification is not an MCP tool.** In the evidence-bundle model anyone verifies a
> completed bundle PDF entirely client-side — drag-and-drop at `https://<instance>/verify`,
> or run the bundled `node bin/verify-bundle.mjs <bundle.pdf>`. It checks the signers' DKIM
> signatures, the embedded provider keys, and the timestamps locally, with no server or
> registry lookup — even if the originating instance is gone.

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

### `wallet_status` — no key needed

Report the payer's payment readiness for wallet-paid creation: payer provenance (`payer_source` + public address + network — never key material), asset, on-chain balance, the live per-envelope price (read from the x402 route's own 402 challenge — never hardcoded), whether the balance covers it, and funding guidance when short. Read-only; never creates, spends, or initiates an on-chain transaction. No arguments.

```json
{}
```

If no payer exists it returns `configured: false` with the expected allowance path and the fixes (`run402 init`, or `KYSIGNED_RUN402_ALLOWANCE_PATH`). On an instance whose operator has not wired x402, it returns an error explaining the route is not payable.

**Payer sources (resolved once at startup, in precedence order):**

1. `KYSIGNED_RUN402_ALLOWANCE_PATH` — an **explicit run402 allowance file**. When set, it is the ONLY wallet consulted: an unreadable path fails closed (`payer_source_unavailable`) instead of falling back to the ambient wallet. Use this when a host manages per-agent allowance files (for example materialized from a secret store into a mode-0600 file).
2. An **opaque payment signer** injected programmatically by an embedder (`import { configurePaymentSigner } from 'kysigned-mcp'`-style hosting of the server module, before the first wallet tool call). The provider exposes only a public address plus signing operations, so key material can stay inside KMS/HSM/secret-broker boundaries. Mutually exclusive with the env path (`payer_source_conflict` if both are set).
3. The **ambient host-local run402 allowance** (`run402 init`) — the default when nothing explicit is configured.

Readiness and payment share the one resolved payer: the address whose balance `wallet_status` reports is the address that signs the payment.

**Balance resilience:** the balance read retries with backoff and fails over across independent public RPC providers (the same lists the run402 SDK payment stack uses). If EVERY provider fails, the result is `balance_status: "unknown"` with a structured `balance_error` (`retryable: true`, `mutation_state: "not_started"`) — never a fabricated zero and never an insufficient-funds verdict. `KYSIGNED_RPC_URL` optionally PREPENDS a private RPC; it is an advanced override, not required for ordinary reliability.

**Funding an underfunded wallet (fund → recheck → create):** an underfunded result carries a structured `next_actions[0]` of `type: "fund_wallet"` — destination address, CAIP-2 network, token contract/symbol/decimals, balance/price/shortfall in atomic AND exact decimal units, a concise human instruction, and an **ERC-681 payment URI requesting exactly the shortfall** (`ethereum:<token>@<chainId>/transfer?address=<wallet>&uint256=<shortfall>`) ready to render as a QR code. Flow: show the QR / send the URI → after funding, call `wallet_status` again to confirm `sufficient: true` → then `create_envelope_x402` (reusing your `idempotency_key` if this was a retry).

### `create_envelope_x402` — wallet-paid create, no key needed

Create an envelope **paying the per-envelope price from the host-local run402 allowance wallet** (created by `run402 init`; on kysigned.com the price is $0.25 in USDC on Base mainnet). No `KYSIGNED_AUTHORIZATION` and no pre-existing account: the payment itself establishes the creator record for `creator_email` — creation/completion mail and the evidence bundle land there, and signing in with that address later (magic link) opens the dashboard for the envelope.

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

`creator_email` is **required**. `idempotency_key` is your spending-intent key — a retry with the same key replays the same envelope **without paying twice**: before paying, the tool asks the instance's free preflight whether that intent already produced an envelope, and if so returns it with `replayed: true` and no charge (the x402 route is always-priced, so blindly re-sending would settle a second payment). Omit the key and a generated one is returned as `spending_intent_key` — reuse it to retry safely.

**Pay-safe order** (an invalid request or a short balance never charges): the tool first runs the instance's **free preflight** (`POST /v1/envelope/preflight` — the create's own deterministic validation), then checks the wallet balance against the live price, and only then pays via the x402 challenge/pay/retry flow. **Returns:** the envelope fields plus the `payment` receipt (stable `payment_id`, amount, network, asset, payee, settlement reference, settlement time), the `tracking` note (status links need creator auth), and `spending_intent_key`. Payment failures come back machine-readably — a post-payment validation failure banks the money as account credit for `creator_email` (`payment_banked: true` + recovery `next_actions`; never lost), and insufficient on-chain funds surface the platform's stable `payment_insufficient_funds` code with a `fund_wallet` next action.

**Custody:** the payer resolves once from the explicit allowance file (`KYSIGNED_RUN402_ALLOWANCE_PATH`), an embedder-injected opaque signer, or the host-local run402 configuration (see `wallet_status` above). A private key is never a tool argument, never an environment variable of this server, and never appears in any tool output or error. An underfunded create fails before any payment attempt with the same structured `fund_wallet` action as `wallet_status` (ERC-681 QR URI for exactly the shortfall) — fund, re-check with `wallet_status`, then retry with the SAME `idempotency_key`.

## Usage examples

### Example 1 — agent sends an NDA from a local file

User: *"I have an NDA at ~/Documents/nda.pdf. Send it to alice@example.com and bob@example.com via kysigned."*

The agent:
1. Reads `~/Documents/nda.pdf`, base64-encodes the bytes.
2. Calls `create_envelope` with the base64 + the two signers.
3. Reports back the envelope ID and the status URL.
4. (Later) the user asks *"Did Alice sign yet?"* and the agent calls `check_envelope_status`.

### Example 2 — verify a bundle someone sent you

User: *"Someone sent me this signed PDF claiming it's verified by kysigned. Check it."*

Verification is client-side, not an MCP call. The agent:
1. Runs `node bin/verify-bundle.mjs <bundle.pdf>` (or opens `https://<instance>/verify` and drops the PDF in).
2. Reports the verdict — the signers, their DKIM provider keys, and the timestamps — all confirmed locally, with no dependency on kysigned being online.

### Example 3 — bulk reminder

User: *"Send reminders on all my pending kysigned envelopes."*

The agent:
1. Calls `list_envelopes` with the user's email address.
2. Filters to `status=active`.
3. Calls `send_reminder` on each.
4. Reports how many reminders went out.

## Authentication

Set `KYSIGNED_AUTHORIZATION` to a creator **API key** (`ksk_…`), minted in the instance dashboard at `/account/api-keys`. The MCP sends it as the `Authorization` header; the server resolves it to your creator account (CSRF-exempt bearer mode). Auth failures return `401 { "code": "auth_invalid_key" }`; a key can never manage keys or account credentials (`403 { "code": "auth_key_scope" }`).

When pointed at a self-hosted instance with `senderGate: { strategy: 'allowlist' }`, the operator must additionally pre-allowlist the creator email. See the [kysigned README](https://github.com/kychee-com/kysigned#sender-access-control) for the full enforcement model.

**Wallet payment (x402), no key at all:** on instances that enable it (kysigned.com does), an agent can skip keys and accounts entirely — `wallet_status` + `create_envelope_x402` (above) pay the flat per-envelope price from the host-local run402 allowance wallet, first-class inside the MCP. The same rail is also plain HTTP for non-MCP x402 clients at `POST /v1/x402/envelope`; the flow — x402 402 challenge, pay-and-retry, `creator_email`, exactly-once semantics — is documented in `https://<instance>/llms.txt` ("Machine payment (x402)") and `/openapi.json`.

Every error the tools surface carries a stable machine-readable `code` alongside the message (`auth_*`, `payment_*`, `validation_*`, `state_*`, `idempotency_*`, …) — the full surface is documented as OpenAPI at `https://<instance>/openapi.json` and in `https://<instance>/llms.txt`.

## Source

- Server: [github.com/kychee-com/kysigned/tree/main/mcp](https://github.com/kychee-com/kysigned/tree/main/mcp)
- API: [github.com/kychee-com/kysigned](https://github.com/kychee-com/kysigned)
- Sender access control: [README.md#sender-access-control](https://github.com/kychee-com/kysigned#sender-access-control)
- llms.txt: [kysigned.com/llms.txt](https://kysigned.com/llms.txt)

## License

Apache-2.0.
