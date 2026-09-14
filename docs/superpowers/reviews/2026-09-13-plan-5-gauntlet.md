# Plan 5 Simurgh gauntlet

Historical review of revision 1. See [revision-2 resolution](2026-09-13-plan-5-resolution.md) for the subsequent planning corrections. Findings and source line references below remain the original review record.

Verdict: **revise before implementation**. Reviewed all 100 design lines and all 225 implementation-plan lines, including type declarations, examples, constraints and completion claims. Found **13 actionable issues: four P1 and nine P2**. No P0 claim. The draft's conservative recovery direction is sound; the interfaces and proof obligations are not yet sufficient to execute it.

Reviewed baseline: `6e78bc548c97bbe5194e3f780c717e5519930c1a`. Both Plan 5 drafts were untracked. Their contents were not changed by this review.

- Design: `../specs/2026-09-13-gmail-mcp-plan-5-recovery-design.md`; SHA-256 `6b258912853b5ee2983d5ee4e3bf715fbe39c014a666f178096e25651914efa9`.
- Plan: `../plans/2026-09-13-gmail-mcp-plan-5-recovery-and-release.md`; SHA-256 `70b16b5a5bf55b0047b3aeaa305ab5f1c2332f0fff2c6017c85a22aec9b3e398`.
- [Line-by-line ledger](2026-09-13-plan-5-line-review.csv): 325 rows, one per source line. `reviewed_no_finding` means this pass found no actionable defect in that line; it is not a runtime pass. Structural/blank lines are explicitly recorded.

## Findings

### F01 · P1 · A preserved draft Message-ID does not identify this send

Design 42–46; plan 113–137 and 142–160.

The draft accepts a unique SENT message with the same Message-ID/thread and a timestamp as early as two minutes before execution. An existing draft can reuse a Message-ID from an earlier message. Suppose an earlier send in that thread occurred one minute ago, the current send failed before delivery, and search returns only the earlier message. Every written predicate passes even though this operation did not deliver. A qualification test that Gmail preserves a header does not establish per-operation uniqueness. The one included draft test uses a _different_ Message-ID and therefore misses this case.

Repository evidence: `worker/src/tools/send.ts:165–177` reads the draft's existing Message-ID; `worker/src/operations/send.ts:98–110` passes it to the journal rather than assigning a new operation identifier. A local predicate probe accepted the earlier-message counterexample. That is a logical counterexample to the plan, not a live Gmail reproduction.

Required revision: allow automatic draft confirmation only with evidence causally bound to the operation, or leave search-only draft recovery manual. Do not treat a negative pre-send search as proof of uniqueness, because indexing can lag. Add `earlier-sent-copy-same-message-id-does-not-confirm-current-draft`. Separately qualify old-draft timestamp behavior: Gmail describes `internalDate` as message creation time, not a universal send-time receipt. [Gmail message resource](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages).

### F02 · P1 · Revocation fencing stops settlement but not credential borrowing

Design 36; plan 99, 104, 136 and 179–180.

The recovery binding contains a credential version, but no planned token API requires that version. Existing `getAccessToken` loads the account's current version (`google/tokens.ts:53–61`), and `gmailFetch` reacquires the current token after a 401 (`google/gmail.ts:158–161`). Reconnect between recovery admission and either token lookup lets recovery use the new credential. A later D1 settlement check cannot undo that access.

Required revision: add an expected-credential-version parameter enforced during cached-token acquisition, refresh writes and each retry. Define the linearization point for already admitted requests, rather than promising cancellation after credentials have left the Worker. Add barriers for reconnect before first acquisition and before the 401 refresh; both must make zero requests with the new credential and suspend recovery. Include `google/tokens.ts` in the file map. Independent review confirmed this static contract gap.

### F03 · P1 · Promise completion is not proof that the remote writer stopped

Design 72; plan 199–202.

The design permits writer ownership release on “a completed local promise.” A fetch can reject after the remote side accepted bytes. Promise settlement alone does not establish that Gmail finished processing or that a timed-out request can no longer complete. This wording weakens the unknown-writer rule that Plan 4 deliberately preserves and could admit another byte writer under Phase B.

Required revision: distinguish a provider response, local cancellation and unknown transport outcomes. Specify exactly which observations permit another writer for the same session, with a provider-supported concurrency contract; otherwise retain status-only recovery. Add `promise-rejects-after-remote-acceptance-does-not-release-writer` and a late-remote-completion barrier. Do not turn lease expiry, AbortError or a caught exception into a stop receipt. This is a design counterexample; remote behavior has not been qualified. [HTTP retry semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2).

### F04 · P1 · The existing failure classifier can contradict the no-resend law

Plan 19, 169–171 and 195–202.

