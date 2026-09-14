# Plan 5 revision 3 — complete review bundle

All four normative documents follow in full. Fenced source preserves their exact text; resolve internal relative links against the original source path shown above each block. Review all four together. The [writer inventory](2026-09-13-plan-5-writer-inventory.csv) and [manifest](2026-09-13-plan-5-revision3-manifest.json) accompany this bundle.

## 2026-09-13-gmail-mcp-plan-5-recovery-design.md

Source: `docs/superpowers/specs/2026-09-13-gmail-mcp-plan-5-recovery-design.md`

```markdown
# Plan 5: Delivery recovery and release qualification

Revision 3, addressing gauntlet F01–F13. Draft for owner approval; no implementation, deployment or live sends have been authorized by this document. Baseline `6e78bc5`. Execute inline when approved.

## 1. Scope and proof boundary

Phase A implements generated-message search, bound resumable-session status, version-pinned observation, common settlement and qualification controls. Existing `send_draft` delivery can settle from its direct response, but **search-only draft recovery is manual**. Preservation of an arbitrary draft Message-ID, a timestamp, a matching thread and a negative pre-send search do not prove this send occurred. No qualification mode can override this restriction.

Phase B is a separately approved continuation project. Plan 5 does not claim an execution-ready byte-continuation implementation. Its unpaid work is recorded in the [implementation plan](../plans/2026-09-13-gmail-mcp-plan-5-recovery-and-release.md#phase-b-unpaid-contract). Until that project proves its writer protocol, recovery never sends additional MIME bytes. Phase C qualifies the complete application. Record `phase_a_verified`, `phase_b_verified` and `release_qualified` independently.

A generated Message-ID is `<operationId@configuredWorkerHostname>`, created once by the server for a new `send_message`, reply or forward operation. Require equality with this generated value before registering search recovery. No imported/user-supplied/draft Message-ID is eligible. The proof assumes the existing trust boundary: an adversary cannot forge arbitrary SENT mailbox content or rewrite the operation journal. Mailbox-owner/admin forgery is outside that boundary. A matching message proves a sent mailbox record, not recipient acceptance/read status.

The encoded MIME ceiling remains 36,700,160 bytes; attachment ceiling remains 26,214,400 bytes. The existing 5 MiB media selection and 250/500 MiB owner/global staging budgets remain. Plan 4 recovery stays separate.

## 2. Durable state and common settlement

The [contract appendix](../plans/2026-09-13-plan-5-contracts.md) defines SQL, types, transition predicates and test vectors. Migration `0005_operation_recovery.sql` adds protocol-2 marker/result identity fields to operations, bounded recovery rows, qualification controls, scheduler counters and transaction permits. Existing operations retain protocol 1 and are never automatically recovered. No fabricated context is backfilled.

Bind owner, account, credential version, operation id, executor/result version, generated Message-ID, original thread, start time, encrypted session, length, pending id and bounded audit counts before the first byte request. The binding and `claimed → executing` transition are one asserted transaction. The result shape is versioned `send-v1`: `{gmail_result_id, message:{id,thread_id,label_ids}}`; the existing gate supplies outer status/account/action_id. Persist only identifiers and audit counts, never send body/subject/recipient addresses. Session encryption uses current keyring and AAD field `operation-recovery:v2:<operationId>:session` plus owner/account. Key rotation re-encrypts only under a matching row/account fence.

Success evidence is a discriminated union: a generated-ID search observation or a validated final receipt from this operation's immutable stored session, plus direct responses on the original execution path. Session receipts require no invented timestamp/header and no secondary search. All variants normalize to `send-v1`; compare terminal identity by message id AND thread id, not current labels. The first winner stores its label set/result; same-identity replay returns that exact stored result. Different identity refuses as conflict and leaves the winner unchanged.

For protocol 2, all operation-state updates, linked pending/staging changes and outcome audits require a short-lived D1 permit inserted and deleted in the same batch. A database trigger rejects old code that tries to update or audit a marked operation without a permit. No permit survives commit. Purpose and counters allow one operation transition and one matching owner/account outcome; idempotency bindings and retained operation identity cannot be erased. The appendix adds a permanent staging linkage and storage-only permits for later cleanup. This covers direct success, definitive pre-byte failure, unknown outcomes and recovery success, including older Worker code during rollout. A success batch asserts eligible state before effects, captures the unique winner, consumes any remaining handles, redacts an executing or failed/`delivery_unknown` pending row, clears its error, writes one executed audit and finishes recovery. Prior unknown audits remain historical; the invariant is one _executed_ audit, not one audit across the operation's lifetime.

A late executor error first reads terminal identity; if another writer already succeeded, return that winner. If no terminal success exists, `failed_safe` is allowed only while a row is `claimed` and the byte-attempt marker is absent. Once `executing`/byte-admitted, every transport exception or 4xx remains unknown unless an operation-specific no-effect proof is introduced in a separately reviewed change. This intentionally favors false unknowns over duplicate sends. Failed-safe never revives an executed or ambiguous operation. Change `tools/gate.ts` and idempotency regression tests as part of Phase A, not only the probe parser.

## 3. Credential authority and transport

`credential_version` is the existing grant epoch: reconnect/revoke increment it; normal access-token refresh does not. Recovery calls a new required-version API, not the existing unpinned `gmailFetch`. `getAccessTokenPinned` checks expected version before decrypting a cached token, uses the same version for guarded refresh writes, and checks it again after token acquisition. A reconnect before the next network admission suspends recovery. A 401 permits at most one pinned refresh and repeat; it may never acquire a newer account version.

Immediately before each Google network request, one D1 admission transaction checks active account/version, qualification state/epoch/build, current recovery lease, deadlines and durable counters. This is the authorization linearization point. An already admitted request may leave the process after concurrent revocation; no claim is made that an in-flight credential can be recalled. Late observation settlement is separately fenced. Recovery never uses version N+1 for an operation bound to N.

Use `recoveryRequest` for search, metadata, status and token-refresh HTTP; inject its bounded fetch into the pinned token helper. Disable internal retries/sleeps. Every actual request, including refresh and 401 repeat, consumes a request slot before fetch. Request deadline includes headers AND complete body consumption; read the body incrementally and abort/cancel on timeout/byte overflow. Control JSON and error bodies are limited to 65,536 bytes. Refuse more than two candidates before metadata reads. AbortSignal is a local deadline, never remote writer-termination evidence.

Use actual fresh server admission time for rolling counters, deadlines and leases; scheduledTime is window identity only. Delayed windows all executing at 12:14 share the same actual rolling budget. Each scheduled five-minute window has a durable counter keyed by `floor(scheduledTime / 300000)`. Across concurrent/retried invocations, permit ten operations, two per account, thirty external requests. Additionally impose a global rolling five-minute request ceiling of thirty using a bounded event ledger, so old-window traffic cannot evade the cap after overlap. Per operation at most 288 attempt admissions, at most one admission per scheduled window, and a fixed 24-hour horizon from start. Reserve an attempt slot once, not once per retry.

Run deadline is invocation start + 240 seconds; attempt deadline is min(run deadline, start + 45 seconds, operation horizon); request deadline is min(attempt deadline, now + 15 seconds). Check clock/deadline at admission and after body read. A 60-second read lease includes a random token; lease alone grants no network request or settlement. Defer rows not reached before run cutoff without incrementing their attempts. Sort by next due time, last attempt, creation, id; skip account-exhausted rows so they do not starve other accounts. Delete scheduler events older than 24 hours after bounded cleanup. Refuse new request/attempt admission if the physical ledgers reach 9,000 request rows or 3,000 attempt rows, including expired rows awaiting cleanup; cleanup failure cannot cause unbounded growth.

Transport results carry `observed`, `deferred` with `retryAt`, or `suspended`, never a generic error that discards Retry-After. Locally generated exponential backoff is min(30 minutes, 5 minutes × 2^min(attempt-1,3)) with no in-process sleep. Valid provider Retry-After is a lower bound even when above thirty minutes. If it reaches/passes the operation horizon, stop automatic observation and mark manual; do not shorten the provider delay. Invalid/negative/unparseable Retry-After uses local backoff. A 401 refresh also obeys all budgets and deadlines.

## 4. Evidence collection

Search only protocol-2 generated-message rows with active qualification. Construct the query from the internally regenerated Message-ID, with exact `SENT` filter and at most two result ids. No free-text field enters search. Fetch only ids, labels, internalDate and all Message-ID headers. More pages, more than one candidate, duplicate headers, different expected thread, missing SENT, invalid timestamp or mismatched generated id is inconclusive.

For eligible generated messages require start minus two minutes ≤ internalDate ≤ fixed horizon, plus the exact identifier. Time is a consistency filter, not a causal proof. Empty search at any time remains unknown. For arbitrary drafts, do not search for automatic settlement; record `manual_draft` immediately after ambiguous direct response. Qualification can measure draft behavior for future work but cannot enable draft search. Include a same-thread, same-Message-ID, earlier-SENT-copy regression, not only a different-header case.

A session completion is bound by owner/account/operation, encrypted session identity, content length and expected endpoint/result kind `send-v1`. A final 200/201 with valid bounded message id/thread id and optional labels yields a session receipt. Do not accept draft-write results in Phase A. Other resource types are manual. Search and session evidence remain separate until common normalization/settlement.

## 5. Exact session protocol

Validate the raw URL before constructing `URL`: UTF-8 ≤ 4,096 bytes; ASCII only; no whitespace/control/backslash/fragment/userinfo; raw path rejects percent escapes and `.`/`..` segments. Only literal HTTPS authorities `gmail.googleapis.com` or `www.googleapis.com`, optionally `:443`, are accepted. Case variants are refused deliberately. The parsed origin/hostname/path must then match the raw grammar. This catches `%2e%2e` before parser normalization.

Allowed Phase A paths are exactly `/upload/gmail/v1/users/me/messages/send` and `/resumable/upload/gmail/v1/users/me/messages/send`. Query consists of exactly one `uploadType=resumable` and one `upload_id=[A-Za-z0-9_-]{1,1024}`, in either order, with no percent encoding, empty component, duplicate or other key. This selected conservative grammar includes a documented fixture; live variants outside it remain disabled pending a reviewed grammar revision. Never assume an observed URI is safe merely because Google returned it. Pass an explicit typed endpoint to validation. The ORIGINAL upload path must also support bound `draft_create` and `draft_update(draftId)` endpoints under the same two prefixes, with `draftId` matching `[A-Za-z0-9_-]{1,256}`. Those sessions remain ineligible for automatic recovery. This preserves current large-draft create/update behavior without accepting a cross-endpoint session. Status recovery still accepts only a send endpoint.

Status request: `PUT`, zero body, `Content-Length: 0`, `Content-Range: bytes */<exact-total>`, redirects disabled. A 308 with valid Range is valid incomplete status even without Location; other redirects remain refused. For 308 accept only trimmed `bytes=0-N` or `0-N`, decimal safe-integer N, no comma or other unit. Both forms are explicit compatibility choices based on Google's differing examples. Require next offset N+1 in [previousOffset,total]. Missing Range means zero only when previousOffset is zero. Offset equal to total with 308 is `awaiting_final`, not complete and never a byte-continuation instruction. Final response schema, not byte count, proves completion. 404/410, malformed ranges, oversize bodies and invalid final JSON remain unknown/deferred with no resend. Preserve documented unsupported variants as failed qualification evidence.

Google's guide supplies the status request and both Range examples; live compatibility still needs scratch qualification. [Gmail uploads](https://developers.google.com/workspace/gmail/api/guides/uploads#resume_an_interrupted_upload).

## 6. Qualification trust and bootstrap

The trusted actor is the deployment operator with existing Cloudflare D1/deploy authority, not an MCP caller. Add a private administrative CLI `scripts/qualification/admin.ts` that validates a manifest then uses the platform's authenticated D1 API with bound parameters. It has no Worker public route and obtains its platform credential through the protected runner credential facility. The threat model trusts the deployment operator who can already replace Worker code. No additional anonymous/model-accessible qualification writer exists.

Embed `BUILD_ID` in the deployed bundle from the canonical hash of the exact production Worker sources, relevant shared sources, dependency lockfile, migrations and deployment configuration excluding BUILD_ID itself. Document the sorted UTF-8 path/content framing algorithm in the contract appendix. Include native/client build identities separately in evidence; they do not enable Worker modes. Docs/evidence changes do not change the production bundle hash. The CLI verifies the deployed artifact/build identity through the platform deployment record; a supplied manifest SHA alone is insufficient.

Mode enum is `generated_search` or `send_session_status`. Qualification key is origin/build/account/credential-version/mode; state is `probe`, `enabled`, or `disabled`; each create or state change generates a fresh 256-bit random epoch, including recreation after pruning; stale manifests may not choose/reuse it. Enabled evidence expires after seven days; earlier explicit disable, build change or reconnect invalidates it. Preflight checks profile, origin, expected build, scratch sender and scratch recipient before acquiring any Gmail credential. The appendix freezes run/deployment/build/epoch/manifest identity across every live case and final enable under exclusive deployment control; drift aborts the whole run. Session URI never appears in private or public reports, logs, exceptions, audits or model/client output. Private files are owner-only and outside repos/attachment roots. Private manifests contain necessary preflight identities; public evidence contains only case ids, build ids, pass/fail/not-run, time, hashes and bounded limitations.

Bootstrap uses a separate scratch Worker/D1/R2/OAuth environment with `RECOVERY_PROFILE=scratch`. The operator may create a `probe` qualification record only there, containing an explicit allowlist of at most twenty fixture operation ids produced by the authorized harness. Cron admits probe mode only for those rows; normal environments never honor probe records. This exercises the real recovery path while default recovery remains disabled elsewhere. After the harness verifies evidence, the operator promotes an enabled record for the exact qualified target. Evidence never transfers automatically from scratch to another origin/account; a target needs its own authorized fixtures.

## 7. Retention, caps and owner repair

Reserve recovery metadata before side effects. Limit unredacted recovery rows to 1,000 per owner / 2,000 global, with at most 8,192 combined UTF-8 binding JSON bytes plus raw session ciphertext bytes, with ciphertext alone ≤4,124 bytes; this is a payload budget, not total SQLite row storage; each account has at most two qualification modes per build, and all qualification history is capped at 32 rows per owner / 64 global. Admission at a cap refuses before Gmail bytes; it does not silently fall back to untracked recovery. Scheduler records have the bounds in section 3. Staging and any future MIME reservations share the existing byte budget.

At the 24-hour horizon, or earlier disable/revoke, clear encrypted session and key id, stop automatic search, and record manual/suspended disposition. Keep recovery metadata (without session secret) for seven days from first execution, then delete it. A protocol-2 marker, immutable result identity and existing idempotency outcome remain on the original operation row. These extend the existing journal; this plan does not claim the existing whole journal has bounded lifetime storage. No recovery cleanup deletes idempotency keys or changes unknown to failed-safe.

At deadline an unresolved send's held attachment may still occupy capacity. Add a private owner/admin `abandon-storage` procedure: select exact owner/account/operation; disable further observation/continuation, rotate qualification epoch, verify each source object's R2 producer is known stopped/published, record operator intent, atomically mark eligible held objects deleting and prevent reuse, then delete and release their storage charge after confirmed deletion. A send may still complete remotely; its operation and key remain unknown and any later positive receipt may still be recorded by a compatible direct writer. This is deliberate abandonment of bytes, not evidence that Gmail did nothing. If an R2 producer may still write, retain debt; successful deletion or elapsed time alone does not release it. The CLI must refuse a foreign owner, unknown R2 producer or reused object, and must not release unrelated handles.

## 8. Rollout and rollback

Install migration/trigger guards first. Deploy a preparatory protocol-2 writer release with automatic recovery disabled. New protocol-2 operations use permits; old protocol-1 operations remain legacy/manual. The DB guards reject old direct settlement/audit statements touching marked operations, including same-state updates/audits. Before enabling observation, run a mixed-version fixture proving old code cannot create a second outcome for a marked row. Do not remove the triggers on rollback.

Each recovery network admission and success settlement checks the captured qualification epoch and current enabled/probe state. Disable rotates epoch, so a paused job cannot settle after reactivation under another epoch. The supported rollback floor is the preparatory release certified as compatibility version 3, containing the protocol-2 writer, linked-write guards, installation/restore checks on every mutation ingress, and a cron that bulk-promotes protocol 1 only and handles protocol 2 through permits. A pre-floor binary is not a supported rollback target: its bulk cron could abort unrelated cleanup. The admin deployment check refuses that target, and a forced rollback must be repaired to the floor before maintenance resumes. Compatible direct responses are independent delivery evidence and may settle through their original protocol-2 permit even while automatic observation is disabled. Test rollback to the compatibility floor with stale protocol-1 operations and staging recovery as well as protocol-2 rows; unrelated maintenance must continue. Never restore old behavior by dropping guards or deleting ambiguous journal rows.

The [revision-3 appendix](../plans/2026-09-13-plan-5-contracts.md) is normative for database restore: external deployment restore generation, maintenance routing, drained writers, schema floor and frozen restored marker. A restored database may have lost records of already-sent mail. Phase A cannot resume mutations after Time Travel; keep quarantine until a separately reviewed incident reconciliation plan establishes lost-interval handling and fresh qualification. An old active row or epoch restored from D1 cannot override external maintenance routing.

## 9. Qualification and completion

The [implementation plan](../plans/2026-09-13-gmail-mcp-plan-5-recovery-and-release.md) specifies executable harness entry points, isolated fixtures and numeric acceptance criteria. Credentialed runs require a concrete authorized target and recipients; unavailable prerequisites stay not-run. No live run is authorized by approval of planning edits.

Required local proof includes transport/body bounds, credential ABA races, both Range forms, strong session evidence with empty search, reused draft id refusal, direct/error/recovery races, D1 rollback at each statement, global budgets, metadata expiry, storage abandonment and mixed-version disable/rollback. Never loosen a check to increase resolution coverage.

Release requires the explicitly listed live Gmail, installed-client, native and resource gates. Node 22.18+, macOS 26.6+, local APFS/HFS and overwrite denial remain. Historical Plan 4 test counts are not current qualification. Peak isolate memory requires actual profiler evidence where supported; process RSS is not a substitute. If that metric cannot be measured, the numerical memory gate stays not-run. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## Phase B writer rule

A local promise resolving/rejecting, AbortError, timeout, D1 lease expiry or completed status probe is never by itself a remote-writer stop receipt. A final provider completion closes the send and needs no continuation. Any other continuation requires a separately qualified provider guarantee permitting suffix admission after the specific preceding response. Unknown transport outcomes stay status-only/manual. Phase B must persist one immutable encrypted MIME, count encrypted overhead, retain unknown R2 writer debt, cap total byte admissions at three and prove account/epoch fencing before receiving implementation approval. No such guarantee is claimed here.
```

