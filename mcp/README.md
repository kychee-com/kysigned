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

The MCP server defaults to the hosted instance at `https://kysigned.com`. You can point it at any kysigned deployment (your own self-hosted instance, a staging environment, etc.) via an environment variable:

```bash
KYSIGNED_ENDPOINT=https://kysigned.example.com npx -y kysigned-mcp
```

## Wire it up to Claude Desktop

Edit your Claude Desktop MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "kysigned": {
      "command": "npx",
      "args": ["-y", "kysigned-mcp"]
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

The server exposes 5 tools — all signing operations against a running kysigned instance. (Provisioning a new instance is a deploy-time concern — see the [main README](../README.md) — not an MCP tool.) All take JSON arguments and return JSON results.

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
  "callback_url": "https://your.app/webhooks/kysigned",
  "expiry_days": 14
}
```

You can pass `pdf_url` instead of `pdf_base64` to fetch the PDF from a URL. Every signer is notified at once.

**Returns:** envelope ID, status URL, verify URL, list of `{ email, name, link }` per signer, and a spam notice for the sender to forward.

### `check_envelope_status`

Get the current status of an envelope by ID, including per-signer status and signing times.

```json
{ "envelope_id": "abc123-..." }
```

### `list_envelopes`

List every envelope created by a given sender email address.

```json
{ "email": "you@example.com" }
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

When pointed at the hosted instance, authentication is via `KYSIGNED_AUTHORIZATION` env var (API key or session token from a credit-holding account).

When pointed at a self-hosted instance with `senderGate: { strategy: 'allowlist' }`, the operator must pre-allowlist the sender email. See the [kysigned README](https://github.com/kychee-com/kysigned#sender-access-control) for the full enforcement model.

Read-only tools (`check_envelope_status`, `list_envelopes`) do not require payment.

## Source

- Server: [github.com/kychee-com/kysigned/tree/main/mcp](https://github.com/kychee-com/kysigned/tree/main/mcp)
- API: [github.com/kychee-com/kysigned](https://github.com/kychee-com/kysigned)
- Sender access control: [README.md#sender-access-control](https://github.com/kychee-com/kysigned#sender-access-control)
- llms.txt: [kysigned.com/llms.txt](https://kysigned.com/llms.txt)

## License

Apache-2.0.