`worker/src/tools/gate.ts:428–444` classifies an executing operation with any `GmailApiError` 4xx as `failed_safe`; idempotency then permits a fresh attempt (`tools/idempotency.ts:73–75`). After a prior ambiguous byte request, a later expired-session/authorization error is not evidence that the earlier attempt did nothing. The plan protects the _probe parser_ but does not define the error contract for continued writes or add the gate file to its changes. It also covers late direct _success_ without specifying what a late executor exception does after recovery already won.

Required revision: make safe-failure classification depend on execution phase and definitive no-effect evidence, never HTTP class alone once prior bytes may have arrived. Change and test the gate alongside recovery. Add `expired-session-after-ambiguous-write-keeps-idempotency-held` and `late-executor-error-after-recovered-success-returns-winner`. This is a confirmed integration gap, not a claim that an unimplemented Phase B exploit was executed.

### F05 · P2 · Session success has no valid route into the settlement signature

Plan 48–58, 113–130, 166 and 180.

`SessionStatus.complete` contains an untyped result object. `settleRecovered` accepts a `Decision` whose confirmed variant requires a Candidate with Message-ID headers and timestamp. Normal send responses in `operations/send.ts:11–12, 79–80` contain ids and labels, not that evidence shape. Fabricating headers/timestamps would violate the design; forcing search throws away valid session evidence when indexing lags. The parser also lacks an expected result-kind parameter despite promising message/draft schema validation.

Required revision: define a discriminated evidence union for exact-search proof and operation/session-bound final receipt, plus explicit result normalization. Persist the executor/result version and audit context needed by both paths. Specify that mutable label differences do not imply a different delivered message; preserve the first normalized terminal result. Test successful session completion with an empty search, and a direct response racing a metadata read with changed labels. Independent review confirmed the signature mismatch.

### F06 · P2 · The transport cannot currently enforce the promised request/deadline budget

Design 52–54; plan 20–21, 136 and 176–180.

The proposed counter is not connected to the existing Gmail request interface. `GmailRequest` has no abort/deadline/budget field (`google/gmail.ts:20–31`). `gmailFetch` performs internal retries and token acquisition, and `gmailJson` reads the entire response body (`152–176`). A timeout around initial fetch does not necessarily bound body consumption. There is no byte cap for error bodies, search metadata or final session responses. The shared budget's single `deadline` also conflates a cron-wide deadline with each 45-second attempt.

“Globally” is ambiguous: two simultaneous cron invocations each holding a counter of thirty can issue sixty requests against disjoint rows. Per-operation leases do not impose a deployment-wide quota. Ten serial 45-second attempts can span 450 seconds and overlap the next five-minute cron.

Required revision: define a recovery transport with a checked counter before every outbound request, bounded body readers, explicit token-refresh accounting and separate run/attempt/request deadlines. Define whether global means per invocation or per scheduled window; use durable admission if the latter. Add stalled-body, retry-budget-exhaustion and two-disjoint-crons tests, with numerical assertions. The sixty-request case was checked as a local arithmetic counterexample, not a deployed load test.

### F07 · P2 · Retry-After is lost, and its cap contradicts honoring it

Design 52; plan 136 and 179.

`Evidence` cannot carry a retry deadline. Existing safe retries sleep inside `gmailFetch`; its error type does not preserve Retry-After. Returning generic inconclusive evidence loses the information the scheduler needs. A provider Retry-After of one hour also cannot be honored with a maximum interval of thirty minutes.

Required revision: return a typed observation such as `deferred` with `retryAt` and a bounded reason; use no internal recovery sleep. Cap only locally generated backoff, then respect a larger provider deadline or close the attempt window without another request. Test 429/1200 seconds and 429/3600 seconds: one request, no sleep, no retry before the provider deadline. Independent review confirmed this incompatibility.

### F08 · P2 · The qualification switch has no implementable trust/bootstrap contract

Design 38 and 92; plan 80, 190–192 and 212.

The plan calls a record “protected” but does not define who writes it, the authenticated path, its schema, or how the Worker verifies its own release revision. Current `worker/src/env.ts` and `worker/wrangler.jsonc` contain no release identity. Exact revision binding also needs a rule for code rollouts and documentation/evidence commits: committing evidence can change the revision that evidence is meant to qualify. Requiring live mode qualification before probes are possible needs an explicit isolated qualification path.

Required revision: define one owner/admin-only qualification writer, trusted deployment identity, mode enum, artifact reference, expiry/revocation and default-off behavior. Keep evidence external to the tested build identity or define a reproducible code artifact digest. Define how the scratch harness exercises a disabled mode without opening production recovery. Add forged-record, wrong-build, wrong-account-version and rollback tests. Do not require clients to trust an arbitrary supplied SHA.