## 2026-09-13-gmail-mcp-plan-5-recovery-and-release.md

Source: `docs/superpowers/plans/2026-09-13-gmail-mcp-plan-5-recovery-and-release.md`

````markdown
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
````

## 2026-09-13-plan-5-contracts.md

Source: `docs/superpowers/plans/2026-09-13-plan-5-contracts.md`

````markdown
# Plan 5 revision 3 contracts

This appendix is normative for Phase A. SQL and pure fixtures below are executable planning artifacts, not installed migrations or production code. The implementation plan owns integration and runtime red/green tests. Phase B is outside these interfaces.

## Shared types

Place these types in `worker/src/operations/recovery-types.ts`; import the existing `Env` and `Deps` where an implementation signature uses them. Time values are integer epoch milliseconds. Validate all wire values at runtime; TypeScript alone is not validation.

```ts
export type UploadEndpoint = { kind: "send" } | { kind: "draft_create" } | { kind: "draft_update"; draftId: string };
export type RecoveryMode = "generated_search" | "send_session_status";
export type SendResult = {
  gmail_result_id: string;
  message: { id: string; thread_id: string; label_ids: string[] };
};
export type Binding = {
  operationId: string;
  userId: string;
  accountId: string;
  credentialVersion: number;
  executor: "send_message" | "reply" | "forward" | "send_draft";
  resultVersion: "send-v1";
  generatedMessageId: string | null;
  threadId: string | null;
  pendingId: string | null;
  startedAt: number;
  mimeLength: number | null;
  buildId: string;
  origin: string;
  audit: { action: string; modifiers: string[]; recipients: number; attachments: number };
};
export type Candidate = {
  id: string;
  threadId: string;
  labels: string[];
  messageIds: string[];
  internalDate: number;
};
export type Proof =
  | { kind: "generated_search"; operationId: string; candidate: Candidate }
  | { kind: "session_receipt"; operationId: string; sessionDigest: string; result: SendResult };
export type Observation =
  | { kind: "confirmed"; proof: Proof }
  | {
      kind: "deferred";
      retryAt: number;
      reason: "not_found" | "ambiguous" | "throttled" | "budget" | "transport" | "awaiting_final";
    }
  | { kind: "suspended"; reason: "account_changed" | "disabled" | "expired" | "manual_draft" | "invalid_evidence" };
export type SessionStatus =
  | { kind: "complete"; result: SendResult }
  | { kind: "incomplete"; nextOffset: number }
  | { kind: "awaiting_final" }
  | { kind: "unknown"; reason: "expired" | "invalid_response" };
export type Lease = {
  operationId: string;
  token: string;
  until: number;
  qualificationEpoch: string;
  mode: RecoveryMode;
};
export type Deadlines = { runUntil: number; attemptUntil: number; requestUntil: number };
export type HttpObservation =
  | { kind: "response"; status: number; bytes: Uint8Array; range: string | null; retryAfter: string | null }
  | { kind: "deferred"; retryAt: number; reason: "budget" | "transport" }
  | { kind: "suspended"; reason: "account_changed" | "disabled" | "expired" };
```

