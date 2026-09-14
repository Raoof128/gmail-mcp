# Plan 5: Recovery and Release Qualification Plan

> **For agentic workers:** Revision 3. Use `superpowers:executing-plans` inline after design approval. This is a Phase A implementation plan plus explicit Phase B/C gates, not an implementation-ready promise for autonomous byte continuation. No live send, deployment or destructive test is authorized by the document.

**Goal:** Resolve positively identified generated-message deliveries and bound session completions without creating another send.

**Architecture:** Version-pinned observations feed one evidence/result contract. D1 controls request admission, qualification epochs and a common settlement winner. Compatibility triggers fence old writers. Unknown draft/transport outcomes stay unknown; storage cleanup never changes delivery truth.

**Tech stack:** Existing pinned Worker/TypeScript/Vitest, D1/R2/keyring, native Swift helper. No dependency upgrade is included.

**Spec:** [Revision 3 design](../specs/2026-09-13-gmail-mcp-plan-5-recovery-design.md). **Normative implementation appendix:** [types, migration, transaction ordering, fixtures and live acceptance cases](2026-09-13-plan-5-contracts.md). Read both before executing any task, together with the [revision-3 review resolution and writer inventory](../reviews/2026-09-13-plan-5-revision3-resolution.md). The [finding resolution](../reviews/2026-09-13-plan-5-resolution.md) maps F01–F13 to these changes.

## Constraints

- Baseline `6e78bc5`; existing operations remain protocol 1/manual. New marked operations use protocol 2.
- `send_draft` search recovery is manual even if its Message-ID is preserved. No qualification override.
- Recovery sends zero additional MIME bytes; a settled promise/timeout does not prove a writer stopped.
- Limits: 26,214,400 attachment bytes; 36,700,160 encoded bytes; 262,144,000/524,288,000 owner/global staging bytes.
- Node 22.18+, macOS 26.6+, local APFS/HFS, no overwrite. Preserve Plan 4 staging recovery.
- 24h observation horizon; 7d recovery metadata retention; 8,192 bytes combined UTF-8 binding JSON + raw session ciphertext (ciphertext ≤4,124 bytes); 1,000/2,000 owner/global recovery rows.
- 32/64 owner/global qualification rows; seven-day qualification expiry; only generated_search/send_session_status modes.
- Per five-minute scheduled window: 10 operations, 2/account, 30 HTTP requests. Also 30 requests per rolling five minutes across invocations. Count token refresh and retries.
- Run 240s, attempt 45s, request including body 15s; read lease 60s. Control/error body 65,536 bytes. No internal retry sleep.
- Use fixed execution horizon and persisted backoff; provider Retry-After may exceed the 30-minute locally generated backoff cap.
- All protocol-2 state/audit writes require a same-batch permit, including direct failures. Rollback retains DB guards.
- Session URIs never appear in any report, log, audit, exception or model/client output; encrypted storage only. No credentials/MIME/address traces in public artifacts. No model-facing qualification/admin route.

## Task 1: Common SQL state and mixed-version fence (F04, F09, F12, F13)

Create `worker/migrations/0005_operation_recovery.sql`, `worker/src/operations/recovery-types.ts`, `worker/test/recovery-state.test.ts`. Modify `worker/src/tools/settle.ts`, `worker/src/tools/gate.ts`, `worker/src/operations/journal.ts`. The appendix supplies full migration SQL and exported types.

- [ ] Write a fixture that applies migrations 0001–0004, seeds two owners/accounts and protocol-1 operations using existing fixture helpers; assert queries for new protocol columns fail before the migration.
- [ ] Run `npm test -w @gmail-mcp/worker -- --run test/recovery-state.test.ts`; retain the initial failure.
- [ ] Install the appendix SQL as migration 0005. Copy shared types using the exact registry names `send_message`, `reply`, `forward`, `send_draft`.
- [ ] Add tests for composite ownership, metadata 8,193-byte refusal, malformed JSON, wrong horizon/retention, protocol downgrade and outcome without permit. Test an entire failing batch rolls back permit and all effects. Enforce purpose, owner/account, one operation transition and one matching audit per permit; cover wrong-purpose and repeated same-batch writes. Preserve immutable staging operation linkage after release so cleanup still requires a storage permit.
- [ ] Introduce permit insertion/deletion around all protocol-2 success/failure/outcome transactions; leave protocol-1 operations on legacy behavior. No standalone permit write may exist.
- [ ] Replay every baseline writer in the revision-3 inventory: operations, linked pending/staging, idempotency, audit and bulk cron, with protocol-1 controls and protocol-2 refusal fixtures; assert refusal and unchanged audit count. Execute two permitted success contenders; assert exactly one executed audit and zero remaining permits.
- [ ] Run state, gate, settlement, cron and upload regression files. Commit `feat(recovery): add guarded operation state and compatibility fences`.

