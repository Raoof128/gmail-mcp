# Gmail MCP for Claude

[![CI](https://github.com/Raoof128/gmail-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Raoof128/gmail-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

A Gmail [Model Context Protocol](https://modelcontextprotocol.io) server that can move attachments to
and from your disk, work across several Google accounts, and put every mailbox mutation behind a
permission model the server enforces rather than the model.

> **Status: in development.** The authority core is built and tested. Google OAuth, the Gmail tools and
> the local companion are not yet implemented. See [Project status](#project-status) for exactly what
> works today, and treat nothing here as production-ready until that table says so.

## Why this exists

Hosted Gmail connectors have two gaps that matter in daily use:

- **Attachments are one-way.** They return an attachment's name, type and id, but never its bytes, so
  there is no way to save one to disk. Sending is limited to base64 inlined in the tool call, which
  stops being usable past a few hundred kilobytes.
- **Permission is all-or-nothing.** Once connected, a prompt-injected email or a confused model can
  reach every write the connector exposes.

This project targets both, without depending on any capability of any hosted connector.

## What it does

- **Attachments both directions.** Bytes never pass through the model's context. A download becomes an
  opaque staging handle; a thin local companion exchanges that handle for a file on disk. Uploads go the
  same way in reverse.
- **Several Google accounts** under one owner, each with its own alias, policy and send limits. Every
  write names its account explicitly. The model never guesses.
- **A permission model the server enforces.** Every action resolves to `allow`, `ask` or `deny`.
  Modifiers such as `+external`, `+attachment` and `+bulk` can only ever raise the level, never lower it.
- **`ask` means a human approves.** It creates a pending action and returns without touching Gmail. The
  payload is held server-side and hashed, so what you approve is exactly what executes. Approval happens
  in your browser, or through MCP URL-mode elicitation where the client supports it. A confirmation code
  relayed through the model is never accepted.
- **No permanent delete.** There is no tool for it, and the requested Google scope cannot perform one.

## Design principles

> Claude is not the authority. The MCP client is not the authority. Tool annotations are not the
> authority. The authenticated server-side policy engine is the authority.

Three consequences run through the codebase:

1. **Identity is never an argument.** The acting user comes from the verified bearer token, never from a
   tool parameter, and ownership is a database foreign key rather than a habit of remembering to check.
2. **Approval binds to bytes.** A pending action stores its canonical
   ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html)) payload and the hash of exactly those
   bytes. The attachments an operation reserves are read back out of the approved payload, so a caller
   cannot substitute a different file between approval and send.
3. **Ambiguity is a state, not a guess.** If a send may have reached Gmail but the result was never
   recorded, the operation becomes `delivery_unknown` and is surfaced. It is never silently retried.

## Architecture

```
Claude (claude.ai / Desktop / Claude Code)
        │  MCP over Streamable HTTP, bearer scoped "mcp"
        ▼
┌──────────────────────────────────────────┐
│ Cloudflare Worker  (the authority)       │
│  Gmail tools · Policy engine             │
│  Confirmation engine · Operation journal │
│  Google OAuth · Attachment staging       │
│  Audit log · Approval and policy pages   │
└──────┬─────────────┬──────────────┬──────┘
       │             │              └── KV   OAuth and CSRF state
       │             └── R2   attachment bytes, short lived
       └── D1   accounts, policy, approvals, operations, audit
       ▼
   Gmail API

Claude Code / Desktop only
        │  stdio
        ▼
┌──────────────────────────────────────────┐
│ Local companion (thin)                   │
│  save_attachment · stage_file            │
│  bearer scoped "staging"                 │
└──────────────┬───────────────────────────┘
               ▼
        Your filesystem, confined to configured roots
```

The companion knows nothing about Gmail. It moves bytes between staging handles and disk, and enforces
the filesystem rules only it can enforce. Gmail never talks to it.

A fuller treatment is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the complete design, including
the threat model and the reasoning behind each decision, is in
[the design spec](docs/superpowers/specs/2026-09-09-gmail-mcp-design.md).

## Project status

| Component                                | State                              |
| ---------------------------------------- | ---------------------------------- |
| D1 schema, ownership invariants          | Built and tested                   |
| Policy engine, actions and modifiers     | Built and tested                   |
| Approval engine, atomic claim            | Built and tested                   |
| Operation journal, idempotency           | Built and tested                   |
| Attachment staging (server side)         | Built and tested                   |
| Audit log, scheduled recovery            | Built and tested                   |
| MCP endpoint and control tools           | Built, behind a development bearer |
| Google OAuth and the approval pages      | Not started                        |
| The 38 Gmail tools and the send pipeline | Not started                        |
| Local companion                          | Not started                        |

77 tests pass against the real Workers runtime. Nothing here has yet sent an email.

## Getting started

Requires Node 20 or newer.

```bash
git clone https://github.com/Raoof128/gmail-mcp.git
cd gmail-mcp
npm install
npm run verify
```

`npm run verify` runs formatting, linting, type checking and the full test suite. It is the same gate
CI runs, so a green local run means a green pull request.

### Running the server locally

```bash
cp worker/.dev.vars.example worker/.dev.vars
cd worker
npm run migrate:local
npx wrangler dev
```

The development bearer only exists when **both** `DEV_STATIC_TOKEN` and `DEV_STATIC_USER` are set. It is
a scaffold for driving the endpoint before OAuth lands, and it is deleted rather than disabled when
OAuth arrives.

Seed an account and call a tool:

```bash
npx wrangler d1 execute gmail-mcp --local --command \
  "INSERT INTO users (id,email,created_at) VALUES ('mu','you@example.test',0);
   INSERT INTO accounts (id,user_id,alias,google_sub,google_email,scopes,status,is_default,created_at)
   VALUES ('ma','mu','personal','s','you@example.test','gmail.modify','active',1,0);"
```

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp \
  --transport http --header "Authorization: Bearer dev-token" --method tools/list
```

## Repository layout

```
shared/     Contracts both halves depend on: action names, error codes, zod schemas
worker/     The Cloudflare Worker: policy, approvals, operations, staging, audit
  src/crypto/      canonical JSON, hashing, AES-GCM keyring
  src/policy/      recipient trust, argument limits, the policy engine
  src/approval/    pending actions and the atomic claim
  src/operations/  the external-side-effect journal
  src/staging/     attachment ingest, reads and lifecycle
  migrations/      D1 schema
docs/       Architecture, the design spec, and the implementation plans
```

## Security

The threat model, what is in scope and what is explicitly not, and how to report a vulnerability are in
[SECURITY.md](SECURITY.md). Please do not open a public issue for a security report.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers the development loop, the testing philosophy and what a
reviewable change looks like here. Participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE).