Executor literals above must match the actual registry before integration. The baseline registry names are checked by the plan validator; changing a tool name requires a versioned binding amendment, not casting an unknown string. Do not accept a draft binding for search or a draft-write response for `send-v1`.

Implementation signatures:

```ts
// Existing tokens.ts: pinned variant retains current unpinned API for unrelated callers.
getAccessTokenPinned(env: Env, deps: Deps, userId: string, accountId: string,
  options: { expectedVersion: number; forceRefresh: boolean }): Promise<string>;
// deps.googleFetch used for refresh must already be the bounded/admitted wrapper.
validateSessionUrl(raw: string, expectedEndpoint: UploadEndpoint): URL;
parseSessionStatus(status: number, range: string | null, total: number,
  previousOffset: number, body: Uint8Array, resultVersion: "send-v1"): SessionStatus;
beginRecoverableOperation(env: Env, binding: Binding, sessionUrl: string | null): Promise<void>;
claimRecovery(env: Env, operationId: string, windowId: number, now: number,
  runUntil: number): Promise<Lease | null>;
recoveryRequest(env: Env, deps: Deps, binding: Binding, lease: Lease, deadlines: Deadlines,
  request: { kind: "gmail" | "refresh"; url: string; init: RequestInit }): Promise<HttpObservation>;
observeDelivery(env: Env, deps: Deps, binding: Binding, lease: Lease,
  deadlines: Deadlines): Promise<Observation>;
settleRecovered(env: Env, binding: Binding, lease: Lease, proof: Proof): Promise<"settled" | "replayed" | "conflict" | "fenced">;
settleDirect(env: Env, operationId: string, result: SendResult): Promise<"settled" | "replayed" | "conflict">;
recordFailure(env: Env, operationId: string): Promise<"failed_safe" | "delivery_unknown" | "executed">;
recoverDeliveries(env: Env, deps: Deps, scheduledTime: number, now: number): Promise<{checked:number; confirmed:number; deferred:number; manual:number}>;
```

These signature declarations describe module exports; imports/body implementations belong to the indicated task. `recoveryRequest` must whitelist request kind/endpoint internally; the generic `RequestInit` is not a model input or a bypass around URL/method validation. `refresh` permits exactly POST to the existing OAuth token endpoint, bounded form body from the token helper, and response under the same byte/deadline caps. For a Gmail request, obtain the pinned token through a token helper whose injected fetch invokes the refresh branch. The refresh branch performs admission and fetch directly; it does not acquire another access token, avoiding recursion. Gmail admission follows successful acquisition and rechecks account version/epoch. No direct call to `defaultDeps.googleFetch` may bypass its admission wrapper inside recovery.

## Migration SQL

Execute on the existing migrations 0001–0004. The account/operation composite unique key already exists. JSON schema beyond the checks below is validated before binding. The migration never backfills protocol 2.

