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

- [x] Write schema rejection tests and ownership/active-generation uniqueness tests.
- [x] Run `npm test -w @gmail-mcp/shared` and Worker transfer tests; record the expected missing-contract/schema failures.
- [x] Implement strict schemas and append-only migration, using composite ownership foreign keys and partial uniqueness.
- [x] Rerun focused tests, format and typecheck.

### 2. Worker intent, approval and generation issuance

Files: `worker/src/staging/transfers.ts`, `worker/src/staging/routes.ts`, `worker/src/tools/gate.ts`, `worker/test/transfers.test.ts`.

Interface: `ensureTransfer(env, principal, intent)` returns existing result or one pending/ticket; `retry` binds request ID to one resulting generation. Identity GET exposes only verified owner identity.

- [x] Add tests for first-response replay, content conflict, policy allow/ask/deny, cross-action claim, stale retry ID and competing generations.
- [x] Observe failures before implementation.
- [x] Implement guarded D1 batches, pending linkage, identity endpoint and preclaim action checks.
- [x] Run focused tests and inspect D1 side effects for refusals.

### 3. Upload admission, publication and recovery

Files: `worker/src/staging/upload.ts`, `worker/src/staging/transfers.ts`, `worker/src/staging/store.ts`, `worker/src/cron.ts`, `worker/test/upload.test.ts`.

Interface: admitted generation owns one deterministic object key; completion CAS commits handle, result, pending/operation and audit together.

- [x] Add byte mismatch, generation replay, revoke/reconnect, lease boundary and late-write tests.
- [x] Observe failures; implement bounded ingestion and fenced publication.
- [x] Add owner/global admission and byte-debt accounting tests before their implementation.
- [x] Confirm no failed generation publishes a handle and no replay creates another object.

### 4. Download lease, ACK and purge

Files: `worker/src/staging/store.ts`, `worker/src/staging/routes.ts`, `worker/test/staging.test.ts`.

Interface: admitted GET protects its download; ACK returns `{acknowledged:true,replayed:boolean}`; cleanup claims eligibility before deleting R2.

- [x] Add ACK replay, expiry-during-save, owner mismatch and GET-versus-purge tests.
- [x] Observe failures; add lease admission, tombstones and cleanup fencing.
- [x] Rerun original reservation/consumption tests and new race cases.

### 5. Native helper and durable local state

Files: `companion/native/Package.swift`, `companion/native/Sources/`, `companion/native/Tests/`.

Interfaces: typed inherited-pipe commands for roots, snapshots, save publication, journal and auth transactions. Never accept arbitrary shell commands or tool-selected root grants.

- [x] Add failing Swift tests for confinement, private-state overlap, exclusive publication, snapshot identity and journal recovery.
- [x] Implement descriptor-rooted operations and SQLite reservations with synchronization.
- [x] Add isolated Keychain adapter/lock tests before implementation; never use real credentials in tests.
- [x] Run `swift test --package-path companion/native` and capability probes.

### 6. Companion client, CLI and stdio tools

Files: `companion/package.json`, `companion/tsconfig.json`, `companion/src/`, `companion/test/`, root package and lint configuration.

Interfaces: staging HTTP adapter with redirects disabled, native helper adapter, OAuth login, and three tools using logical roots.

- [x] Write tests for issuer/state rejection, redirect refusal, lost first response and explicit-key conflicts; verify foreign-owner refusal in Worker tests.
- [x] Implement CLI authentication and helper-backed orchestration, then register the tools.
- [x] Exercise text-link and URL-elicitation continuation without an MCP token.
- [x] Run companion tests and a stdio wire round trip.

### 7. Setup recovery, integration and delivery

Files: `worker/src/auth/companion.ts`, auth registration/authorization boundaries, relevant tests; README, SECURITY.md, architecture, original design and runbooks.

- [x] Write registration crash/quarantine tests, then implement reconciled owner repair.
- [x] Run the synthetic companion/Worker round trip and the automated acceptance cases recorded below. Keep broader live-client and filesystem race qualification separate.
- [x] Run `npm run verify` and native tests. Record unavailable live-client checks separately.
- [x] Update docs from actual behaviour and commit verified work without pushing/deploying.

## Execution record

Implemented inline on `plan4-companion` in `.worktrees/plan4`, based on `09e7eb8`. No deployment or real Gmail send was performed. The checkboxes track the implementation workflow; they do not certify every release acceptance scenario in the design.

### Delivered behavior and regression evidence

1. Shared contracts and migration: strict metadata and identifier schemas, owner-bound transfer/generation rows, one-active-generation uniqueness, retry receipts, recovery quotas, download leases and ACK tombstones. Existing migrations were preserved.
2. Intent and approval: lost-first-response recovery, concurrent ensure, allow/ask/deny transitions, cross-action refusal before claim and competing retry receipts. Tests caught an issued-ticket replay after allow tightened to ask; issuance now fences the old ticket and returns approval without a ticket.
3. Upload and recovery: exact bytes/hash, a real 25 MiB upload, deterministic R2 keys, one active upload, account revoke/reconnect fencing, explicit retry after interruption, durable result replay and charged ambiguous writes. A boundary test caught expiry recovery cancelling a live admitted lease; cron and ensure now distinguish admission expiry from the existing lease. Byte reservations cover Gmail materialization before fetch.
4. Downloads: owner-limited concurrent GET, admission before expiry, purge protection, retained ACK replay after object-row cleanup and recovery-capacity refusal before admission. Existing staging reservation/consumption tests remain in the full suite.
5. Native helper: descriptor-rooted paths, symlink/traversal and private-overlap refusal, exclusive publication, snapshot identity, synchronized SQLite state, reservation limits, stable process lock, logout epoch and save receipt recovery. The tests caught a SQLite numeric-binding comparison bug and a save-reservation recovery issue; both were fixed. Credential tests use an isolated adapter.
6. Companion: bounded framed IPC and HTTP, redirect refusal, exact callback issuer/state, helper-owned credentials, durable upload/save orchestration, explicit-key binding and three stdio tools. Tests exercise modern URL input, legacy continuation and text fallback. A direct Node CLI launch exposed extensionless shared imports that the test transpiler accepted; explicit TypeScript imports now work in the actual entry point.
7. Registration and integration: an interrupted registration retains its attempt marker, reconciles exactly one provider client and quarantines uncertain results. Unfinalized marked clients cannot receive MCP scope. The integration test drives real Worker OAuth/staging routes from companion orchestration using a fake native port and synthetic Google service.

Failing-first evidence was retained locally in `/tmp/plan4-*-red.log`, including registration, HTTP, client orchestration, framing, receipts, authentication fencing, byte reservation, policy transition and live-lease tests. Additional concurrency and approval cases were added during review. Temporary logs are not repository artifacts; the committed tests are reproducible evidence.

### Final local checks

The final commands are `npm run verify` (format, lint, all TypeScript checks and all JavaScript tests), `npm run verify:native` (Swift tests and release build), and `git diff --check`. On 2026-09-13, `npm run verify` exited 0: 11 shared tests, 274 Worker tests and 9 companion tests passed, along with formatting, lint and all typechecks. `npm run verify:native` exited 0: all 13 Swift tests passed and the release helper built. `git diff --check` passed. The direct Node launch is included in the companion suite.

### Release checks still required

Actual browser login and personal Keychain integration, installed Claude Code/Desktop flows, target deployment, exhaustive adversarial filesystem race qualification, physical power-loss recovery and production resource measurements were not performed. Passing local and synthetic tests does not establish these results. See [the companion runbook](../../runbooks/companion.md) for setup and recovery instructions.