### F09 · P2 · Recovery storage and unresolved reservations have no terminal policy

Design 34, 52, 71 and 92; plan 80, 179 and 222.

A 24-hour search horizon is not a retention or row-count bound. Phase A's encrypted session, qualification rows and recovery history have no deletion/redaction deadline or owner/global record budget. The final checklist promises tests for “every … record … limit” without defining those limits. More seriously, unresolved sends retain their staging reservations: current `staging/store.ts:292–309` excludes reserved rows even after expiry. After searches stop, the plan supplies no owner repair action or independent safe byte-cleanup policy, so retained capacity can remain occupied indefinitely.

Required revision: specify separate schedules for stopping lookups, erasing session secrets, retaining idempotency outcomes, releasing proven-stopped byte storage and preserving unknown-writer debt. Define record caps and a concrete owner repair procedure that never marks unknown delivery failed-safe merely to free capacity. Test expired-but-reserved handles, recovery metadata admission at the cap and secret redaction after the search window. Do not solve storage pressure by deleting delivery evidence.

### F10 · P2 · URL rejection lacks a raw-input rule and a concrete endpoint grammar

Design 64; plan 47 and 61–63.

The plan requires rejection of encoded dot segments but only describes URL parsing plus path checks. Node's URL parser removes `%2e%2e` before pathname inspection; the local probe turned `/users/me/extra/%2e%2e/messages/send` into the allowed-looking `/users/me/messages/send`. A parsed-path check alone cannot enforce the written refusal. The allowed query keys/id grammar and operation-specific endpoint binding are also unspecified. A generic approved Google host is not proof that a session belongs to the intended API operation.

Required revision: define raw-string validation before normalization, decoded checks, exact endpoint/query grammar and operation-kind binding. Include the documented `uploadType` and `upload_id` fixture, prohibit credentials in error text, and qualify additional provider variants explicitly. Add the normalization counterexample as a test. This is a parser-contract defect, not an observed cross-host credential leak.

### F11 · P2 · The proposed Range grammar rejects a documented status example

Plan 52–64 and 70–75.

The plan names only `bytes=0-N`. Google's upload guide shows `bytes=0-524287` for chunk responses and `0-42` in its interrupted-upload status example. The documentation is not consistent enough to infer one live wire grammar. The current draft would reject the second documented form without a recorded decision. It also leaves exact status-request headers and incomplete-at-total behavior implicit.

