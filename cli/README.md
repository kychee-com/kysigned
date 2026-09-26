# kysigned

Verify a kysigned evidence bundle on your own machine.

```
npx kysigned verify <bundle.pdf>
```

A kysigned bundle is a PDF that carries its own proof: each signer's email, signed by their
email provider with DKIM, plus timestamps. This command checks that proof with math and public
keys. The bundle is never uploaded anywhere, you need no account, and kysigned itself is not in
the trust set: the verdict comes only from the evidence inside the file.

## Usage

```
kysigned verify [--offline] [--json] <bundle.pdf>
kysigned --version
kysigned --help
```

- `--json` prints the verdict as one JSON document (schema `kysigned.verdict.v1`): the bundle's
  assurance tier, each signer's tier and evidence dimensions, each check's result, and the
  SHA-256 of the original document every signer signed.
- `--offline` skips the two online indicators. They report pending, and the verdict still holds.

### Exit codes

- `0`: the bundle verifies at a satisfied assurance tier.
- `1`: FAILED. At least one check failed, and the report names it.
- `2`: a usage or read error.

## What uses the network

By default, two indicators are confirmed online: the Bitcoin timestamp anchor (only
timestamp-commitment hashes go to the public OpenTimestamps calendars and a Bitcoin block
source) and the public key archive (only the signer's public `(domain, selector)` goes to the
archive). The bundle's bytes never leave your machine, and kysigned's own servers are never
contacted.

## From an agent

- **Coding agents** can run this command, or use the `verify_bundle` tool of the local MCP
  server (`npx -y kysigned-mcp`), which runs the same verifier on the same machine.
- **Agents that cannot run a program** (a chat assistant with no code execution) cannot verify
  a bundle themselves. They should say so and point the person to the web verifier at
  https://kysigned.com/verify (it runs in the person's own browser; the file is never uploaded),
  or suggest doing the check with a coding agent.

## Library

```js
import { verifyBundleBytes } from 'kysigned';

const { exitCode, report, json } = await verifyBundleBytes(bytes, { offline: false });
```

## Links

- How verification works: https://kysigned.com/how-it-works-technical
- Source: https://github.com/kychee-com/kysigned (the `cli/` directory)
- License: Apache-2.0
