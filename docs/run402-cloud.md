# Run Your Own Kysigned On Run402

This is the clone-to-deploy path for the open-source Kysigned repo. It uses the
first-class `run402.json` app manifest in this repository.

## Prerequisites

- Node 20 or newer.
- Run402 CLI 3.7.14 or newer: `npx run402 --version`.
- A Run402 wallet/profile that can create projects. `run402 init` sets this up.

## Deploy

Clone the repo:

```bash
git clone https://github.com/kychee-com/kysigned.git
cd kysigned
```

Run `up` with the only user-supplied secret Kysigned requires:

```bash
KYSIGNED_ALLOWED_CREATORS='you@example.com,*@example.org' \
run402 up --name my-kysigned
```

`KYSIGNED_ALLOWED_CREATORS` is a comma-list of exact creator emails and
exact-domain wildcards. `*@example.org` allows `alice@example.org`; it does not
allow `alice@team.example.org`.

When the command succeeds, your app is live at:

```text
https://my-kysigned.run402.com
```

The managed mailbox addresses use the project mail host:

```text
forward-to-sign@my-kysigned.mail.run402.com
notifications@my-kysigned.mail.run402.com
```

## What `run402 up` Does

- Creates or links a Run402 project named from `--name`.
- Creates the `forward-to-sign` and `notifications` mailboxes.
- Sets generated runtime bindings for project id, origin, service key, anon key,
  API base, mailbox ids, and mailbox addresses.
- Runs the local build commands declared in `run402.json`.
- Applies the database migrations, static site, routed API function, email
  triggers, subdomain, and route table.
- Applies the `kysigned-agent` function, the no-install front door for AI
  agents: an MCP endpoint at `/mcp`, the discovery documents
  (`/.well-known/mcp/server-card.json`, `/.well-known/agent-skills/index.json`,
  `/.well-known/api-catalog`, `/auth.md`), and markdown versions of the info
  pages (`/faq`, `/how-it-works`, `/how-it-works-technical`, each also at
  `<page>.md`). It holds no secrets and reaches your app only through its own
  public origin.
- Verifies `/`, `/v1/health`, `/faq.html`, and `/how-it-works`.
- Records app install state as `applying` and then `active`.

## Smoke Test

After deploy:

```bash
curl -i https://my-kysigned.run402.com/
curl -i https://my-kysigned.run402.com/v1/health
curl -i https://my-kysigned.run402.com/faq.html
curl -i -H 'Accept: text/markdown' https://my-kysigned.run402.com/faq
curl -i https://my-kysigned.run402.com/mcp/server-card
```

Then open the site, sign in with an allowed creator email, create an envelope,
and send it to an email address you control. The signer should forward the
request email to the generated `forward-to-sign@...mail.run402.com` address.

## Useful Variants

Use a different project name:

```bash
KYSIGNED_ALLOWED_CREATORS='owner@example.com' run402 up --name contract-demo
```

Allow a whole exact domain:

```bash
KYSIGNED_ALLOWED_CREATORS='*@example.com' run402 up --name example-sign
```

Re-deploy the linked workspace:

```bash
KYSIGNED_ALLOWED_CREATORS='*@example.com' run402 up --yes
```

## Notes

- `--max-spend-usd` is optional. Prototype-tier experimentation can use the
  default Run402 flow.
- `--name` is required for a fresh clone so Run402 can create a friendly project
  and web origin. Re-deploys can use the `.run402/project.json` workspace link.
- Secret values stay outside `run402.json`. The manifest declares what is
  required; generated bindings and local environment values provide the values.
- Custom sender domains are a later step. The zero-DNS path uses the managed
  project mail host.
- The first release with the agent function raises two route warnings that
  are expected: `PUBLIC_ROUTED_FUNCTION` (the agent function is public by
  design: no auth, no cookies, and its only paid tool needs the caller's own
  wallet signature) and `ROUTE_SHADOWS_STATIC_PATH` (its routes serve the info
  pages, whose static files stay in place). Confirm them when asked;
  `scripts/deploy.mjs` passes both as allowed warning codes. The one prefix
  route, `/.well-known/agent-skills/*`, takes every method, like `/mcp`, and
  the function answers the rest itself (a JSON 405 for anything but GET, HEAD
  and OPTIONS). A GET/HEAD-only wildcard would raise the SDK's
  `WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS` warning, which stops the apply,
  and run402 refuses the `acknowledge_readonly` route field the SDK suggests
  for it.
- The build stages copies of the info pages under `/_agent/pages/`, where the
  agent function reads them. The template ships no `robots.txt`; a fork that
  adds one may disallow `/_agent/` (each copy also keeps its page's canonical
  link, if it has one).