```sql
ALTER TABLE operations ADD COLUMN settlement_protocol INTEGER NOT NULL DEFAULT 1 CHECK(settlement_protocol IN (1,2));
ALTER TABLE operations ADD COLUMN result_identity TEXT;
ALTER TABLE operations ADD COLUMN settlement_context_json TEXT CHECK(settlement_context_json IS NULL OR
 (json_valid(settlement_context_json) AND length(CAST(settlement_context_json AS BLOB))<=2048));
ALTER TABLE operations ADD COLUMN byte_admitted INTEGER NOT NULL DEFAULT 0 CHECK(byte_admitted IN (0,1));
CREATE TABLE recovery_installation (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema_version INTEGER NOT NULL CHECK(schema_version=5),
  restore_generation TEXT NOT NULL, mutation_state TEXT NOT NULL CHECK(mutation_state IN ('frozen','active'))
);
-- No default active row: trusted installation must bind the external generation first.
CREATE TABLE recovery_control (
  origin TEXT NOT NULL, build_id TEXT NOT NULL, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('generated_search','send_session_status')),
  state TEXT NOT NULL CHECK(state IN ('probe','enabled','disabled')), epoch TEXT NOT NULL CHECK(length(epoch)=46 AND epoch GLOB 'qe_*'),
  expires_at INTEGER NOT NULL, evidence_hash TEXT NOT NULL, probe_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(probe_ids)),
  PRIMARY KEY(origin,build_id,user_id,account_id,credential_version,mode),
  FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id)
);
CREATE TABLE operation_recovery (
  operation_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL, binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
  state TEXT NOT NULL CHECK(state IN ('active','manual','suspended','completed')),
  started_at INTEGER NOT NULL, deadline INTEGER NOT NULL CHECK(deadline=started_at+86400000),
  retain_until INTEGER NOT NULL CHECK(retain_until=started_at+604800000),
  next_attempt_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 288),
  last_window INTEGER, lease_token TEXT, lease_until INTEGER,
  session_enc BLOB, session_key_id TEXT, session_digest TEXT,
  mime_length INTEGER CHECK(mime_length BETWEEN 0 AND 36700160),
  confirmed_offset INTEGER NOT NULL DEFAULT 0 CHECK(confirmed_offset>=0),
  CHECK((session_enc IS NULL)=(session_key_id IS NULL)),
  CHECK((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK(mime_length IS NULL OR confirmed_offset<=mime_length),
  CHECK(COALESCE(length(session_enc),0)<=4124),
  CHECK(length(CAST(binding_json AS BLOB))+COALESCE(length(session_enc),0)<=8192),
  FOREIGN KEY(user_id,account_id,operation_id) REFERENCES operations(user_id,account_id,id)
);
CREATE INDEX recovery_due ON operation_recovery(state,next_attempt_at,started_at,operation_id);
CREATE TABLE recovery_attempts (
  window_id INTEGER NOT NULL, operation_id TEXT NOT NULL, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  admitted_at INTEGER NOT NULL, PRIMARY KEY(window_id,operation_id),
  FOREIGN KEY(user_id,account_id,operation_id) REFERENCES operations(user_id,account_id,id)
);
CREATE TABLE recovery_requests (
  id TEXT PRIMARY KEY, window_id INTEGER NOT NULL, operation_id TEXT NOT NULL,
  admitted_at INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('gmail','refresh')),
  FOREIGN KEY(operation_id) REFERENCES operations(id)
);
CREATE INDEX recovery_requests_time ON recovery_requests(admitted_at);
CREATE TABLE settlement_permits (
  operation_id TEXT PRIMARY KEY, token TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('begin','success','unknown','failed_safe','storage')),
  operation_writes INTEGER NOT NULL DEFAULT 0 CHECK(operation_writes BETWEEN 0 AND 1),
  audit_writes INTEGER NOT NULL DEFAULT 0 CHECK(audit_writes BETWEEN 0 AND 1),
  FOREIGN KEY(operation_id) REFERENCES operations(id)
);
CREATE TRIGGER protocol2_no_downgrade BEFORE UPDATE OF settlement_protocol ON operations
WHEN OLD.settlement_protocol=2 AND NEW.settlement_protocol!=2
BEGIN SELECT RAISE(ABORT,'protocol downgrade refused'); END;
CREATE TRIGGER protocol2_update_permit BEFORE UPDATE ON operations
WHEN (OLD.settlement_protocol=2 OR NEW.settlement_protocol=2) AND NOT EXISTS(
 SELECT 1 FROM settlement_permits p WHERE p.operation_id=OLD.id AND p.operation_writes=0
 AND OLD.id=NEW.id AND OLD.user_id=NEW.user_id AND OLD.account_id=NEW.account_id
 AND ((p.purpose='begin' AND OLD.settlement_protocol=1 AND OLD.state='claimed'
       AND NEW.settlement_protocol=2 AND NEW.state='executing' AND NEW.byte_admitted=1)
   OR (OLD.settlement_protocol=2 AND NEW.settlement_protocol=2
      AND NEW.settlement_context_json IS OLD.settlement_context_json
      AND NEW.rfc822_message_id IS OLD.rfc822_message_id
      AND NEW.idempotency_key IS OLD.idempotency_key AND
      ((p.purpose='success' AND OLD.state IN ('executing','delivery_unknown') AND NEW.state='executed')
       OR (p.purpose='unknown' AND OLD.state='executing' AND NEW.state='delivery_unknown')
       OR (p.purpose='failed_safe' AND OLD.state='claimed' AND OLD.byte_admitted=0 AND NEW.state='failed_safe')))))
BEGIN SELECT RAISE(ABORT,'settlement transition permit required'); END;
CREATE TRIGGER protocol2_count_update AFTER UPDATE ON operations
WHEN NEW.settlement_protocol=2
BEGIN UPDATE settlement_permits SET operation_writes=operation_writes+1 WHERE operation_id=NEW.id; END;
CREATE TRIGGER protocol2_delete_refused BEFORE DELETE ON operations WHEN OLD.settlement_protocol=2
BEGIN SELECT RAISE(ABORT,'retained operation required'); END;
CREATE TRIGGER protocol2_insert_refused BEFORE INSERT ON operations WHEN NEW.settlement_protocol=2
BEGIN SELECT RAISE(ABORT,'begin transaction required'); END;
CREATE TRIGGER protocol2_audit_permit BEFORE INSERT ON audit_log
WHEN NEW.phase='outcome' AND EXISTS(SELECT 1 FROM operations o WHERE (o.id=NEW.operation_id OR o.id IN (SELECT operation_id FROM pending_actions WHERE id=NEW.pending_id)) AND o.settlement_protocol=2)
 AND NOT EXISTS(SELECT 1 FROM settlement_permits p JOIN operations o ON o.id=p.operation_id
 WHERE p.operation_id=NEW.operation_id AND p.operation_writes=1 AND p.audit_writes=0
 AND NEW.user_id=o.user_id AND NEW.account_id=o.account_id
 AND ((p.purpose='success' AND NEW.decision='executed' AND o.state='executed')
   OR (p.purpose='unknown' AND NEW.decision='delivery_unknown' AND o.state='delivery_unknown')
   OR (p.purpose='failed_safe' AND NEW.decision='failed_safe' AND o.state='failed_safe')))
BEGIN SELECT RAISE(ABORT,'outcome transition permit required'); END;
CREATE TRIGGER protocol2_count_audit AFTER INSERT ON audit_log
WHEN NEW.phase='outcome' AND EXISTS(SELECT 1 FROM operations o WHERE (o.id=NEW.operation_id OR o.id IN (SELECT operation_id FROM pending_actions WHERE id=NEW.pending_id)) AND o.settlement_protocol=2)
BEGIN UPDATE settlement_permits SET audit_writes=audit_writes+1 WHERE operation_id=NEW.operation_id; END;
CREATE TRIGGER protocol2_pending_update BEFORE UPDATE ON pending_actions
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id IN (OLD.operation_id,NEW.operation_id) AND o.settlement_protocol=2
 AND NOT EXISTS(SELECT 1 FROM settlement_permits p WHERE p.operation_id=o.id AND p.purpose IN ('success','unknown','failed_safe')))
BEGIN SELECT RAISE(ABORT,'pending settlement permit required'); END;
CREATE TRIGGER protocol2_pending_binding BEFORE UPDATE ON pending_actions
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id=OLD.operation_id AND o.settlement_protocol=2)
 AND (NEW.operation_id IS NOT OLD.operation_id OR NEW.id!=OLD.id)
BEGIN SELECT RAISE(ABORT,'pending binding immutable'); END;
CREATE TRIGGER protocol2_pending_insert BEFORE INSERT ON pending_actions
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id=NEW.operation_id AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'pending must precede begin'); END;
CREATE TRIGGER protocol2_pending_delete BEFORE DELETE ON pending_actions
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id=OLD.operation_id AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'retained pending binding required'); END;
ALTER TABLE staging_objects ADD COLUMN settlement_operation_id TEXT REFERENCES operations(id);
CREATE TRIGGER protocol2_staging_update BEFORE UPDATE ON staging_objects
WHEN EXISTS(SELECT 1 FROM operations o
 WHERE o.id IN (OLD.reserved_by_operation_id,NEW.reserved_by_operation_id,OLD.settlement_operation_id,NEW.settlement_operation_id)
 AND o.settlement_protocol=2 AND NOT EXISTS(SELECT 1 FROM settlement_permits p
 WHERE p.operation_id=o.id AND p.purpose IN ('begin','success','failed_safe','storage')))
BEGIN SELECT RAISE(ABORT,'staging settlement permit required'); END;
CREATE TRIGGER protocol2_staging_owner BEFORE UPDATE ON staging_objects
WHEN NEW.settlement_operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operations o
 WHERE o.id=NEW.settlement_operation_id AND o.user_id=NEW.user_id AND o.account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'staging owner mismatch'); END;
CREATE TRIGGER protocol2_staging_insert BEFORE INSERT ON staging_objects
WHEN NEW.settlement_operation_id IS NOT NULL OR EXISTS(SELECT 1 FROM operations o
 WHERE o.id=NEW.reserved_by_operation_id AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'staging must precede begin'); END;
CREATE TRIGGER protocol2_staging_binding BEFORE UPDATE ON staging_objects
WHEN OLD.settlement_operation_id IS NOT NULL AND NEW.settlement_operation_id IS NOT OLD.settlement_operation_id
BEGIN SELECT RAISE(ABORT,'staging binding immutable'); END;
CREATE TRIGGER protocol2_staging_delete BEFORE DELETE ON staging_objects
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id IN (OLD.reserved_by_operation_id,OLD.settlement_operation_id)
 AND o.settlement_protocol=2 AND NOT EXISTS(SELECT 1 FROM settlement_permits p WHERE p.operation_id=o.id AND p.purpose='storage'))
BEGIN SELECT RAISE(ABORT,'storage cleanup permit required'); END;
CREATE TRIGGER protocol2_key_update BEFORE UPDATE ON idempotency_keys
WHEN EXISTS(SELECT 1 FROM operations o WHERE (o.id=OLD.operation_id OR o.id IN (SELECT operation_id FROM pending_actions WHERE id=OLD.pending_id)) AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'retained idempotency binding required'); END;
CREATE TRIGGER protocol2_key_delete BEFORE DELETE ON idempotency_keys
WHEN EXISTS(SELECT 1 FROM operations o WHERE (o.id=OLD.operation_id OR o.id IN (SELECT operation_id FROM pending_actions WHERE id=OLD.pending_id)) AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'retained idempotency binding required'); END;
```