Required revision: specify and test the supported forms, exact zero-byte request headers, integer/overflow/monotonicity checks, and final-response schema. Accept bounded known variants or document a qualified stricter contract; do not broaden to arbitrary Range syntax. Include both documented examples and malformed/multiple ranges. This is a documented compatibility risk, not proof that current Gmail emits both forms. [Gmail upload status examples](https://developers.google.com/workspace/gmail/api/guides/uploads#resume_an_interrupted_upload).

### F12 · P2 · This is an outline, not the execution-ready plan its final self-review implies

Plan 78–106, 133–137, 168–193 and 195–225.

Task 2 specifies a schema in prose without SQL, state enum or transition table. Its RecoveryBinding omits the audit/executor fields demanded by the task. Most test steps list case names without executable fixtures; only two areas supply short examples. Several steps combine a new persistence/transport mechanism, its tests and a commit, rather than a reviewable small unit. Task 6 builds preflight and documentation, but never specifies the actual executable live qualification runner. Task 7 explicitly postpones the byte-continuation implementation plan. Resource and physical durability gates have no complete procedure/sample count or acceptance thresholds.

Required revision: label the current artifact a staged design outline until Phase A has concrete SQL, transition assertions, typed interfaces and runnable regression fixtures. Complete the qualification harness task, including result schemas and numerical stop/pass rules. Keep Phase B an explicitly separate reviewed deliverable, with its unpaid requirements listed. This is acceptable sequencing, but it cannot be counted as an implementation-ready plan for all Plan 5. Simurgh's absorbed writing-plan contract requires those details; formatting and valid links do not satisfy it.

### F13 · P2 · Rollback ignores already-running old settlement code

Design 58 and 92; plan 171 and 212.

Disabling future recovery does not stop a previously leased job or old direct request. Current `settleExecuted` permits an already-executed row to satisfy its postcondition and then appends another audit (`tools/settle.ts:26–55`). A rollout/rollback with old and new handlers overlapping can therefore bypass the new unique winner unless all writers participate. Qualification by release revision alone does not fence an already-running writer. The design does not state a compatible rollout boundary or how disablement is rechecked before a late settlement.

Required revision: introduce the common settlement guard in a backward-compatible preparatory release, or define a quiescence/drain strategy before enabling recovery. Check an enablement epoch at recovery claim and settlement if disablement is intended to fence in-flight jobs. Preserve valid late direct result recording under the same winner rule. Test an old-style direct settlement racing new recovery and a job paused across disable/rollback. Existing SQL establishes the risk; no live rollout experiment was performed.

## Checks and rejected overstatements

- Thread-only draft recovery is weaker than the proposed exact-header filter. That improvement is real, but F01 shows it still does not prove causal delivery.
- Reconciliation must not automatically retry a missing search result or expired session. The conservative decision is supported by the application semantics; generic upload restart guidance is not a delivery receipt.
- A 308 response is not necessarily a redirect to follow. Keep redirect refusal; qualify how the transport exposes a 308 without a Location header. No recommendation to loosen redirect handling.
- Routine access-token refresh does **not** increment `credential_version` in current code (`google/tokens.ts:117–128`). The issue is reconnect/revocation races, not ordinary refresh invalidating every recovery record.
- A completed session receipt can confirm delivery without a search hit. F05 calls for preserving that stronger evidence, not requiring redundant weaker evidence.
- The existing tests were not rerun as part of this plan review. No production behavior changed. Historical baseline counts in design line 20 are explicitly historical and are not a finding.
- No live Gmail send, credential access, deployment, destructive experiment or physical power-loss test was performed.

## Reproducible evidence and coverage

`2026-09-13-plan-5-review-probes.mjs` reproduces four local counterexamples and prints the reviewed document hashes. These probes test the written predicates/standard URL behavior, not future implementation. An independent fresh-context review found F02, F05 and F07; each was checked against the cited source before inclusion. No unverified agent claim was promoted to runtime proof.

The line ledger associates each source line with the finding ids above or a no-finding rationale. Headings, table separators, code fences and blanks have structural entries. Coverage count is a reading-accountability measure; it does not imply exhaustive security proof.

## Simurgh second pass

The immediate user is Raoof, who needs to know whether an interrupted send requires mailbox inspection before risking another send. The obstacle is causal delivery evidence, not another retry wrapper. The work deepens the existing guarantee; this review makes no claim of market novelty.

All twelve invention questions were considered:

| Generator                  | Applicable result                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| G1: unpublished number     | Report automated resolution coverage alongside false confirmations; never optimize coverage by weakening evidence.       |
| G2: real failure           | Lost-response-after-commit is the named failure family. No external incident was verified here, so none is invented.     |
| G3: provider concession    | Persisted session/status mechanisms exist; they do not give this application's cross-system atomic settlement.           |
| G4: forced consistency     | Every success path must resolve to the same operation/result identity and one success audit.                             |
| G5: attack evidence        | Predeclare fault checkpoints and retain negative outcomes rather than rerunning until green.                             |
| G6: adversary branches     | Confirm exact evidence, remain unknown, or refuse invalid authority; a fresh send is not an ambiguity-resolution branch. |
| G7: auditable absence      | Record unqualified modes and not-run gates as explicit data.                                                             |
| G8: missing voice          | Owner inspection needs a concrete recovery/cleanup procedure, without giving the model resend authority.                 |
| G9: clock evidence         | Separate provider timestamps, execution start, retry deadlines and immutable search cutoff.                              |
| G10: unnecessary privilege | Most refusal/state tests stay synthetic and require no Gmail credentials.                                                |
| G11: adversarial user      | Reused draft IDs and overlapping requests are within the permitted interface and must be tested.                         |
| G12: prose as protocol     | Turn the evidence ledger and settlement laws into a checked schema/state model.                                          |

The stronger version would add a small executable state model covering direct response, session receipt, search evidence, account epochs and rollback epochs, with generated schedules checking two laws: no false confirmation from unrelated evidence; at most one durable success/result per operation. This is a concrete next artifact, not a current proof or a request to expand into unrelated features.

| Axis                          | Score / 10 | What would raise it                                                                  |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| Recovery direction            | 7          | Keep strong session evidence and explicitly bound draft search claims.               |
| Safety specification          | 4          | Resolve F01–F04 and state the accepted proof for every writer/settlement transition. |
| Execution readiness           | 3          | Concrete Phase A SQL, typed transport/evidence contracts and runnable crash tests.   |
| Qualification reproducibility | 4          | Actual guarded runner, trusted build identity and numerical acceptance criteria.     |

These are review judgments, not measured reliability. The first drafting pass only verified formatting/links; the gauntlet lowers readiness because source inspection and counterexamples exposed missing contracts. No finding is marked fixed. Recommended order: F01–F04, then F05/F06/F07/F08/F13, then F09–F12. Rerun this gauntlet against the revised hashes before implementation approval.