Independent SQL fixtures and checks are executable through the plan conformance validator. Runtime tests must apply the installed migration in workerd as well; SQLite-only planning proof is not D1 runtime proof.

## Task 2: Credential-pinned bounded transport (F02, F06, F07)

Create `worker/src/google/recovery-http.ts`, `worker/test/recovery-http.test.ts`. Modify `worker/src/google/tokens.ts`, `worker/src/deps.ts`. Export `getAccessTokenPinned` and `recoveryRequest` exactly as the appendix declares.

- [ ] Confirm credential_version is a grant epoch: normal access-token refresh preserves N; reconnect/revoke advance N. Add token spies and barriers: reconnect before cached-token return, before refresh, after refresh response and before 401 retry. Assert no request uses the replacement credential.
- [ ] Capture failing tests before modifying token code.
- [ ] Implement required expected-version checks before decrypt, on refresh writes and after acquisition. Recovery injects an admitted fetch wrapper for OAuth refresh; it never calls ordinary gmailFetch's retry loop.
- [ ] Test request admission refused at zero credit, expired run/attempt/request deadlines, 65,537-byte body and a body that stalls after successful headers. Include refresh and 401 repeat in the request count.
- [ ] Implement bounded incremental body reads and cancellation; preserve Retry-After in typed responses; every request gets redirect refusal and an AbortSignal bounded through body EOF. Normalize errors to the finite observation reasons.
- [ ] Test 429 Retry-After 1200 and 3600 seconds: one request, no sleep; computed retryAt is at least the provider time. Add valid future/past HTTP dates, malformed, negative and overflow values; max(local, provider) persists, and at/beyond horizon no further request is scheduled.
- [ ] Run `test/recovery-http.test.ts`, `test/tokens.test.ts`, `test/gmail-client.test.ts`. Commit `security(recovery): pin credentials and bound every observation request`.

Token acquisition and outbound request admission are distinct checks. A concurrent revoke after request admission cannot retract a credential already in flight; tests must not claim that stronger guarantee.

## Task 3: Exact URL and status parsing (F05, F10, F11)

Create `worker/src/google/resumable.ts`, `worker/test/resumable.test.ts`; modify existing `worker/src/google/gmail.ts` to use the validator before the original PUT obtains a token. The appendix defines the interface and design section 5 supplies the entire allowed grammar.

- [ ] Add raw traversal/encoded separator/unknown query/duplicate key/case/userinfo/foreign host tests and the exact two send prefixes plus original-upload draft create/update endpoints. Original-upload endpoint binding is mandatory; draft sessions still cannot enroll recovery. Assert rejection before token lookup. Copy both documented Range forms into fixtures.
- [ ] Capture red tests with `npm test -w @gmail-mcp/worker -- --run test/resumable.test.ts`.
- [ ] Implement raw validation before `new URL`, then verify parsed components. No generalized URL/path builder accepts user input. Thread the typed UploadEndpoint from the existing upload caller into original PUT validation; test >5 MiB draft create/update still work and cannot enroll recovery.
- [ ] Implement zero-body status headers and bounded send-v1 final response parsing. For 308, parse only the two specified Range forms; reject overflow/regression and return awaiting_final when offset equals total.
- [ ] Run tests for expired session, all bytes without final receipt, missing range after progress, malformed body, 308 + valid Range without Location → valid incomplete status; distinguish 308 from other redirects. Test 404 and 410 separately → unknown/key held. No status case admits a byte continuation.
- [ ] Run resumable and existing send-pipeline tests; commit `security(gmail): validate session grammar and typed completion receipts`.

Representative production-imported test:

```ts
import { it, expect } from "vitest";
import { parseSessionStatus } from "../src/google/resumable";
it.each(["bytes=0-42", "0-42"])("accepts bounded status range %s", (range) => {
  expect(parseSessionStatus(308, range, 100, 0, new Uint8Array(), "send-v1")).toEqual({
    kind: "incomplete",
    nextOffset: 43,
  });
});
it("does not infer delivery from a full offset", () => {
  expect(parseSessionStatus(308, "0-99", 100, 0, new Uint8Array(), "send-v1")).toEqual({ kind: "awaiting_final" });
});
```

## Task 4: Durable binding and phase-aware failures (F01, F04, F05)

Create `worker/src/operations/recovery-state.ts`, `worker/test/recovery-binding.test.ts`. Modify `worker/src/operations/send.ts`, `worker/src/tools/send.ts`, `worker/src/tools/gate.ts`, `worker/src/tools/idempotency.ts`. Export `beginRecoverableOperation` and `recordFailure`.

- [ ] Test generated Message-ID equals regenerated `<operationId@host>`; arbitrary header/draft cannot enroll search. Persist executor/result version, pending id and safe audit counts.
- [ ] Test binding failure, account version change and recovery-cap exhaustion all prevent byte fetch. Capture red tests.
- [ ] Implement the appendix begin transaction: permit, preconditions, cap checks, binding, protocol2/byte flag/executing, permit deletion. Encrypt and persist validated session before original PUT. Zero-byte session initialization may precede binding; failure afterwards sends no MIME.
- [ ] Change failure handling so only claimed/no-byte can be failed_safe. Executing/unknown transport errors retain unknown regardless of HTTP class. A late error first replays existing terminal success.
- [ ] Test expired/401 session after ambiguous bytes keeps idempotency held; completed local promise/AbortError never triggers another byte attempt. Ambiguous send_draft records manual recovery immediately.
- [ ] Run binding, send/draft, idempotency/gate and staging tests; commit `fix(operations): bind recovery and preserve ambiguous delivery`.

## Task 5: Positive evidence and one normalized winner (F01, F05, F13)

Create `worker/src/operations/reconcile.ts`, `worker/test/reconcile.test.ts`, `worker/test/recovery-settlement.test.ts`. Implement `observeDelivery`, `settleRecovered` and `settleDirect`. Use appendix Proof and Observation unions without casts between session and search evidence.

- [ ] Add `earlier-sent-copy-same-message-id-does-not-confirm-current-draft`, with a same-thread, same-header SENT copy from one minute before start; expected manual_draft even under qualification.
- [ ] Add generated-id candidate tests: zero, multiple, further page, duplicated header, wrong thread, absent SENT and invalid timestamp. Add valid session final response while search is empty.
- [ ] Pin search to rfc822msgid:<internally-generated-id>; fetch metadata through the pinned account, require exact single Message-ID, SENT, expected thread, valid time bounds and one candidate with no next page. Zero candidates defer then manual_unknown at horizon, never failed_safe.
- [ ] Capture red tests; implement generated-only search and bound session receipt validation under the exact design rules. Return deferred/suspended reasons without inventing metadata.
- [ ] Implement one success transaction for both evidence paths and direct replies. Persist first result, compare identity by id/thread, and retain original label set on replay.
- [ ] Add two success contenders, changed-label replay, conflicting result id, pending already failed/unknown, missing expired handles, changed epoch/version, and failure at each SQL statement. Assert one executed audit, exact stored result, cleared pending error and zero permits.
- [ ] Run reconcile/settlement plus gate/cron/upload regressions; commit `feat(recovery): settle bound delivery evidence exactly once`.

## Task 6: Durable scheduler and retention (F06, F07, F09)

Create `worker/test/recovery-cron.test.ts`, `worker/test/recovery-retention.test.ts`. Modify `worker/src/cron.ts`, `worker/src/index.ts`, `worker/src/operations/recovery-state.ts`; keep `recoverUploads` separate. Implement `claimRecovery` and `recoverDeliveries` using scheduledTime only for window identity/deduplication and freshly sampled server time for rolling credits, deadlines and leases. Never substitute scheduledTime for admission time.

