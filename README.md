# Gmail MCP for Claude

[![CI](https://github.com/Raoof128/gmail-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Raoof128/gmail-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

A Gmail [Model Context Protocol](https://modelcontextprotocol.io) server that moves attachments to and
from your disk, works across several Google accounts, and puts every mailbox mutation behind a permission
model the server enforces rather than the model.

> **Status: pre-release.** The Worker, Google OAuth, Gmail tools and macOS companion are implemented.
> Local tests cover the protocol and recovery paths. Deployment, real Keychain/browser login and installed
> Claude client checks remain release gates. See [the companion runbook](docs/runbooks/companion.md).

## Why this exists

Two gaps in hosted Gmail connectors show up in daily use.

The first is attachments. A connector returns an attachment's name and id but never its bytes, so you
cannot save one to disk. Sending is limited to base64 inlined in the tool call, which stops being usable
past a few hundred kilobytes.

The second is permission. Once you connect, a prompt-injected email or a confused model can reach every
write the connector exposes. There is no middle setting between full access and none.

This project closes both, without depending on any capability of any hosted connector.

## What it does

Attachments move in both directions, and the bytes never pass through the model's context. A download
becomes an opaque staging handle, and a thin local companion exchanges that handle for a file on disk.
Uploads use a private snapshot and a server-approved transfer. Attachment bytes stay out of model context.

Several Google accounts sit under one owner, each with its own alias, policy and send limit. Every write
names its account. The model never guesses which mailbox you meant.

Every action resolves to `allow`, `ask` or `deny`, and the server decides. Modifiers such as `+external`
and `+attachment` describe the risk in a specific call, and they can only raise the level.

`ask` means a person approves. The call creates a pending action and returns without touching Gmail. The
payload is held server-side and hashed, so what you approve is what executes. You approve in your browser,
or through MCP URL-mode elicitation where the client supports it. A confirmation code relayed through the
model is never accepted.

Nothing can permanently delete mail. No tool exposes it, and the Google scope this server requests cannot
perform one.

## Design principles

> Claude is not the authority. The MCP client is not the authority. Tool annotations are not the
> authority. The authenticated server-side policy engine is the authority.

Three consequences run through the code.

Identity is never an argument. The acting user comes from the verified bearer token, and ownership is a
database foreign key rather than a habit of remembering to filter.

Approval binds to bytes. A pending action stores its canonical
([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html)) payload and the hash of those exact bytes. The
attachments an operation reserves are read back out of the approved payload, so nobody can swap in a
different file between approval and send.

Ambiguity is a state rather than a guess. When a send may have reached Gmail but the result was never
recorded, the operation becomes `delivery_unknown` and says so. It is never retried on its own.

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
       │             │              └── KV   OAuth clients and grants
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
the filesystem rules only a process on that filesystem can enforce. Gmail never talks to it.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers this properly. The full design, including the threat
model and the reasoning behind each decision, is in
[the design spec](docs/superpowers/specs/2026-09-09-gmail-mcp-design.md).

## Project status

| Component                                | State                                     |
| ---------------------------------------- | ----------------------------------------- |
| D1 schema, ownership invariants          | Built and tested                          |
| Policy engine, actions and modifiers     | Built and tested                          |
| Approval engine, atomic claim            | Built and tested                          |
| Operation journal, idempotency           | Built and tested                          |
| Attachment staging (server side)         | Built and tested                          |
| Audit log, scheduled recovery            | Built and tested                          |
| MCP endpoint and control tools           | OAuth scope and audience checks           |
| Google OAuth and the approval pages      | Implemented; synthetic OAuth tests        |
| The 38 Gmail tools and the send pipeline | Implemented; synthetic Gmail tests        |
| Local companion                          | Implemented; macOS native and stdio tests |

The Worker suite runs inside workerd with a synthetic Google service. The native suite exercises local files and SQLite; Keychain tests use an isolated adapter. This implementation run did not send mail or deploy the Worker.

## Getting started

Use Node 22.18 or newer for the companion. Its native helper requires macOS 26.6 or newer, Xcode command-line tools and a local APFS or HFS volume.

```bash
git clone https://github.com/Raoof128/gmail-mcp.git
cd gmail-mcp
npm install
npm run verify
```

`npm run verify` runs formatting, linting, type checking and the tests. CI runs the same gate, so a green
local run checks the same TypeScript gates. Run `npm run verify:native` on a supported Mac as a separate gate.

### Running the server

Every route is behind real identity. There is no development bearer: a client obtains a token through
the OAuth flow, and the browser pages need a Google login as the configured owner.

```bash
cp worker/.dev.vars.example worker/.dev.vars
cd worker
npm run migrate:local
```

Create the Google OAuth client and set the owner following
[the Google Cloud runbook](docs/runbooks/google-cloud.md). Because the Worker builds its redirect URIs and
audiences as `https://<WORKER_HOSTNAME>`, the OAuth flows do not complete against a plain-HTTP
`wrangler dev`; deploy a dev Worker for manual checks. The test suite drives every flow, including the
races, against an in-memory Google inside the real Workers runtime:

```bash
npm run verify
```

Point a client at the deployed endpoint and it discovers authorization on its own:

```bash
npx @modelcontextprotocol/inspector https://<WORKER_HOSTNAME>/mcp
```

## Local companion

[Set up the companion](docs/runbooks/companion.md) after registering its client on the Worker Accounts page. It exposes `list_roots`, `stage_file` and `save_attachment`. V1 refuses overwrites.

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
companion/  TypeScript stdio client and Swift/Darwin helper
docs/       Architecture, the design spec, and the implementation plans
```

## Security

[SECURITY.md](SECURITY.md) has the threat model, the boundary of what this does not defend against, and
how to report a vulnerability. Please do not open a public issue for a security report.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers the development loop, how this project tests, and what makes a
change easy to review. The [Code of Conduct](CODE_OF_CONDUCT.md) governs participation.

## License

[MIT](LICENSE).
