# Plan 4 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, as requested by the owner. Track each deliverable and preserve failing-test evidence.

**Goal:** Ship the staging upload flow and macOS attachment companion described in design revision 3.

**Architecture:** The Worker owns account policy and transactional upload state. A TypeScript stdio companion exchanges opaque handles, while a native macOS helper owns filesystem confinement, snapshots, journal and Keychain access.

**Tech Stack:** Existing pinned TypeScript/Zod/MCP/Workers stack; Swift Package Manager, Darwin APIs, Security.framework and SQLite.

**Spec:** [Plan 4 design revision 3](2026-09-11-gmail-mcp-plan-4-companion-and-staging.md).

## Global constraints

- 25 MiB maximum file; no overwrite in V1.
- Worker policy and owner identity remain authoritative; staging tokens never call MCP.
- Snapshot before approval; journal before remote side effects.
- No secrets in argv, environment, logs or model context.
- One active ticket generation; deterministic keys and charged cleanup debt.
- Preserve the exact numeric budgets and deadlines in design sections 6–8.
- Tests precede production changes; no deploy or real Gmail sends in this execution.

## Tasks

### 1. Shared upload contracts and persistent state

Files: `shared/src/staging.ts`, `shared/package.json`, `shared/test/staging.test.ts`, `worker/migrations/0004_transfers.sql`, `worker/test/transfers.test.ts`.

Interfaces: strict `TransferIntent`, `TransferResult`, `TransferId`, and constants for budgets/deadlines. `TransferIntent` discriminates ensure/status/retry and requires expected generation plus retry ID for retry.

- [ ] Write schema rejection tests and ownership/active-generation uniqueness tests.
- [ ] Run `npm test -w @gmail-mcp/shared` and Worker transfer tests; record the expected missing-contract/schema failures.
- [ ] Implement strict schemas and append-only migration, using composite ownership foreign keys and partial uniqueness.
- [ ] Rerun focused tests, format and typecheck.

### 2. Worker intent, approval and generation issuance

Files: `worker/src/staging/transfers.ts`, `worker/src/staging/routes.ts`, `worker/src/tools/gate.ts`, `worker/test/transfers.test.ts`.

Interface: `ensureTransfer(env, principal, intent)` returns existing result or one pending/ticket; `retry` binds request ID to one resulting generation. Identity GET exposes only verified owner identity.

- [ ] Add tests for first-response replay, content conflict, policy allow/ask/deny, cross-action claim, stale retry ID and competing generations.
- [ ] Observe failures before implementation.
- [ ] Implement guarded D1 batches, pending linkage, identity endpoint and preclaim action checks.
- [ ] Run focused tests and inspect D1 side effects for refusals.

### 3. Upload admission, publication and recovery

Files: `worker/src/staging/upload.ts`, `worker/src/staging/transfers.ts`, `worker/src/staging/store.ts`, `worker/src/cron.ts`, `worker/test/upload.test.ts`.

Interface: admitted generation owns one deterministic object key; completion CAS commits handle, result, pending/operation and audit together.

- [ ] Add byte mismatch, generation replay, revoke/reconnect, lease boundary and late-write tests.
- [ ] Observe failures; implement bounded ingestion and fenced publication.
- [ ] Add owner/global admission and byte-debt accounting tests before their implementation.
- [ ] Confirm no failed generation publishes a handle and no replay creates another object.

### 4. Download lease, ACK and purge

Files: `worker/src/staging/store.ts`, `worker/src/staging/routes.ts`, `worker/test/staging.test.ts`.

Interface: admitted GET protects its download; ACK returns `{acknowledged:true,replayed:boolean}`; cleanup claims eligibility before deleting R2.

- [ ] Add ACK replay, expiry-during-save, owner mismatch and GET-versus-purge tests.
- [ ] Observe failures; add lease admission, tombstones and cleanup fencing.
- [ ] Rerun original reservation/consumption tests and new race cases.

### 5. Native helper and durable local state

Files: `companion/native/Package.swift`, `companion/native/Sources/`, `companion/native/Tests/`.

Interfaces: typed inherited-pipe commands for roots, snapshots, save publication, journal and auth transactions. Never accept arbitrary shell commands or tool-selected root grants.

- [ ] Add failing Swift tests for confinement, private-state overlap, exclusive publication, snapshot identity and journal recovery.
- [ ] Implement descriptor-rooted operations and SQLite reservations with synchronization.
- [ ] Add isolated Keychain adapter/lock tests before implementation; never use real credentials in tests.
- [ ] Run `swift test --package-path companion/native` and capability probes.

### 6. Companion client, CLI and stdio tools

Files: `companion/package.json`, `companion/tsconfig.json`, `companion/src/`, `companion/test/`, root package and lint configuration.

Interfaces: staging HTTP adapter with redirects disabled, native helper adapter, OAuth login, and three tools using logical roots.

- [ ] Write tests for issuer/state rejection, redirect refusal, lost first response, owner switch and explicit-key conflicts.
- [ ] Implement CLI authentication and helper-backed orchestration, then register the tools.
- [ ] Exercise text-link and URL-elicitation continuation without an MCP token.
- [ ] Run companion tests and a stdio wire round trip.

### 7. Setup recovery, integration and delivery

Files: `worker/src/auth/companion.ts`, auth registration/authorization boundaries, relevant tests; README, SECURITY.md, architecture, original design and runbooks.

- [ ] Write registration crash/quarantine tests, then implement reconciled owner repair.
- [ ] Run synthetic companion/Worker round trips and named design acceptance cases.
- [ ] Run `npm run verify` and native tests. Record unavailable live-client checks separately.
- [ ] Update docs from actual behaviour and commit verified work without pushing/deploying.

## Execution record

Implementation begins after these design corrections. Record test commands, failures, fixes and remaining acceptance evidence under the completed task rather than marking unimplemented requirements as passed.