- [ ] Add two concurrent/disjoint cron invocations and a retried invocation for the same scheduled window. Seed at least 12 rows across three accounts. Deliver the 12:00, 12:05 and 12:10 windows together at 12:14 and assert thirty requests total in actual rolling time. Assert 10 attempts/window, 2/account, 30 requests/window and 30/rolling five minutes including refresh.
- [ ] Test no duplicate attempt per operation/window; defer account-exhausted rows without starving another account. Test a run that reaches 240s never admits a later request, even under a still-live lease.
- [ ] Capture red tests. Implement asserted attempt/request transactions from the appendix with qualification predicates in the same batch. No JS counter is the authoritative global limit.
- [ ] Add fixed-horizon and provider-backoff tests; repeated state updates must not extend the horizon. Persist provider lower bound and stop if it exceeds the horizon.
- [ ] Add cleanup tests: ciphertext gone after horizon/disable/revoke; metadata gone after seven days; original operation/key unchanged; late direct success still settles from original context after metadata/handles are deleted; metadata and qualification cap refusal before side effect; old scheduler events pruned without reopening a current counter.
- [ ] Implement bounded cleanup and run all cron, staging and token regressions. Commit `feat(recovery): enforce durable observation budgets and retention`.

## Task 7: Qualification administration and storage repair (F08, F09, F13)

Create `scripts/qualification/build-id.ts`, `admin.ts`, `manifest.ts`, `admin.test.ts`, `build-id.test.ts`; modify `worker/src/env.ts` and deployment config to expose embedded BUILD_ID and profile. Add qualification tests to the root workspace test discovery explicitly, using existing Vitest and the fixture transport, not a new dependency.

- [ ] Write build-id tests: docs-only change preserves digest; production source/lockfile/migration/config change alters digest; input order cannot alter digest; dirty production input refuses.
- [ ] Write manifest/admin tests: stale epoch after disable/prune/recreate, supplied-but-unverified SHA, foreign account/version, probe in normal profile, >20 fixture ids, cap exhaustion and credential spies on preflight refusal.
- [ ] Capture red tests. Implement the appendix canonical build algorithm and private admin CLI. Validate the actual platform deployment receipt and embedded build before qualification writes; use bound D1 parameters only.
- [ ] Implement probe/enabled/disabled state changes with fresh 256-bit random epochs on creation and every edit and seven-day expiry. There is no public Worker route. Add claims/settlement tests proving disabled or wrong epoch fences paused jobs.
- [ ] Implement abandon-storage with exact operation scope, operator intent receipt and known-published/stopped R2 producer checks. Mark selected source objects deleting without making their handles reusable. Keep unknown operation/key unchanged; retain debt if producer stop cannot be established.
- [ ] Test interruption before/after object delete, foreign/unrelated handle refusal, unknown producer refusal including DELETE-then-late-PUT resurrection schedule (refuse before DELETE), and later direct positive delivery receipt after abandonment. Record counts/hash-only administrative outcomes.
- [ ] Run qualification/admin, scheduler and storage regressions. Commit `feat(qualification): bind trusted evidence and owner storage repair`.

## Task 8: Fault harness and executable live runner (F08, F12)

Create `worker/test/recovery-faults.test.ts`, `scripts/qualification/run.ts`, `preflight.test.ts`, `cases/gmail.ts`, `cases/clients.ts`, `cases/native.ts`, `cases/resources.ts`, `docs/runbooks/release-qualification.md`. The appendix defines TestCase/CaseResult, context, credential handling and sample/stop rules.

- [ ] Add deterministic injected barriers for operation bound, reservation, MIME start, headers, partial bytes, provider commit, response, each D1 statement, settlement commit, qualification disable and reconnect. No public fault injection route.
- [ ] Task 8 barrier executions are synthetic/local only. Real Gmail barriers belong to Phase C/Task 9 and require concrete authorization. Execute each applicable barrier on media/multipart/resumable direct send and draft direct send. At most one mutation is necessary but not sufficient: assert exact positive result or explicit unknown, key/reservation state and executed-audit count.
- [ ] Implement `run.ts --manifest <private-path>` with the explicit case registry and preflight before credential access. Use real Worker MCP/native adapters for live cases; synthetic execution cannot issue an enabled qualification record.
- [ ] Freeze RunIdentity and verify deployment/config/component identities before and after each live case, on each credentialed response and at enable under exclusive deployment control. Drift stops the whole run; remaining cases are not_run. Add deployment drift, delayed cron, grant-change, permit rollback, session/search race and cleanup/late-proof barriers.
- [ ] Implement isolated private evidence writer with 0700 directory/0600 atomic files outside repos and attachment roots, and redacted public projection. No session URI or token in private results either. Record failure/not-run once; no automatic repeated live attempts to obtain green output.
- [ ] Test the runner in synthetic mode: complete case selection, early-stop safety failures, schema-invalid artifact refusal, missed mandatory case exits nonzero and secrets absent from public results.
- [ ] Run `npm run verify` and `npm run verify:native`; commit `test(recovery): add adversarial schedules and qualification runner`.

