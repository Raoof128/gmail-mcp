# Gmail MCP for Claude

[![CI](https://github.com/Raoof128/gmail-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Raoof128/gmail-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen.svg)](package.json)

A Gmail [Model Context Protocol](https://modelcontextprotocol.io) server that moves attachments to and
from your disk, works across several Google accounts, and puts every mailbox mutation behind a permission
model the server enforces rather than the model.

> **Status: pre-release, deployed and exercised end to end.** The Worker, Google OAuth, the 38 Gmail
> tools and the macOS companion are implemented, and a deployed Worker has completed the whole chain
> against a real mailbox: dynamic client registration, PKCE, a scoped token, reads, a gated send that
> refused until the owner approved it, and an attachment round trip to disk. That is not a release.
> Five external qualification gates remain `not_run`, release authority is unreachable by construction,
> and the served build identity is `unqualified`. See [project status](#project-status) below,
> [the release qualification runbook](docs/runbooks/release-qualification.md) and
> [the companion runbook](docs/runbooks/companion.md).

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
[the design spec](docs/superpowers/specs/2026-09-09-gmail-mcp-design.md), and
[docs/README.md](docs/README.md) maps the rest of the documentation and says which parts are historical.

## Project status

Three words are used precisely below and are not interchangeable. **Locally verified** means a test
proves it inside the real Workers runtime or the native suite. **Live** means it has additionally run
against the deployed Worker and real Google infrastructure. **`not_run`** means no evidence exists, which
is a status rather than a failure.

| Component                                | State                                                              |
| ---------------------------------------- | ------------------------------------------------------------------ |
| D1 schema, ownership invariants          | Locally verified                                                   |
| Policy engine, actions and modifiers     | Locally verified                                                   |
| Approval engine, atomic claim            | Locally verified; live, a send held until the owner approved it    |
| Operation journal, idempotency           | Locally verified                                                   |
| Attachment staging (server side)         | Locally verified; live, a PDF staged out of Gmail and read to disk |
| Audit log, scheduled recovery            | Locally verified                                                   |
| MCP endpoint and control tools           | Locally verified; live, registration, PKCE and all 38 tools listed |
| Google OAuth and the approval pages      | Locally verified against a synthetic Google; live against Google   |
| The 38 Gmail tools and the send pipeline | Locally verified against a synthetic Gmail; live, a message sent   |
| Local companion and native helper        | Locally verified; live, a save to disk and an owner debt repair    |
| The five external qualification gates    | `not_run`, and none can be closed from here                        |
| Release authority                        | Unreachable by construction                                        |

The Worker suite runs inside workerd against real D1, R2 and KV emulation with a synthetic Google
service. The native suite exercises real files and SQLite; Keychain tests use an isolated adapter.

### What is not established

Five guarantees are external to this repository and remain `not_run`. A tested refusal path proves the
system refuses without evidence; it does not produce the evidence.

Counting them is easy to get wrong, so the relationship is written out. Three open **feasibility
decisions** are recorded in
[Plan 6 feasibility](docs/superpowers/reviews/2026-09-16-plan-6-feasibility.md): the provider commit
barrier, writer quiescence together with deployment exclusion, and peak isolate memory. Those three
decisions cover four guarantees, because quiescence and exclusion are decided together and refused
separately. Restore execution and reconciliation is the fifth, and it is not a feasibility question but a
missing controller.

| Gate                                 | Why it cannot be closed from here                                           |
| ------------------------------------ | --------------------------------------------------------------------------- |
| Peak isolate memory                  | 128 MB is per isolate, shared and reused; sampled metrics cannot bound it   |
| Restore execution and reconciliation | no restore controller exists, so no restore request can be issued           |
| Authoritative writer quiescence      | cancelling in-flight queries does not exclude a delayed or cross-host write |
| Cross-host deployment exclusion      | a local lock does not exclude another laptop, CI runner or operator         |
| Provider commit barrier              | the provider does not expose whether a lost response committed              |

None of these may be closed with an operator boolean, an elapsed timeout, a successful request, Node RSS
or a mocked receipt. The
[full-project gauntlet](docs/superpowers/reviews/2026-09-17-full-project-gauntlet.md) is canonical for
their classification and the evidence behind it.

Two further guarantees hold **by construction** rather than by a check, which is stronger while it lasts
and weaker the moment the code arrives. There is no restore request to be uncertain about, and release
authority is unreachable because `assessRelease` reports `release` as only `fail` or `not_run` and always
carries `implementation_incomplete` as a blocker. Both owe requalification on the day a controller appears.

The guarantees that _are_ established, with the implementation site behind each, are in
[docs/INVARIANTS.md](docs/INVARIANTS.md). Current test counts live in
[the changelog](CHANGELOG.md#unreleased) and nowhere else, so they cannot drift apart.

## Getting started

Use Node 22.18 or newer for the companion. Its native helper requires macOS 26.6 or newer, Xcode command-line tools and a local APFS or HFS volume.

```bash
git clone https://github.com/Raoof128/gmail-mcp.git
cd gmail-mcp
npm install
npm run verify
```

`npm run verify` runs formatting, linting, type checking and the TypeScript suites across all four
workspaces. CI runs exactly this. It does not compile or test Swift, so `npm run verify:native` is a
separate gate that runs `swift test` and a release build on a supported Mac.

### Running the server

Every route is behind real identity. There is no development bearer: a client obtains a token through
the OAuth flow, and the browser pages need a Google login as the configured owner.

```bash
cp worker/.dev.vars.example worker/.dev.vars
npm run migrate:local --workspace worker
```

Create the Google OAuth client and set the owner following
[the Google Cloud runbook](docs/runbooks/google-cloud.md). Because the Worker builds its redirect URIs and
audiences as `https://<WORKER_HOSTNAME>`, the OAuth flows do not complete against a plain-HTTP
`wrangler dev`; deploy a dev Worker for manual checks. The test suite drives every flow, including the
races, against an in-memory Google inside the real Workers runtime, so run the gate from the repository
root:

```bash
npm run verify
```

Point a client at the deployed endpoint and it discovers authorization on its own:

```bash
npx @modelcontextprotocol/inspector https://<WORKER_HOSTNAME>/mcp
```

## Local companion

[Set up the companion](docs/runbooks/companion.md) after registering its client on the Worker Accounts
page. It exposes `list_roots`, `stage_file` and `save_attachment`, and refuses overwrites.

A save that loses the exclusive rename holds its reservation against a 25 MiB budget until the helper
collects the leftover temporary. When the collector cannot verify what it would remove, that charge stays
and every later save answers `spool_budget`. `gmail-mcp-companion debt` lists whatever is charged with
the remedy that fits it, and `debt --scope SCOPE --release HANDLE` clears a charge in the one state where
a human safely can. Releasing repairs accounting only: the receipt still says `publication_unknown`,
because dropping a charge learns nothing about the destination.

## Repository layout

```
shared/     Contracts both halves depend on: action names, error codes, zod schemas
worker/     The Cloudflare Worker: all of the authority
  src/auth/        token scope and audience, consent, companion registration
  src/crypto/      canonical JSON (RFC 8785), hashing, AES-GCM keyring
  src/policy/      recipient trust, argument limits, the policy engine
  src/approval/    pending actions and the atomic claim
  src/operations/  the external-side-effect journal, the send pipeline, recovery
  src/staging/     attachment ingest, reads, reservations and lifecycle
  src/google/      the Google OIDC client, account connect, tokens, the Gmail client
  src/tools/       the 38 tools and the one gate they all pass through
  src/mime/        RFC 2047 and 2231 encoding, the message as a stream
  src/web/         the owner console: accounts, policy, audit, approval, login
  src/mcp/         the MCP server and the control tools
  migrations/      D1 schema, append-only
companion/  TypeScript stdio client
  native/          the Swift helper: Darwin filesystem calls, SQLite, Keychain
scripts/    qualification: build identity, evidence graph, release assessment
docs/       Architecture, the invariant index, runbooks, the design spec, and the development record
```

[docs/README.md](docs/README.md) is the map: which documents describe the system now, and which are dated
records of what was true when they were written.

## Security

[SECURITY.md](SECURITY.md) has the threat model, the boundary of what this does not defend against, and
how to report a vulnerability. Please do not open a public issue for a security report.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers the development loop, how this project tests, and what makes a
change easy to review. The [Code of Conduct](CODE_OF_CONDUCT.md) governs participation.

## License

[MIT](LICENSE).