Permits are inserted first and removed last within the SAME asserted `DB.batch`; no standalone insert/run is allowed. A failed batch rolls back its permit. The transaction tests assert `SELECT count(*) FROM settlement_permits = 0` after success and failure. A permit allows at most one operation transition and one matching owner/account outcome, enforced by counters and purpose predicates; it may authorize several linked pending/staging effects within that transaction. It cannot authorize a second operation update or audit. Insert permits with explicit `(operation_id,token,purpose)` columns. Storage permits authorize only storage effects and cannot settle an operation. The trigger is a compatibility guard against existing writers, not a sandbox against malicious SQL from a trusted deployment admin.

## State transactions

Use bound values, never interpolated SQL. `:name` below denotes a named fixture parameter; Worker code uses ordered `?` bindings. Do not silently ignore zero-row guards. Every mutation sequence below runs in one `DB.batch`.

Beginning: insert permit purpose begin; assert operation owner/account, state claimed, account active/version, and no existing recovery binding; assert owner recovery row count <1,000 and global <2,000; insert binding; update operation protocol=2, byte_admitted=1, state=executing and generated RFC822 id; persist immutable `settlement_context_json` (executor/resultVersion, pendingId and safe audit fields only, maximum 2,048 UTF-8 bytes) on the original operation; set `settlement_operation_id` on all held staging rows to the operation id; delete permit. Refuse cap/context failure before opening Gmail bytes. Audit sizes/counts and generated Message-ID equality are validated before the batch. The byte flag is conservative: it records request admission, not proof of byte receipt.

Recovery claim: assert active recovery row, deadline>now, attempts<288, next_attempt_at<=now, no live lease, last_window differs; assert qualified current origin/build/account/version/mode or scratch probe allowlist; assert fewer than ten attempt rows for the window and fewer than two for the account; insert attempt event; increment attempts and set last_window/token/until. A failed claim does not increment counters.

Both attempt and request admission assert physical ledger counts below 3,000 attempts and 9,000 requests respectively, including expired rows pending cleanup. Request admission additionally asserts rolling/global credits and qualification/lease/deadlines, then inserts one event:

```sql
INSERT INTO _assert(x) SELECT 1 WHERE NOT EXISTS (
 SELECT 1 FROM operation_recovery r JOIN accounts a ON a.id=r.account_id AND a.user_id=r.user_id
 WHERE r.operation_id=:op AND r.lease_token=:lease AND r.lease_until>:now
 AND r.deadline>:now AND a.status='active' AND a.credential_version=r.credential_version
);
INSERT INTO _assert(x) SELECT 1 WHERE :request_until<=:now OR :attempt_until<=:now OR :run_until<=:now;
INSERT INTO _assert(x) SELECT 1 WHERE (SELECT count(*) FROM recovery_requests)>=9000;
INSERT INTO _assert(x) SELECT 1 WHERE (SELECT count(*) FROM recovery_requests WHERE window_id=:window)>=30;
INSERT INTO _assert(x) SELECT 1 WHERE (SELECT count(*) FROM recovery_requests WHERE admitted_at>:now-300000)>=30;
INSERT INTO recovery_requests(id,window_id,operation_id,admitted_at,kind) VALUES(:id,:window,:op,:now,:kind);
```

The qualification assertion precedes those statements in the same batch: exact control key from the binding, `epoch=:captured_epoch`, `expires_at>:now`; state enabled, or state probe AND deployed profile scratch AND op present in its explicit JSON array. The build is the embedded deployment build, never a request argument. All admission predicates are reused for 401/refresh, with no nested `gmailFetch` retry loop.

Success transaction: insert permit success; assert protocol=2 and operation state in executing/delivery_unknown; for recovery additionally assert live lease, same account version, qualification epoch/state, matching proof operation/session/generated id and supported result version; update state executed/result_json/result_identity; mark held staging rows consumed and unreserved if present; redact linked pending row in executing or failed with error delivery_unknown and clear error; insert one audit decision executed; mark recovery completed and erase session ciphertext/key; delete permit. `result_identity` is canonical JSON `[message.id,message.thread_id]`. The first state assertion makes concurrent success lose the batch before audit. Catch the assertion failure by reading the terminal row: same identity replays, different identity conflicts, otherwise fenced. Do not re-run the write batch merely because labels changed.

Each attempt chooses exactly one qualified mode, captured in its lease; Use the explicit mapping generated_search → generated_search and send_session_status → session_receipt. Both cross-mode pairings refuse; do not compare the two enum strings for literal equality. A session attempt never falls back to a differently qualified search under the same lease. On expired session erase its ciphertext and defer; a later window can choose generated search. When both modes are eligible, prefer session status; if only search remains, choose it. Direct response uses the same success transaction without qualification/lease checks. It requires original operation binding and protocol 2 but may record positive evidence after automatic recovery is disabled. It cannot overwrite a winner. For protocol 1 retain legacy handling and never let new recovery target it.

Failure transaction first returns an already executed row. Otherwise: claimed AND byte_admitted=0 may become failed_safe; executing/delivery_unknown/byte_admitted=1 becomes/remains delivery_unknown and keeps the key. Redact linked pending as failed/delivery_unknown. Unknown audit is inserted only on the first transition to unknown; further errors return the existing state. Use permits for protocol 2, including failed-safe/unknown paths. Never classify by status class alone.

Cleanup clears session at horizon/disable/revoke, marks active rows manual/suspended, then purges recovery rows after retain_until. Original operations retain protocol/result/key semantics and settlement_context_json; a post-begin operation write must not change that context. Store no session, address or MIME there. Qualification history prunes disabled/expired rows before admission and refuses above 32 owner/64 global. Request/attempt ledgers prune older than 24h without removing a currently retained window's counters; late invocations older than 24h are refused at handler entry. Storage abandonment is an admin-only separate transaction and never deletes the operation/key.

## Additional normative boundaries (B1–B6, M1–M12)