## Task 9: Compatibility rollout and Phase C evidence (F12, F13)

This task can prepare artifacts locally. Actual deployment, recipient-bearing fixtures or power loss require the corresponding concrete owner authorization. A missing prerequisite remains not-run.

- [ ] Install migration guards before compatible protocol-2 code; keep all recovery modes disabled. Verify normal protocol1 behavior and protocol2 permit behavior in the migration test harness.
- [ ] Run mixed-version test: replay the exact baseline old settlement SQL against a new marked row after a new winner; assert DB refusal, unchanged stored result, no second executed audit. Pause a recovery job across disable/re-enable; assert stale epoch refuses even after control-row pruning/recreation. Test the rollback-floor cron with stale protocol1 and protocol2 operations plus a recoverable staging transfer; unrelated maintenance must complete.
- [ ] Implement the appendix restore-floor contracts in installation.ts, restore-floor.test.ts and private restore.ts; wire all mutation ingress/cron/qualification checks. Test pre-0005 restore and restored old epoch/active marker against external restore generation. Test a sent operation lost from the snapshot: service must remain frozen, never treat its missing key as fresh. Phase A restores stay quarantined pending a separate incident reconciliation plan.
- [ ] Prepare a release manifest with build/deployment ids, migration list, exact target and scratch recipients. Document rollback to a compatible writer; only rollback targets containing the permit-aware writer, linked-write guards, protocol-separated cron and installation/restore checks on every mutation ingress qualify as compatibility version 3. Refuse pre-floor rollback targets; retain triggers.
- [ ] If authorized, run appendix qualification cases with the exact sample counts/stop rules. Match sender/recipient allowlists, verify deployment build, and save private failure evidence as well as successes.
- [ ] Qualify real Code/Desktop/claude.ai flows and supported native runner. No hosted macOS image is assumed compatible; no process kill substitutes for physical power loss.
- [ ] Record memory and CPU under the actual deployed limits; keep numerical memory gate not-run if profiling cannot establish peak isolate memory. Never infer it from Node RSS or zero runtime errors alone.
- [ ] Update main spec, README, architecture and runbooks from observed behavior, retaining pre-release for unmet mandatory gates. Run final verify/native/diff checks; commit verified work. Push/merge/deploy only within current implementation authorization.

## Phase B unpaid contract

Phase B is not paid by Tasks 1–9. Create a separately reviewed subplan only after provider behavior is qualified. It must specify immutable encrypted MIME chunk format/manifest/AAD, source pinning and per-chunk range reads, reserve encoded bytes plus encryption overhead in existing global quotas, one retained MIME per owner, one global materializer/writer, 24h retention, three total byte admissions, and cleanup debt for uncertain R2 producers.

It must also identify a provider-supported preceding response that authorizes another writer. Promise settlement, cancellation, elapsed lease or status alone cannot supply that proof. A completed final send needs no continuation. Until such a protocol is established and approved, retain status-only/manual behavior and `phase_b_verified=false`. This explicit boundary resolves the former outline's overclaim; it does not assert byte continuation is implemented.

## Planning verification and acceptance

The plan conformance script validates the appendix migration on an isolated in-memory SQLite fixture, protocol-2 mixed-writer refusal, the two status grammars and raw URL counterexample, and source tool-name consistency. These are planning checks; they do not substitute for workerd integration, live Gmail or native qualification.

F01–F13 each has a resolution/test row in the resolution record. The original gauntlet and its line ledger remain historical; revised inputs receive separate hashes. Implementation starts only after the owner approves revision 3. No prior formatting pass or baseline test count is presented as proof of the proposed code.