- Review this appendix, the design, main plan and revision-3 resolution together. The review bundle includes their full content and a SHA-256 manifest; a main-plan-only review cannot certify the SQL.
- `credential_version` already means Google grant identity: reconnect/revoke advance it; ordinary cached-access-token refresh does not. Retain that field name. Test normal refresh at N succeeds at N, and reconnect/revoke N+1 fences every pinned admission.
- `windowId=floor(controller.scheduledTime/300000)` is used only for window identity and deduplication. `now` is freshly sampled trusted server admission time, never scheduledTime or client time; it drives event admitted_at, rolling budget, lease, horizon and all deadlines. Sample again for each admission. Invocation start fixes runUntil. Three delayed windows (12:00, 12:05, 12:10) arriving at 12:14 share thirty actual-time requests, including refresh. Refuse future scheduled timestamps and events older than 24h. A wall-clock regression aborts the invocation; monotonic elapsed time also enforces local duration ceilings.
- The 8,192-byte bound is **UTF-8 binding_json bytes plus raw session_enc BLOB bytes**, not SQLite row size or base64 size. Ciphertext alone is at most 4,124 bytes (4,096-byte URI plus 12-byte IV and 16-byte GCM tag); This framing matches the existing crypto/keyring.ts AES-GCM IV/ciphertext layout. Other columns/indexes are excluded from this named payload budget. Test exact 8,192 acceptance, 8,193 rejection, multibyte JSON and ciphertext-only overflow.
- Session URI is credential-equivalent: store only encrypted, never verbatim in logs, audit, exceptions, model/client output, or private/public reports. Disable URL-bearing fetch error serialization. Reports may record only an approved path-variant enum and a digest, never upload_id or full URL. Original upload retains the URI only in necessary transient transport memory.
- A 308 plus valid Range without Location is valid incomplete status. The transport returns 308 to the parser while refusing redirect following; other redirect statuses are invalid evidence. Location is required only when establishing the original session. Separate 404 and 410 fixtures must retain delivery_unknown and the key after ambiguous bytes.
- Retry-After accepts a finite nonnegative integer delay or a valid HTTP date, using response admission time for delay seconds. Reject negative/overflow/malformed values to local backoff. Set retryAt=max(localBackoffAt, providerAt); a past date cannot shorten local backoff. At or beyond the horizon, mark manual/unknown with no next admission. Cover `Sun, 13 Sep 2026 09:30:00 GMT`, past date, malformed, negative, numeric overflow, 1200 and 3600 seconds.
- Search uses `q=rfc822msgid:<internally-generated-id>`, SENT restriction and maxResults=2, then metadata fetch of ids/thread/labels/internalDate/all Message-ID headers through the pinned account. Require exactly one candidate, no next page, exactly one equal Message-ID header, SENT, expected thread when bound, and start−120000 <= internalDate <= horizon. Zero or ambiguous results defer until horizon then manual_unknown; neither becomes failed_safe. This deliberately rejects multiple search hits instead of choosing a convenient one.
- Cleanup must preserve the original operation, result identity, key and pending id after recovery metadata expires. Direct success after seven days reads its immutable operation/context, tolerates deleted handles and still settles once. Never make direct success depend on the purged recovery row. A storage permit plus known-stopped/published producer proof gates cleanup; no active/unknown R2 writer may be released even if DELETE already completed. Test late PUT completion after DELETE with a barrier: administration must refuse before that DELETE is admitted.

## Restore floor and quarantine

Add `worker/src/operations/installation.ts`, `worker/test/restore-floor.test.ts`, and `scripts/qualification/restore.ts`. `assertInstallation(env)` fails closed on missing schema/table/guard, absent installation row, schema_version!=5, external `RESTORE_GENERATION` mismatch or mutation_state!=active. Apply before **every mutation ingress**, including all MCP mutation tools, approval execution, staging upload/download acknowledgement, account changes, scheduled maintenance and qualification changes; repeat before network admission and settlement. Read-only health may expose only `ready`/`maintenance`. Authoritative schema/trigger verification belongs to the deployment/restore CLI; admission reads the verified installation marker. This is an operational restore protocol against trusted-operator mistakes, not detection of arbitrary unsupervised SQL/schema tampering.

`restore.ts --manifest <private-path>` is maintenance-only in Phase A: validate the exact database/bookmark/deployment target and record an external private restore receipt; deploy a restoration-compatible maintenance build that denies all mutation ingress and scheduled writes, rotate `RESTORE_GENERATION` in deployment configuration outside D1, and verify every routed version is frozen. Drain prior database writers before invoking restore; absent verifiable quiescence, refuse the restore. A timer or Gmail promise is not proof of remote non-delivery. Capture/export surviving journal and idempotency records privately before restoration. Keep maintenance routing and the external generation unchanged during restore, so a restored active flag or old qualification cannot reactivate service. A pre-0005 snapshot may be restored only under this frozen maintenance build; reapply the schema/guards and install a **frozen** marker with the new generation. No recovery enable or normal writer rollback is permitted during quarantine.

D1 restore may erase records of mail already sent, including operations/keys absent from the restored snapshot. Therefore merely disabling restored qualification rows is insufficient. **Phase A does not resume mutations after Time Travel.** All restored qualification is invalidated; old operations/keys are quarantined, and absent keys must not become fresh attempts. Resume requires a separately reviewed incident reconciliation plan for the entire lost interval, preserved external evidence and fresh qualification; if evidence is incomplete, keep affected mutation access frozen. The runbook must explicitly show this limit. Read-only health remains available; no endpoint claims that a missing restored operation proves no send. Test missing 0005, restored active marker/old epoch, absent lost-interval operation, deployment rollback attempting to reactivate old generation, and zero external sends while frozen.

Cloudflare documents transactional batch rollback, scheduled-time semantics and Time Travel retention of 7 days on Workers Free and 30 days on Workers Paid; these are platform inputs, not proof of this proposed implementation. Sources: [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/), [scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/), [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/). Restore authorization remains a separate explicit operator action.

## Pure fixture contract

Use these vectors in `worker/test/recovery-contracts.test.ts`. The plan conformance script executes equivalent pure rules and migration constraints; production tests must import the actual implementation, not copy the rule under test.

| Case                         | Input                                                               | Required result                               |
| ---------------------------- | ------------------------------------------------------------------- | --------------------------------------------- |
| reused draft header          | executor send_draft, same Message-ID/thread and earlier SENT result | suspended/manual_draft                        |
| qualified session/search lag | valid bound final send-v1 receipt, zero search results              | confirmed/session_receipt                     |
| range prefixed               | status 308, Range bytes=0-42, total 100, previous 0                 | incomplete/43                                 |
| range bare                   | status 308, Range 0-42, total 100, previous 0                       | incomplete/43                                 |
| all bytes not final          | status 308, Range 0-99, total 100                                   | awaiting_final                                |
| missing range regresses      | status 308, Range null, previous 43                                 | unknown/invalid_response                      |
| range at overflow            | status 308, Range 0-9007199254740992                                | unknown/invalid_response                      |
| expired session              | status 404 or 410 after possible bytes                              | unknown/expired; key held                     |
| encoded traversal            | /users/me/extra/%2e%2e/messages/send                                | reject before URL normalization/token lookup  |
| Retry-After hour             | 429 and Retry-After 3600                                            | one request; next attempt >= now+3600000      |
| body stalls                  | headers arrive then body stalls                                     | abort at request deadline, no settlement      |
| body over cap                | 65,537 bytes                                                        | bounded refusal, no JSON parse/settlement     |
| reconnect barrier            | account N+1 before token/401 refresh                                | no request with N+1 token                     |
| label drift                  | same ids, changed labels on loser                                   | exact first result replay, one executed audit |
| disable/re-enable            | lease captured epoch A, current epoch C                             | recovery fenced                               |
| old writer                   | protocol2 op, baseline settlement without permit                    | transaction refuses, no outcome append        |

## Build identity and qualification entry points

`scripts/qualification/build-id.ts` hashes production inputs by sorted POSIX relative path. For each file update SHA-256 with UTF-8 path length in ASCII decimal, `:`, path bytes, body length in ASCII decimal, `:`, body bytes. Include all tracked files under `worker/src`, `shared/src`, `worker/migrations`, plus root/shared/worker package.json, package-lock.json, tsconfig.base.json, shared/worker tsconfig.json, and canonical effective deployment config with BUILD_ID omitted. Include compatibility_date/flags, D1/R2 binding identities and schema, cron expressions, routes/domains affecting Message-ID, feature/profile flags, and non-secret recovery limits. Exclude secret values and their hashes; bind grant/key identities through verified epochs or configuration identifiers. Refuse dirty production inputs. Exclude docs/tests/evidence/native because their changes do not alter the Worker recovery implementation. Embed this computed build id during bundling and store bundle SHA-256/deployment id in the private deployment receipt. The private receipt also certifies `RECOVERY_COMPAT_VERSION=3`, covering the permit-aware writer, linked-write guards, protocol-separated cron AND installation/restore admission checks on every mutation ingress; admin deployment/rollback refuses lower versions. Separate Worker, companion, native-helper digests and installed client versions accompany the cases that use them.

`admin.ts` commands: `probe --manifest <private-path>`, `enable --manifest <private-path>`, `disable --manifest <private-path>`, `abandon-storage --manifest <private-path>`. CLI args contain only the private manifest path; never tokens/session URIs/mail content. Check file regular/owner-only/no symlink, maximum 64 KiB. Validate platform deployment receipt, embedded build, origin, owner/account/version, profile and mode. Use the platform credential to read authoritative D1/deployment state. Enable accepts only a private manifest with passing case ids and existing artifact hashes; deployment admin remains the trust authority. Every create/edit generates a fresh, internally generated 256-bit random epoch (`qe_` plus 43 base64url characters); a manifest cannot choose it. Pruning then recreating a control key cannot reuse an old epoch. Every edit replaces epoch in a guarded batch; changing a stale expected epoch refuses. No SQL comes from a manifest.

Freeze a `RunIdentity` before any live case: `{runId, deploymentVersionId, workerBuildId, companionBuildId?, nativeBuildId?, qualificationEpoch, restoreGeneration, manifestSha256, startedAt}`. Verify authoritative platform deployment/config identity and served embedded identity before AND after each live case, and immediately before enable. Capture the serving Worker deployment identity on each credentialed Worker request's response/evidence envelope, including errors; unexpected/missing identity fails the case. Google responses are not expected to supply a Worker build header. Stop the entire run on drift, seal completed results, mark remaining cases not_run, and never merge runs across identities. Deployments and enable commands share an operator-held exclusive deployment lock; no concurrent rollout/traffic split is allowed during qualification. If exclusive control or authoritative per-request identity cannot be established, mark qualification not_run. Enabling atomically asserts the frozen qualification epoch; successful enable creates a fresh epoch and records its parent run/epoch. Recheck the external deployment under the same lock before releasing it. A case cannot silently update the frozen tuple.

Private artifact writer: dedicated owner-only directory (0700), outside every repo/worktree and model attachment root; files 0600, regular/no symlink, atomic temp-write/fsync/rename under that directory. Refuse unsafe existing parents/paths. Manifests/case results carry hashes; record only synthetic fixture digests and necessary preflight addresses. No raw OAuth token, session URI or raw MIME in any report; public projection contains no addresses. Redaction tests cover both private and public results and exceptions. No artifact is eligible for git add.

`run.ts --manifest <private-path>` validates preflight before accessing Gmail credentials, then runs a selected immutable list of cases against exact scratch sender/recipient. It refuses extra addresses including CC/BCC and preserves both failed and passing results. The `TestCase` interface is `{id, requiresLive, run(context): Promise<CaseResult>}`; context supplies the frozen RunIdentity, origin, build, exact scratch identities, verified MCP/native ports, monotonic timer and private artifact writer. `CaseResult` is `{case_id, run_id, deployment_version_id, manifest_sha256, worker_build, companion_build, native_build, client_version, result:'pass'|'fail'|'not_run', started_at, finished_at, attempts, artifact_sha256, limitation}`; no body/address/id is public. `run` returns nonzero if any selected mandatory case fails or is not-run. There is no retry-until-green loop.

Local `preflight.test.ts` injects credential/network spies and tests missing manifest fields, foreign profile/recipient/build, symlink/permissions/size, and verifies zero credential/network calls on refusal. Provider cases run through actual MCP/Gmail transport adapters; fake credentials cannot satisfy live evidence. `--synthetic` writes result mode synthetic and cannot enable recovery on any live origin. The package gate explicitly includes this directory's tests.

## Qualification cases and stop rules

| Case                | Procedure/sample                                                                                                                           | Pass condition                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| generated-id        | 3 approved fixture sends per target mode, capture ids before simulated response loss; poll every 5 min for up to 24h                       | 3 exact generated-id matches, zero unrelated confirmation, same-result replay once each                                                                                      |
| session status      | 3 bound >5 MiB sends, lose response after provider commit; status before search                                                            | 3 final receipts accepted, one executed audit each; logged path/range variant within grammar                                                                                 |
| draft negative      | 3 synthetic reused-id/thread fixtures plus 1 authorized old-draft live observation                                                         | zero automatic draft search confirmations; live timestamp observation recorded without enabling search                                                                       |
| byte round trip     | 3 sends/downloads at 0 and 26,214,400 attachment bytes; encoded total recorded                                                             | digest/size exact, encoded bytes <=36,700,160, no runtime resource error                                                                                                     |
| media boundary      | synthetic exact 5 MiB and 5 MiB+1 encoded MIME, 3 each                                                                                     | expected transport, one external mutation each                                                                                                                               |
| reply/revoke        | 3 replies in fixture thread; revoke scratch Google credential once                                                                         | correct thread ids; subsequent use refused and reconnect required                                                                                                            |
| installed clients   | one allow + ask + timeout continuation per applicable Code/Desktop/claude.ai flow, record exact version                                    | correct tool/result, single send; companion only Code/Desktop; no credential or byte content in model trace                                                                  |
| native              | 3 login/logout cycles, 10 process-kill points around receipt publication on scratch volume                                                 | no stale-epoch use, no overwrite, local recovery matches receipt state                                                                                                       |
| physical durability | 3 operator-supervised power-loss trials on dedicated disposable test machine/volume at publication window                                  | each acknowledged save survives with exact digest; each uncertain state stays unacknowledged; no personal data involved                                                      |
| resources           | 10 maximum-payload serial round trips and 2 concurrent allowed download streams on exact deployed tier                                     | zero resource-limit errors; measured peak isolate memory <128,000,000 bytes and CPU below configured route limit; if peak measurement unavailable record memory case not-run |
| rollback            | mixed old/new settlement fixture; paused recovery across disable/prune/recreate; rollback-floor cron with stale protocol1 and staging rows | old permitless writer refuses, recreated epoch differs and old lease refuses, rollback-floor cron maintains unrelated rows, compatible direct response settles once          |

Stop on first unexpected external recipient, credential leak, duplicate send, false confirmation, overwrite, or resource-limit error. Preserve private failure evidence and do not continue that live case automatically. These sample counts are acceptance tests, not statistical reliability claims. Physical power loss requires its own concrete operator authorization; a process kill cannot substitute. Release remains pre-release if any mandatory live/device/resource case is not-run.
````

## 2026-09-13-plan-5-revision3-resolution.md

Source: `docs/superpowers/reviews/2026-09-13-plan-5-revision3-resolution.md`

```markdown
# Plan 5 revision 3: external gauntlet resolution

Scope: planning corrections only. Baseline `6e78bc548c97bbe5194e3f780c717e5519930c1a`; no production implementation, deployment, database mutation or live Gmail fixture. The supplied review covered only the main plan; the design and appendix existed locally but were absent from its review set. This revision reviews and distributes the normative set together.

Read the [design](../specs/2026-09-13-gmail-mcp-plan-5-recovery-design.md), [main plan](../plans/2026-09-13-gmail-mcp-plan-5-recovery-and-release.md), [contracts](../plans/2026-09-13-plan-5-contracts.md) and this resolution together. A generated review bundle embeds all four documents verbatim and links the full SQL writer inventory. The revision-2 snapshot and original manifests/line ledger preserve prior evidence; they are historical, not hashes of current documents.

## Dispositions

All 18 findings are addressed at the planning level: 11 adopted, 7 refined. “Refined” means an existing rule was made explicit, or the proposed correction needed adjustment to match source evidence; it does not mean the finding was ignored.

| Finding | Disposition | Verified fact and revision-3 correction                                                                                                                                                                                                                                                               | Required implementation proof                                                                                                                         |
| ------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1      | Refined     | Normative files existed but were missing from the reviewer's input. Bundle supplies full documents and hashes; no main-file-only certification.                                                                                                                                                       | Validate the bundle manifest before execution/review.                                                                                                 |
| B2      | Adopted     | Revision-2 guarded operation updates and outcome inserts, leaving linked writes uncovered. Added purpose/counters, pending/staging/key guards and immutable staging linkage. Inventory captures all 136 baseline SQL DML literals, including 48 settlement-linked statements.                         | Replay each applicable writer/branch against protocol1 controls and protocol2 fixtures; full batch rollback, one executed audit, no surviving permit. |
| B3      | Refined     | `google/connect.ts` reconnect and `google/tokens.ts` revoke increment credential_version; ordinary guarded refresh does not. Keep the existing name, define grant semantics explicitly.                                                                                                               | Ordinary refresh remains N; reconnect/revoke N+1 fences pinned calls.                                                                                 |
| B4      | Adopted     | scheduledTime is event schedule identity; admission requires actual fresh server time.                                                                                                                                                                                                                | Three delayed windows at 12:14 share thirty actual rolling requests.                                                                                  |
| B5      | Adopted     | Preflight-only deployment verification leaves a drift race. Freeze run/deployment/component/epoch/manifest identity, verify every case and final enable under exclusive deployment control.                                                                                                           | Drift before/during/after a case stops the whole run; no mixed evidence promotion.                                                                    |
| B6      | Refined     | Restore can erase already-sent operations as well as guards/epochs. External maintenance generation and schema floor added; Phase A stays mutation-frozen after restore pending a separate lost-interval reconciliation plan. Cloudflare retention is 7 days Free / 30 days Paid, not universally 30. | Missing schema, restored active flag/epoch, erased key and old deployment all leave mutations frozen.                                                 |
| M1      | Adopted     | Google's 308 status example has Range and no Location. Make valid incomplete result explicit, separate from redirect refusal.                                                                                                                                                                         | Both documented Range forms without Location accepted; no redirect followed.                                                                          |
| M2      | Adopted     | Prior prohibition covered public artifacts only. Session URI now forbidden in all reports/logs/errors/audits/model outputs, encrypted at rest.                                                                                                                                                        | Secret sentinel absent from private and public results and exception paths.                                                                           |
| M3      | Adopted     | Existing SQL measured binding UTF-8 bytes + raw ciphertext, not SQLite row size. Name the combined 8192-byte payload limit and add ciphertext limit 4124 matching keyring framing.                                                                                                                    | Exact boundary, multibyte JSON and ciphertext overflow tests.                                                                                         |
| M4      | Adopted     | Typed defer/backoff existed; date and malformed coverage was incomplete.                                                                                                                                                                                                                              | Future/past HTTP date, malformed, negative/overflow and numeric delays; never shorten provider lower bound.                                           |
| M5      | Refined     | Appendix/design already constrained candidates. Main plan now states query plus exact metadata verification and rejects any extra candidate/page conservatively.                                                                                                                                      | One qualifying message with exact header/SENT/thread/time; no search-id-only settlement.                                                              |
| M6      | Refined     | Zero results were already unknown. Explicit deferred-to-manual_unknown terminology added.                                                                                                                                                                                                             | Empty search never releases the key or becomes failed_safe.                                                                                           |
| M7      | Refined     | 404/410 already yielded unknown; split into named status fixtures.                                                                                                                                                                                                                                    | Both statuses after ambiguous bytes retain unknown/key.                                                                                               |
| M8      | Adopted     | Producer-stop admission existed; exact DELETE-then-late-PUT counterexample now required.                                                                                                                                                                                                              | Refuse abandonment before DELETE while an R2 producer may write.                                                                                      |
| M9      | Adopted     | Private evidence lacked precise file/path constraints. Added 0700 directory, 0600 files, atomic writes, protected roots, hashes and private report redaction.                                                                                                                                         | Symlink/permission/path/hash failures refuse before credential access.                                                                                |
| M10     | Adopted     | Config was included generically; effective behavioral config inputs and separate component identities are now enumerated.                                                                                                                                                                             | Every behavior-changing config field changes identity; secrets excluded.                                                                              |
| M11     | Refined     | Global no-live-send boundary already applied. Task 8 now explicitly synthetic/local; credentialed barriers require Task 9 authorization.                                                                                                                                                              | Synthetic runner never acquires live credentials/enables qualification.                                                                               |
| M12     | Adopted     | Some barriers existed, but restore and whole-run deployment drift were missing. All requested schedules are explicit.                                                                                                                                                                                 | Restore/drift/grant/window/permit/proof/cleanup races, including late direct settlement after retention.                                              |

## Writer inventory and compatibility obligations

[CSV inventory](2026-09-13-plan-5-writer-inventory.csv) records file, original line, table, verb, exact SQL literal and SHA-256. It scans every production `worker/src/**/*.ts` DML literal, including dynamic template skeletons. It is not a claim that every interpolated branch has already been executed. There is no baseline scripts directory or private admin writer; revision 3 adds private admin/restore writers and requires extending the inventory before those ship. Tests/migrations are separate fixture/setup inputs, not hidden production call sites. Re-scan at implementation head and fail the coverage test on any unclassified new literal; instantiate every dynamic template branch explicitly.

| Writer family                                           | Baseline sites in CSV                                            | Required handling                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Journal insert/begin/transition, direct success/failure | operations/journal.ts, tools/settle.ts                           | Protocol1 unchanged; protocol2 UPDATE requires correct single-use transition permit. Protocol2 direct INSERT/delete refused. Same-state or zero-row legacy attempts cannot append outcome.                                                                                                    |
| Pending creation/approval/claim/finish/expiration       | approval/pending.ts, tools/gate.ts, tools/settle.ts, cron.ts     | Unlinked/protocol1 behavior retained. Existing protocol2-linked updates/deletes fenced; immutable operation linkage retained. Filter compatible bulk cron to protocol1, then use explicit protocol2 transactions. No bulk failure may suppress unrelated maintenance.                         |
| Stage upload/retry/recovery                             | staging/transfers.ts, staging/upload.ts, staging/recovery.ts     | Remain protocol1 because only send/reply/forward/send_draft enroll protocol2. Test action predicates cannot touch marked sends; apply actual old operation/pending statements to matching marked fixtures and require refusal if a row would be mutated. Keep Plan4 transfer cleanup working. |
| Reservation/TTL/consumption/purge/download bookkeeping  | staging/store.ts, staging/downloads.ts, tools/settle.ts, cron.ts | Unrelated rows unchanged. Marked/previously-marked objects require permit-aware wrappers, including TTL/download bookkeeping where reachable. Storage permit cannot change delivery state. Known producer stop and nonreuse assertions precede object deletion.                               |
| Idempotency upsert/rebind                               | tools/idempotency.ts                                             | Retain direct operation linkage and pending-only linkage to protocol2. Test old upsert with terminal-looking pending but unknown operation cannot rebind. No deletion creates fresh authority.                                                                                                |
| Audit insert                                            | audit/log.ts, all callers                                        | Resolve both operation_id and pending_id linkage. A protocol2 pending-only outcome missing operation identity is refused. Correct outcome requires matching owner/account, transition purpose and unused audit counter. Intent-only logging remains separate.                                 |
| Audit retention                                         | cron.ts                                                          | Existing bounded audit expiry is intentionally allowed; this is not outcome settlement. Permanent operation state/result prevent a second success after historical audit pruning. Do not claim audits are retained forever.                                                                   |
| Remaining account/auth/policy/storage-domain SQL        | all other CSV rows                                               | Outside protocol2 settlement fencing; preserve ordinary behavior. All are nevertheless disabled by restore maintenance routing and installation checks when mutation service is frozen.                                                                                                       |
| New admin/raw D1                                        | Tasks 7–9, absent at baseline                                    | Bound SQL only, no model/public route. Inventory each new writer, use storage permits and frozen restore protocol. Trusted platform admin can replace schema/code; DB triggers are compatibility guards, not a sandbox against that authority.                                                |

A statement whose WHERE clause selects no protocol2 row need not raise a trigger error; its **whole legacy call path** must have no protocol2 side effect or subsequent outcome append. This refines the external review's blanket “every statement rejects” rule to SQLite's actual trigger semantics.

## Independent follow-up review

The reviewer identified a mode/proof enum mismatch and missing context after seven-day retention. Both were corrected: explicit `send_session_status → session_receipt` mapping, and bounded immutable `operations.settlement_context_json` carrying only executor/result version, pending id and safe audit context. Direct settlement does not depend on the purged recovery row. The additional idempotency guard follows a pending-only key's operation as well as a direct operation link.

The rollback compatibility floor is now version 3: writer/cron compatibility alone is insufficient; every mutation ingress must honor installation/restore quarantine. Revision-2 version-2 records remain historical.

## Evidence and limits

Run `python3 docs/superpowers/reviews/2026-09-13-plan-5-conformance.py` and `node docs/superpowers/reviews/2026-09-13-plan-5-review-probes.mjs` from the repository root. Fresh verification: 18 conformance checks and all four historical probes passed. The former exercises proposed SQLite SQL, guards, payload boundaries and source inventory; the latter preserves four historical revision-1 counterexamples. Neither executes proposed Worker code, provider traffic, private CLI, D1 Time Travel or device qualification. Task checkboxes remain unpaid runtime acceptance obligations.

Planning scorecard: contract specificity 8/10 (raise with workerd writer replay); adversarial planning proof 7/10 (raise with production-imported fault tests); release proof 0/10 (new implementation/live evidence not run). No production-readiness score is inferred from passing planning checks.

## External source check

Cloudflare confirms [batch transaction rollback](https://developers.cloudflare.com/d1/worker-api/d1-database/), the meaning of [scheduledTime](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/), and [Time Travel's tier-dependent restore retention](https://developers.cloudflare.com/d1/reference/time-travel/). R2's [consistency model](https://developers.cloudflare.com/r2/reference/consistency/) explicitly allows the last completed writer to win. These support the transaction, clock and restore/producer risks; the chosen quarantine protocol is this project's design, not a provider guarantee.

Google documents [zero-body status PUT, both Range forms and final 200/201 responses](https://developers.google.com/workspace/gmail/api/guides/uploads), and [`rfc822msgid` message search](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list). Acceptance of those provider mechanisms does not prove causal delivery for arbitrary drafts or authorize a new MIME request after ambiguity.
```
