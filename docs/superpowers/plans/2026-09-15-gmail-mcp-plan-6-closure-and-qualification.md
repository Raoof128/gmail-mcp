# Gmail MCP Plan 6 Closure and Qualification Implementation Plan (Revision 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline. Steps use checkbox (`- [ ]`) syntax for tracking. The user has already selected inline execution; do not ask them to choose again.

**Goal:** Close the remaining V1 implementation gaps from Plans 4 and 5, provide executable qualification and restore tooling, and account for every deferred feature without claiming unperformed release evidence.

**Architecture:** Finish the evidence contracts and local fault harness before wiring private controllers. Separate recovery-mode qualification from release-wide component evidence, retain exact identity fences, and make unsupported provider or restore guarantees explicit blockers. Keep external actions behind concrete target-specific authorization.

**Tech Stack:** Existing TypeScript/Node >=22.18.0, pinned Zod/Vitest, Cloudflare Worker/D1/R2, Swift/Darwin/SQLite native helper. No new production dependency is assumed.

**Spec:** `docs/superpowers/specs/2026-09-15-gmail-mcp-plan-6-closure-design.md` (revision 3); normative v2 appendix: `docs/superpowers/plans/2026-09-15-plan-6-contracts.md`; inherited contracts: `docs/superpowers/plans/2026-09-13-plan-5-contracts.md`.

## Global constraints

- Revision 3 retains F01–F06 and addresses B1–B6/M1–M9 from the attached follow-up review at the planning level. The user authorized these document corrections; implementation and target actions remain separate. The v2 appendix owns the explicit amendments to inherited evidence/probe contracts.
- Baseline `f8a7c86363640c01453ac05a0e3a33838c83933f`. Preserve existing local commits and historical review manifests.
- Implement inline after approval. Use existing branch unless the user requests another; if creating a branch, use an available `main/` prefix or record the existing `main` ref conflict.
- Phase A recovery sends zero additional MIME bytes; drafts remain manual when only search evidence exists. Preserve all numeric limits in the design's retained-constraints section and Plan 5 contracts.
- Compatibility floor 3; append-only migrations; same-batch permits, `_assert` and owner/account constraints. Raise the compatibility floor if a new writer contract actually requires it, with a reviewed migration/rollback amendment.
- Local authority remains in the native helper; remote authority remains in Worker policy. Never give an MCP caller operator controls.
- Evidence paths are outside repositories and attachment roots, with owner-only 0700 directories/0600 files and exclusive atomic publication. Never persist session URIs, credentials or MIME in result files.
- Missing proof is `not_run`; a failed case stays failed. Neither can enable recovery or satisfy release acceptance. Test success is not a deployment receipt.
- Every task uses failing-first tests for new behavior, targeted GREEN checks, security review and a local Conventional Commit. Do not push, merge or deploy based on historical Plan 4 authorization.

## Sequence and interfaces

Tasks 1–4 close contracts and local behavior. Tasks 5–7 connect provider, transfer and device controllers. Task 8 owns restore; Task 9 owns deployment identity/control. Task 10 measures resources. Task 11 assembles the release assessment after those dependencies. Task 12 records feature follow-ons and remaining blockers. Implement useful independent tasks while an external prerequisite is missing.

The complete bounded schemas and typed interfaces live in `docs/superpowers/plans/2026-09-15-plan-6-contracts.md`. Task 1 creates `scripts/qualification/contracts.ts`, `scripts/qualification/contracts-validation.ts` and `scripts/qualification/controllers/context.ts` from those contracts. All controllers return ControllerResult; CaseAdapter derives a version-2 CaseReport. EvidenceVerifier resolves the private source graph and validates exact mode/common requirements. No version-1 CaseOutcome cast is allowed.

Execute each numbered task through its stated failing-test, implementation and verification gates. Within Tasks 1, 4, 7 and 9, finish the lettered unit before the next; each is independently testable and reviewable. First resolve the feasibility decision records for provider barriers (Task 5), restore/exclusion (Task 8/9) and deployed memory (Task 10) before implementing a target mechanism. Independent local tasks can continue when those decisions remain blocked.

## Runtime implementation and feasibility map

Runtime implementation remains pending, with provider-barrier, writer-quiescence, and peak-memory feasibility gates explicitly retained.

Implementation has started. The execution record below supersedes the baseline status for Tasks 1 and 4; the three feasibility gates remain open.

This map tracks the remaining Plan 6 work after the revision-3 planning corrections at `b124739`. Passing reference-contract checks does not close runtime tasks. Update a status only with the corresponding implementation commit and verification evidence.

| Task | Remaining work                                                                                                 | Current status                                                                                                            | Evidence required to close                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Runtime v2 schemas, mutation authority, phase manifests, source verification and bounded normal-profile probes | In progress: v2 CLI/runner, source adapter and Worker predicates implemented; production bindings and enable flow pending | Contract/admission refusal tests and scheduled selection through settlement, including expiry boundaries                             |
| 2    | Transport, settlement and recovery fault schedules                                                             | In progress: 28 transport cases and settlement rollback tests; remaining schedules open                                   | Full fault matrix with operation/key/reservation/audit assertions and one immutable winner                                           |
| 3    | Legacy writer corpus and native boundary coverage                                                              | In progress: 136 sites executed and accounted for; full upload transaction/race acceptance pending                        | All 136 site keys covered with parameters and verified outcomes; native boundary evidence                                            |
| 4    | Durable intent consumption, private artifacts, component orchestration and admin interruption handling         | In progress: durable consumption/results and dependent dispatch implemented; closure and admin matrix pending             | Two-process/crash tests, exact consumed hashes, bounded reads, preserved failures and source ordering                                |
| 5    | Provider proof controllers and mode-specific preparation                                                       | Pending implementation; provider-barrier gate open                                                                        | Verified barrier decision, controller wiring and three distinct proof samples for each separately qualified mode                     |
| 6    | Attachment, reply and sacrificial revocation controllers                                                       | Pending implementation                                                                                                    | Exact byte round trips, thread binding and source-to-consumed-slot/grant verification                                                |
| 7    | Native races, installed clients and physical durability procedures                                             | In progress: native race fixes and per-sample device import; device acceptance not run                                    | Local race tests plus attributable installed-client, Keychain/browser, process-kill and physical-trial evidence                      |
| 8    | Maintenance and one-shot restore controller                                                                    | Preparation/refusal implemented; v1 boolean retired; writer-quiescence gate open                                          | Supported quiescence proof, generation binding, bounded private export and lost-response reconciliation without another restore POST |
| 9    | Build/deployment receipts, compatible rollback, CI and shared deployment exclusion                             | CI corpus checks and private native-runner recipe implemented; deployment controls pending                                | Reproducible artifact receipts, routed-version checks and enforceable cross-host exclusion                                           |
| 10   | Deployed memory/CPU and payload measurements                                                                   | Pending implementation; peak-memory gate open                                                                             | Verified measurement coverage, counted payload bytes/fixture hashes and passing serial/concurrent limits                             |
| 11   | Separate mode/component acceptance and release assessment                                                      | Read-only assessor implemented; target qualification and release not run                                                  | Two independent mode proof runs, nine common component runs, all mandatory evidence and authorized release results                   |
| 12   | Final ledger reconciliation and separately reviewed feature follow-ons                                         | Register and follow-on design drafts updated; independent review and reconciliation pending                               | C01–C12 disposition with evidence; every deferred or retired IOU accounted for without claiming it implemented                       |

| Feasibility gate                                  | Dependent tasks                | Required next decision and evidence                                                                                                                                      | Behavior while unresolved                                                                                                                        |
| ------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider-barrier                                  | 5, 11                          | Record a supported mechanism for loss between Gmail commit and Worker receipt on the exact artifact; pin the primary source, identity impact and falsifying test result  | Refuse qualifying provider execution with provider_barrier_unavailable; controller completion and mode qualification remain open                 |
| Writer-quiescence, including deployment exclusion | 8, 9, 11; all live controllers | Record an authoritative mechanism excluding old/queued writers and competing deployments across hosts; test delayed writes, routed-version drift and proof expiry        | Refuse restore and affected live execution with quiescence_unavailable or deployment_exclusion_unavailable; keep maintenance active when entered |
| Peak-memory                                       | 10, 11                         | Record a supported target profiler/telemetry mechanism with peak-isolate coverage under maximum payload and two-stream concurrency; verify source attribution and limits | Record measurement_unavailable; resource qualification and implementation completion remain open                                                 |

Each decision record names the mechanism, current primary source, exact target capabilities, falsifying test and observed result. Independent local tasks may proceed while a gate is open. A refusal path preserves safety but does not close its mechanism, runtime task or acceptance requirement. Production release additionally requires explicit target authorization and observed rollout evidence.

## Task 1: Correct evidence, authorization and qualification bootstrap contracts (C04–C06)

**Files:** create `scripts/qualification/contracts.ts`, `scripts/qualification/test/artifacts.test.ts`, `scripts/qualification/test/evidence.test.ts`; modify `scripts/qualification/artifacts.ts`, `scripts/qualification/manifest.ts`, `scripts/qualification/run.ts`, `scripts/qualification/evidence.ts`, `scripts/qualification/preflight.ts`, `scripts/qualification/admin.ts`, `scripts/qualification/platform.ts`, `scripts/qualification/cli.ts`, `scripts/qualification/cases/types.ts`, `worker/src/operations/recovery-admission.ts`, `worker/src/operations/recovery-cron.ts`, `worker/src/operations/reconcile.ts`; create `worker/test/recovery-probe-scope.test.ts`.

**Interfaces:** implements the appendix schemas, CaseAdapter and EvidenceVerifier.validateModeEvidence(input, sink, expectedIdentity). Replace the old RunIdentity/CaseOutcome/report schema atomically across callers. Task 1 owns VerifiedControllerContext; add `scripts/qualification/contracts-validation.ts` and `scripts/qualification/controllers/context.ts` to this task’s created files. Manifest purpose is recovery-mode or release-component; mode reports contain one mode proof plus all nine common components.

- [ ] **1A: Schema and source graph.** Add negative fixtures for forged aggregates, duplicate/missing samples, swapped sample hashes, foreign build/account/grant/mode/epoch, synthetic-as-live and version-1 enablement. Add physical trial fixtures with both acknowledged and uncertain outcomes. Example acceptance assertion:

```ts
expect(ModeEvidence.safeParse({ version: 1, purpose: "recovery-mode" }).success).toBe(false);
expect(requiredProof("generated_search")).toBe("generated-id");
expect(requiredProof("send_session_status")).toBe("session-status");
```

- [ ] Run `npm test -w @gmail-mcp/qualification -- --run test/artifacts.test.ts test/evidence.test.ts`; retain the missing-contract/incorrect-verdict RED results.
- [ ] Implement the appendix’s exact typed sample schemas, reason enum, source resolution and verdict matrix; verify private source files before deriving a pass and reject undeclared extra attempts. Add one complete positive run→enable test per mode, with all nine common components, and reject swapped mode proof, missing common component or altered component snapshot. Version-1 evidence cannot enable. Keep media-boundary/rollback synthetic and draft-negative mixed. Model the three physical trials without requiring three acknowledgements. A release-component run has no power to enable a mode. Revocation uses a separately authorized sacrificial account/run; its expected grant change must not silently rewrite a recovery-mode identity. Finish revocation/reconnect before qualifying a target grant.
- [ ] **1B: Preparation identity.** Implement the appendix allocation/intent commitment and closed outcome set before fixture activity. Test an omitted failed preparation, duplicate/extra sample, substituted operation ID, absent intent slot and crash before probe. Task 4 implements the durable writer; Task 1 fixes its exact interface and pure transition rules.
- [ ] **1C: Bounded probe.** Implement every named predicate in appendix section 5, including dueRecoveries, both claim/qualification predicates and settleRecovered fences. Persist probe expiry as min(now+604800000, intent.expiresAt); retain separate enabled lifetime. No grace for new recovery request/refresh/retry/settlement at expiry. Preserve original direct positive receipt semantics. Test scheduled selection→claim→zero-body request→settlement for listed normal and scratch operations, then unlisted/foreign/disabled/wrong-epoch/expired refusals. Pause before request, during refresh and before settlement at expiry−1/expiry/expiry+1. No rebinding of operations or extension of their horizon.
- [ ] Rerun targeted qualification tests and `npm test -w @gmail-mcp/worker -- --run test/recovery-probe-scope.test.ts test/recovery-budgets.test.ts`. Commit `fix(qualification): define attributable mode and release evidence`.

## Task 2: Complete transport and settlement fault schedules (C01)

**Files:** create `worker/test/recovery-barriers.ts`, `worker/test/recovery-transport-matrix.test.ts`; modify `worker/test/recovery-faults.test.ts`, `worker/test/fake-google.ts` and test fixtures only unless a reproduced production defect needs repair.

**Interfaces:** `barrier(point: BarrierPoint): Promise<void>` in test fixtures, with `BarrierPoint` equal to bound, reserved, mime-start, headers, partial-body, provider-commit, response, settlement-statement, settlement-commit, disable or reconnect. No production route or remotely selected fault name.

- [ ] Build the executable matrix over media send, multipart reply, resumable send and direct draft send. Mark only inapplicable byte points on draft-ID POST with a reason. Include operation/key/pending/reservation/audit assertions, not just request counts.
- [ ] Run `npm test -w @gmail-mcp/worker -- --run test/recovery-transport-matrix.test.ts` and capture failures for absent barriers. A representative invariant is:

```ts
expect(snapshot.externalMutations).toBeLessThanOrEqual(1);
expect(snapshot.executedAudits).toBe(snapshot.state === "executed" ? 1 : 0);
expect(snapshot.keyOperationId).toBe(snapshot.operationId);
```

`snapshot` is a test helper's typed result from real D1 queries and FakeGoogle counters, not a supplied expected object. The operation terminal state is `executed`; the recovery metadata state is `completed`.

- [ ] Implement scheduling with deferred promises and injected test clocks, not sleeps. Exercise provider commit followed by lost body, partial JSON, malformed success, 4xx/5xx, 401 after MIME, body EOF timeout, response/settlement races, disable/re-enable, revoke/reconnect and late direct proof after metadata/storage cleanup. Preserve unknown when byte admission occurred; no retry of MIME.
- [ ] Extend statement-boundary rollback to pending actions, keys and reservations. Race status versus search versus late direct response: one immutable winner and one executed audit. Re-run the existing failure suites alongside the new matrix.
- [ ] Commit `test(recovery): cover transport and settlement fault schedules` with any reproduced fixes described separately.

## Task 3: Execute the legacy writer and native boundary inventories (C01, C07)

**Files:** create `worker/test/legacy-writer-corpus.ts`, `worker/test/recovery-legacy-writers.test.ts`, `docs/superpowers/reviews/2026-09-15-plan-6-writer-coverage.json`; modify `scripts/qualification/sql_conformance.py`; native races remain Task 7.

**Interfaces:** appendix section 6 defines siteKey from baselineCommit/path/line/occurrence/sqlSha256. Corpus entries include siteKey, exact parameters, surrounding transaction statements, disposition and expected state. Dispositions are guarded-refusal, safe-unrelated or unreachable-with-evidence. Cover all 136 baseline sites; 129 distinct SQL bodies is only a storage statistic.

- [ ] Read the exact baseline SQL from Plan 5's CSV with a CSV parser, preserve its byte hashes and bind valid owner/account fixtures. Add a test that fails if any site key lacks a disposition, duplicates a site or loses its surrounding binding/transaction context. Remove one duplicate-body site as the negative fixture.
- [ ] Run the new workerd test and capture RED. Use a coverage assertion such as `expect([...coveredSiteKeys].sort()).toEqual([...inventorySiteKeys].sort())`, then execute each mapped SQL against real migrations.
- [ ] Run permitless legacy settlement both before and after a protocol-2 winner; assert refused writes and unchanged result/audit/key/storage state. Exercise unrelated protocol-1 maintenance positively. A harmless row update is not required to throw, but must have a reason and state assertions.
- [ ] Make supplemental fixture discovery independent of a developer's full Git history: either fetch the pinned object explicitly in CI or check in the minimal hash-verified fixture corpus. Do not rewrite historical planning manifests. Run workerd and the eighteen SQLite checks.
- [ ] Commit `test(recovery): execute the captured legacy writer corpus`.

## Task 4: Finish private admin, storage and interruption acceptance (C02)

**Files:** modify `scripts/qualification/test/{admin,storage,preflight,lock,platform,run}.test.ts` and corresponding modules only for reproduced defects; create `scripts/qualification/test/cli.test.ts` and `scripts/qualification/test/evidence-restart.test.ts`.

**Interfaces:** retain changeQualification/abandonStorage and implement appendix PrivateSink/IntentStore. Durable mutation identity is authorization ID plus preparation commitment plus slot ID, independent of output-directory/run UUID. The complete pre-execution intent graph joins the preparation commitment.

- [ ] **4A: Administrative transactions.** Add cap 32/64 boundaries, disable/prune/recreate stale epochs, supplied-but-unverified build, credential spies, competing lock holders, unsafe path ancestors, partial evidence writes and post-activation drift. Confirm platform refusal occurs before mutation and containment never overwrites another operator's epoch.
- [ ] Run failing tests before implementing missing checks. For an uncertain producer assert `expect(remove).not.toHaveBeenCalled()`; include DELETE-then-late-PUT scheduling rather than only a static unknown flag.
- [ ] **4B: Storage debt.** Cover interruptions before/after R2 delete and before bookkeeping; preserve quota debt and operation/key truth. Reject foreign/unrelated handles; prove later direct positive receipt still settles once. Redact injected credential/session-shaped errors from all result paths.
- [ ] **4C: Durable preparation.** Spawn actual Node CLI processes for preflight refusal, crash after intent consumption, crash before probe, ambiguous probe response and immutable failure publication. Recover the same committed preparation; every allocated sample gets an outcome, including failed/uncertain/not-run. Already-consumed slots permit read-only reconciliation, not mutation. Reject copied output directories and new UUIDs attempting to reuse the same authorization. Publish intended probe epoch before the batch, then verify it read-only after uncertain response; do not create a second epoch.
- [ ] Run `npm test -w @gmail-mcp/qualification`; commit `test(qualification): cover administrative interruption and scope`.

## Task 5: Wire real provider qualification controllers (C03, C05)

**Files:** create `scripts/qualification/controllers/provider.ts`, `scripts/qualification/controllers/provider-barrier.ts`, `scripts/qualification/test/provider-controller.test.ts`; modify `scripts/qualification/cases/gmail.ts`, `scripts/qualification/cases/mcp.ts`, `scripts/qualification/cli.ts`; create `docs/runbooks/provider-qualification.md`.

**Interfaces:** `createProviderCases(): Partial<Record<CaseId, Controller>>`. Use Task 1’s VerifiedControllerContext and ControllerResult. Task 1 creates context.ts; Task 5 implements PreparationController on PreparationContext before the final run exists, then Controller on VerifiedControllerContext; it implements verified workerRequest and provider-barrier capability checks. CaseAdapter.run converts observations/unavailability into CaseReport with the full reason enum.

- [ ] First write a feasibility record for loss between Gmail commit and Worker receipt on the exact target. Document the mechanism, identity impact, provider observation and absence of public controls. If the only available technique changes Worker bytes/config, qualify that identity only. A client disconnect does not satisfy this barrier.
- [ ] Add refusal tests for missing barrier, missing authorization, extra recipient/CC/BCC, expired intent, request/byte ceiling, wrong account/grant, repeated mutation and changed serving identity. Example: `expect(await adapter.run(context, "generated-id", controller)).toMatchObject({ result: "not_run", limitation: "provider_barrier_unavailable" })` when the barrier capability is absent; controller returns an empty ControllerResult and the version-2 adapter preserves the reason.
- [ ] Implement appendix prepare→consume→seal→probe-bound sequencing. Publish complete sample/intent commitments before credentials or sends; mode preparations allocate exactly three relevant proof samples. Preserve all preparation failures; only an all-ready closed set transitions to its preallocated probe epoch. Freeze the final identity with both preparation and transition roots. Poll at five-minute cadence within original horizon and probe expiry using stable persisted identity. Verify intended mode on every selected lease; isolate the other mode from these fixture IDs. No busy loop or retry-until-green.
- [ ] Wire real controllers into CLI registry. Update the MCP adapter's current scratch-only send restriction in the same reviewed amendment as normal-profile probes; a normal fixture send still requires exact recipient, account, deployment and durable intent limits. Generated-search mode: three generated-ID search matches/replays. Session-status mode: three >5 MiB bound commits with final receipt and one audit each. Draft: three synthetic reused-ID fixtures and one separately authorized live old-draft observation, zero automatic search confirmations. Preserve explicit unavailable-controller outcomes where feasibility fails; C03 stays open in that case.
- [ ] Run controller tests and an actual local CLI with fake network endpoints injected only by tests. Commit `feat(qualification): connect provider evidence controllers`. Live sends occur only in Task 11 with concrete authorization.

## Task 6: Connect attachment, reply and revocation controllers (C03)

**Files:** create `scripts/qualification/controllers/transfers.ts`, `scripts/qualification/controllers/reply-revoke.ts`, `scripts/qualification/test/transfer-controller.test.ts`, `scripts/qualification/test/reply-revoke-controller.test.ts`; modify `scripts/qualification/cases/gmail.ts`, `scripts/qualification/cases/mcp.ts`, `scripts/qualification/cli.ts`; reuse `companion/src/{transfers,http,native}.ts`.

**Interfaces:** controllers use VerifiedControllerContext and return ControllerResult through CaseAdapter; companion operations run through the real CLI/native protocol, never arbitrary path arguments or shell commands from manifests.

- [ ] Add tests for exact digest/size, reused idempotency keys, denied/expired approval, download ACK lost response and unexpected recipient refusal. Read the final stored message bytes back through the Worker rather than assuming the request body arrived unchanged.
- [ ] Run the two targeted controller tests for RED; implement six round trips, three each at zero and 26,214,400 attachment bytes, and record encoded MIME <=36,700,160 bytes. Count each remote mutation against explicit intent limits.
- [ ] Keep the six exact MIME transport-boundary samples synthetic (three at 5 MiB, three at 5 MiB+1); include their independently typed proof in the release assessment. A live payload chosen by approximate attachment size cannot certify the exact encoded boundary.
- [ ] Implement three authorized replies on a fixture thread and a separate sacrificial-account revocation run. Refuse subsequent credential use; finish reconnect before freezing any new mode run. Retain first failures and block unexpected recipient expansion.
- [ ] Run targeted tests plus the existing Worker upload-ceiling, send-tools and companion round-trip suites. Commit `feat(qualification): connect transfer and revoke acceptance`.

## Task 7: Implement installed-client and native durability evidence (C03, C06, C07)

**Files:** create `scripts/qualification/controllers/clients.ts`, `scripts/qualification/controllers/native.ts`, `scripts/qualification/controllers/power-trials.ts`, `scripts/qualification/test/client-controller.test.ts`, `scripts/qualification/test/native-controller.test.ts`, `companion/native/Tests/NativeCoreTests/RaceTests.swift`; modify `scripts/qualification/cases/clients.ts`, `scripts/qualification/cases/native.ts`, native code only for reproduced defects; update `docs/runbooks/companion.md`.

**Interfaces:** bounded observation import `importDeviceObservation(path: string, identity: Readonly<RunIdentity>): Promise<Observation>` with case-specific versioned payload and source artifact hash. An operator observation is labeled as such; no aggregate counter import qualifies a client.

- [ ] **7A: Local native races.** Add filesystem race fixtures for rename/symlink/root replacement, file growth/shrink, hardlink/private-root overlap, concurrent publication, fsync errors, capacity failure, killed helper and journal reopening. Derive deterministic pause points from existing helper boundaries; keep test hooks out of the release helper.
- [ ] Run `swift test --package-path companion/native --filter RaceTests` for RED, then repair only demonstrated defects. Assert no overwrite, no out-of-root access and no ACK before durable receipt publication.
- [ ] **7B: Installed clients.** Implement actual client run instructions and evidence capture for allow, ask and timeout continuation on Code, Desktop and claude.ai. Record versions and capability applicability; claude.ai has no local companion claim. Missing installed clients remain not-run. Verify the correct result/single send and absence of credentials/byte bodies from retained model-visible projections.
- [ ] **7C: Host/device procedures.** Implement three real Keychain/browser login/logout cycles and ten process-kill publication points on the supported test host. Add three separate operator-supervised physical trials on disposable hardware, including acknowledged and uncertain windows. A process kill never supplies a power-trial observation. Tooling must refuse before disruptive steps without explicit device authorization.
- [ ] Run local controller tests and `npm run verify:native`; commit `test(native): add race and device qualification procedures`. Record real-device results only when Task 11 runs them.

## Task 8: Build maintenance and restore administration (C08)

**Files:** create `scripts/qualification/restore-cli.ts`, `scripts/qualification/controllers/restore.ts`, `scripts/qualification/controllers/quiescence.ts`, `scripts/qualification/test/restore-controller.test.ts`; modify `scripts/qualification/restore.ts`, `scripts/qualification/platform.ts`, `scripts/qualification/manifest.ts`; extend `worker/test/restore-floor.test.ts` and `docs/runbooks/release-qualification.md`.

**Interfaces:** implement appendix QuiescenceVerifier.verify(target: RestoreTarget): Promise<VerifiedQuiescence> in controllers/quiescence.ts. The complete strict RestoreTarget and bounded QuiescenceRecord schemas are in the appendix; only a supported mechanism verifier may produce the branded result. No JSON boolean, parse or cast supplies verification. `node scripts/qualification/restore-cli.ts --manifest <private-path>` accepts a separate strict restore manifest, not a qualification manifest repurposed by optional fields.

- [ ] Establish a supported way to exclude old/queued writers through restore and record its authoritative source and failure assumptions. Write tests that withhold proof, introduce an old routed version or release a delayed write. Without a defensible mechanism, implement preparation and refusal only and report C08 unresolved; do not manufacture quiescence.
- [ ] Run controller tests for RED. Example: `await expect(controller.restore(target)).rejects.toThrow("quiescence")`; assert the restore POST spy has zero calls, and maintenance remains active. Define the controller factory in this task using the new verified-proof interface and existing platform API.
- [ ] Implement private preflight, shared deployment exclusion, external generation rotation, routed maintenance verification, streamed private operation-journal and idempotency-record export (excluding Worker secrets, TOKEN_KEK, OAuth plaintext and token ciphertexts; any credential-backup design requires separate review) and external receipt publication. Archive data separately from <=64 KiB result JSON; hash and verify the complete archive before restore. Recheck authorization and proof immediately before the single restore request.
- [ ] Test lost restore response without repeating POST, pre-0005 snapshots, old active flags/epochs, lost sent keys, partial migration failure and private receipt failure. Reapply append-only migrations only under maintenance and install a frozen marker. No resume path. Update the controller to reconcile uncertain response state through read-only authoritative queries.
- [ ] Run restore tests plus existing installation/cron regressions; commit `feat(recovery): add guarded private restore administration`. Actual Time Travel requires its own concrete authorization and proven quiescence.

## Task 9: Reproducible deployment, rollback and CI controls (C09, C11)

**Files:** create `scripts/qualification/release.ts`, `scripts/qualification/controllers/deployment.ts`, `scripts/qualification/test/release.test.ts`, `docs/runbooks/release.md`; modify `scripts/qualification/build-id.ts`, `scripts/qualification/lock.ts`, `.github/workflows/ci.yml` and qualification scripts as needed.

**Interfaces:** `prepareRelease(manifestPath: string): Promise<string>` publishes a private hash-bound preparation receipt; `verifyRelease(receiptPath: string): Promise<Verdict>` inspects current platform state. Preparation performs no deployment.

- [ ] **9A: Artifact recipes.** Test dirty/untracked production input, changed lockfile/config/schema, missing embedded build, mismatched uploaded bundle/ETag, traffic split, unsupported rollback writer and drift immediately after enable. A supplied SHA is not authoritative proof.
- [ ] Run release tests for RED; implement bundle inspection and actual platform receipt generation using the exact effective configuration. Keep generated identity normalization reproducible; record migration order and a permit-aware compatible rollback candidate. Never remove migration guards during rollback.
- [ ] **9B: Deployment exclusion.** Ensure deployment and qualification commands use the same exclusion mechanism. A local lock covers only this host: require an enforceable single deployment controller or verified disabled external deployment actors for target runs. An operator checkbox alone cannot prove cross-host exclusion. Refuse if exclusive control cannot be established.
- [ ] **9C: CI portability.** Add a native CI lane on a validated supported macOS runner or a documented private-runner command. Verify host capabilities before choosing the runner; do not assume an available hosted image proves native durability. Keep live/disruptive tests out of pull-request jobs, scope credentials, and make the pinned legacy corpus available to shallow checkouts.
- [ ] Run local release tests, root verification and native gate; commit `ci(release): verify artifacts and compatible rollout controls`. External publication remains Task 11.

## Task 10: Implement deployed resource observations (C10)

**Files:** create `scripts/qualification/controllers/resources.ts`, `scripts/qualification/test/resource-controller.test.ts`; modify `scripts/qualification/cases/resources.ts`, `scripts/qualification/artifacts.ts`; create `docs/runbooks/resource-qualification.md`.

**Interfaces:** `collectResourceObservation(context: VerifiedControllerContext): Promise<ControllerResult>` validates the platform measurement source, deployment/version, sampling coverage, configured route CPU limit and fixture intent budget.

- [ ] Add tests rejecting Node RSS, incomplete isolate coverage, missing memory measurement, wrong tier/version, CPU >= limit, peak memory >=128,000,000 and resource-limit errors. `expect(await adapter.run(context, "resources", controller)).toMatchObject({ result: "not_run", limitation: "measurement_unavailable" })` for unavailable measurement; exceeded limits produce fail.
- [ ] Run the resource test for RED. Establish the exact supported profiler/telemetry mechanism for this target; record limitations and sampling coverage. If it cannot establish peak isolate memory, implement the refusal and keep C10's live gate unresolved.
- [ ] Implement ten maximum-payload serial round trips plus two concurrent allowed download streams under explicit byte/send quotas. Record per-operation CPU and measured peak memory with source hashes; do not infer a pass from successful requests.
- [ ] Inject resource error and identity drift mid-run; assert immediate stop, no additional fixture admission, preserved first failure and safe cleanup debt.
- [ ] Run targeted tests; commit `feat(qualification): collect attributable resource observations`.

## Task 11: Run authorized target acceptance and release assessment (C03, C07–C11)

**Files:** create `scripts/qualification/assess-release.ts`, `scripts/qualification/test/release-assessment.test.ts`; update release runbooks, README and implementation ledger. Actual manifests/results live in private storage, never this repository.

**Interfaces:** `assessRelease(input: unknown): { verdict: Verdict; blockers: string[] }` consumes signed-off source observations, exact per-mode evidence and component runs with explicit identities. It cannot call enable or deploy.

- [ ] Write tests that refuse missing mandatory cases, mismatched component versions, malformed artifacts, unperformed device/resource checks, unapproved normal probe contract and transferred scratch evidence. Test that revocation component evidence cannot enable a new grant.
- [ ] Run assessment tests for RED; implement a public projection containing only finite status/reason/count/hash fields and private artifact references. Separate implementation, qualification and release verdicts; unresolved controller feasibility blocks implementation completion.
- [ ] Prepare exact targets, recipients, accounts, count/byte budgets, capabilities, expiry, disposable device and release/rollback identities. Complete all authorized local preparation before requesting missing external action authorization. Never infer it from “proceed with implementation.”
- [ ] Run one generated_search proof run, one send_session_status proof run, and nine independently typed common component runs with the exact sample requirements below. Each run has its own identity and manifest; the two mode runs have separate epochs. Preserve first failures, stop for safety/drift, and keep unavailable cases not-run. Enable each mode only from its own valid target run under deployment exclusion; use a fresh epoch and verify post-write containment. Publish/deploy only when the user explicitly authorizes that target action.
- [ ] Run `npm run verify`, `npm run verify:native`, `python3 scripts/qualification/sql_conformance.py` and `git diff --check`; record actual results and commits. Keep README pre-release for missing mandatory acceptance. Commit `docs(release): record qualified surfaces and remaining blockers`.

## Task 12: Close the ledger and define signed-IOU follow-ons (C12)

**Files:** update `docs/superpowers/plans/2026-09-15-gmail-mcp-deferred-feature-register.md`; update the Plan 6 execution ledger and original spec links without rewriting old evidence.

**Interfaces:** each register entry has ID, current behavior, dependency, next design deliverable, acceptance condition and status. `deferred` is distinct from implemented or verified.

- [ ] Reconcile each item in the drafted register against implementation; fail the document coverage check if any original section-6 IOU or retired item, P4-OVERWRITE or Phase B entry is absent.
- [ ] Phase B: prepare a separate provider-proof/design package covering preceding-response authorization, immutable encrypted MIME chunks/manifest/AAD, source pinning, quotas including ciphertext, one retained MIME/owner, one global materializer/writer, 24h retention, three admissions and cleanup debt. Keep `phase_b_verified=false`; inconclusive provider evidence means no continuation implementation.
- [ ] Specify follow-on designs for overwrite with native approval/durability semantics; batch mutations with server-side +bulk; all-account search with per-account authorization and pagination; full local proxy with path confinement; multi-user onboarding/tenant isolation; Google verification/CASA applicability and evidence; >25 MB download streaming with quotas. These are independently reviewed expansions, not implicit Plan 6 production changes.
- [ ] Cross-check C01–C12 against committed tests, working controller entry points and real evidence. Open items keep their blocker and next action; do not close a task solely because a stub returns not-run.
- [ ] Commit `docs(roadmap): account for remaining release and feature work`.

## Acceptance matrix copied from Plan 5, with evidence-surface amendments

| Case                | Required samples and outcome                                                                                                                | Surface                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| generated-id        | 3 approved generated-search fixture sends; 3 exact matches and same-result replays, zero unrelated confirmation; poll every 5 min up to 24h | Live, generated_search identity                              |
| session-status      | 3 bound >5 MiB sends; lose provider response after commit; status before search; 3 final receipts and one executed audit each               | Live, send_session_status identity                           |
| draft-negative      | 3 reused-ID/thread fixtures plus 1 authorized old-draft observation; zero automatic draft search confirmation                               | Synthetic + live, separately typed                           |
| byte-round-trip     | 3 at 0 bytes and 3 at 26,214,400 attachment bytes; exact digest/size; MIME <=36,700,160                                                     | Live                                                         |
| media-boundary      | 3 at exactly 5 MiB encoded MIME and 3 at 5 MiB+1; expected transport and one mutation each                                                  | Synthetic                                                    |
| reply-revoke        | 3 replies in fixture thread, one scratch revocation, subsequent use refused                                                                 | Live component run; no identity transfer                     |
| installed-clients   | 15 committed flows: 9 remote (3 clients × 3 flows), 6 companion (Code/Desktop × 3 flows); exact versions                                    | Installed client                                             |
| native              | 3 real login/logout cycles, 10 process-kill publication points, no overwrite/stale epoch                                                    | Supported native host                                        |
| physical-durability | 3 supervised physical trials; acknowledged saves survive exact digest, uncertain saves stay unacknowledged                                  | Disposable physical device                                   |
| resources           | 10 maximum-payload serial round trips, 2 concurrent downloads; measured peak isolate memory <128,000,000; CPU below configured route limit  | Exact deployed tier                                          |
| rollback            | Mixed writers, disable/prune/recreate, protocol-1/protocol-2/staging maintenance; refusal and one winner                                    | Synthetic corpus plus target deployment compatibility checks |

The appendix enumerates all fifteen installed-client flows: remote and companion evidence are distinct. A missing client or capability stays not-run; it cannot shrink the required set. Both mode enablement and release require the nine common safety components, with their own complete identities and matching snapshot hashes.

## Plan review and completion

Planning checks: run `node docs/superpowers/reviews/2026-09-15-plan-6-contract-check.mjs`, then verify C01–C12 task coverage, existing referenced paths, proposed interface consistency, explicit contract amendments, specimen assertions against actual state names and absence of placeholder steps. Format the documents and run `git diff --check`. Planning does not require rerunning unchanged production tests or claim new runtime evidence.

Implementation complete requires real controller wiring, full local matrices and passing verification, with no unresolved feasibility gaps hidden behind ports. Target qualification complete requires the mandatory observations. Production release complete additionally requires an authorized rollout and observed target results. Deferred feature designs remain separately tracked; they are not delivered features.

Runtime implementation remains pending, with provider-barrier, writer-quiescence, and peak-memory feasibility gates explicitly retained.

Revision-3 implementation acceptance: Task 1 owns the seven exact purpose/phase manifest shapes, ToolCapability and central validateResolvedMutation adapter, with exact sender/To and empty CC/BCC tests across effective draft/reply/send payloads. Task 4 owns Consumption hash equality, per-native-action slots, bounded-before-parse artifact reads and component source ordering/crash closure. Task 6 verifies the sacrificial scope and consumed intent in reply/revoke sources. Task 8 binds both generation fields and exports only operation-journal/idempotency records. Task 10 verifies counted payload bytes and fixture hashes. Tasks 11–12 use separate mode/component runs and account for the retired audit header. The revision-3 resolution record and manifest preserve the evidence; prior revision manifests refer to their original commits.

## Inline execution record: initial runtime checkpoint

The user authorized inline implementation after the map commit `961f280`. Work remains on `plan5-recovery`; the verified baseline had 358 passing tests. No external service mutation, deployment or device trial occurred.

Task 1 is in progress. `scripts/qualification/contracts.ts` now contains the reviewed v2 schemas and pure rules. `contracts-validation.ts` derives case verdicts from typed observations and verifies component preparation/source graphs. Tests cover mixed acknowledged/uncertain physical trials, duplicate/missing/swapped samples, source hashes and foreign identities. Runtime reports now carry `preparationClosure: ArtifactRef`; the root alone could not locate the closure. The appendix and planning checker include that interface correction.

The old version-1 evidence loader cannot produce enable authority. The administrator rejects evidence without version 2 before platform verification. The v2 CLI/runner migration, CaseAdapter, full mutation-journal/corpus/resource source resolvers, and complete positive mode→enable integration are still pending. Their absence must not be hidden by a passing schema or a mocked aggregate. The verifier currently refuses reports requiring those unfinished source resolvers.

The Worker scheduler, claim selector and common qualification fence now permit explicitly listed probes in normal and scratch profiles. Actual workerd tests exercise scheduled selection→zero-body metadata requests→settlement and refusal for unlisted/disabled/expired controls, wrong epochs and expiry during request/refresh/settlement admission. Existing direct-receipt behavior is unchanged. Private probe administration still needs the v2 intent/preparation integration and persisted intent-expiry bound; Task 1C remains open as a whole.

Task 4's dependent storage unit has started. Private artifact reads allocate at most 65,537 bytes and refuse overflow before fatal UTF-8/JSON parsing. The sink checks basenames, private permissions and exact hashes. The host-wide intent store pins one authorization to one preparation, atomically records exact consumption hashes and preserves the first terminal outcome. Four OS processes produce one new consumption and three read-only replay results. Changed arguments, rebinding and replacing an uncertain outcome refuse. This does not prove cross-host exclusion or physical power-loss durability.

Verification: the new tests first failed for missing runtime contracts, missing private sink/store and acceptance of unversioned enable evidence. Normal-profile scheduling and expiry tests reproduced the scratch-only restriction before the predicate correction. The final `npm run verify` exited 0: shared 11, Worker 317, companion 9 and qualification 36, totaling 373 tests. All 28 planning contract checks and strict compilation passed. Native code did not change; native tests were not rerun. Full Task 1 completion and Tasks 2–12 remain tracked above, including the three open feasibility gates.

## Inline execution record: v2 runner checkpoint (2026-09-16)

Task 1 remains in progress. The default CLI now parses v2 phase manifests through `preflight-v2.ts`. It binds private authorization, deployment receipt, preparation commitments and allocated intent templates before dispatch. `run-v2.ts` selects exactly one mode proof or common component. `case-adapter.ts` freezes controller context, preserves observations, closes preparation through a trusted finalizer port and derives the report from verified sources.

The driver checks authorization expiry before and after target verification and again after execution. Late identity drift seals a failed report. Tests reproduced a safety-counter failure being classified as unavailable; the adapter now retains that failure. Legacy v1 execution is isolated in `legacy-run.ts` and `legacy-cli.ts`, and accepts only explicit synthetic runs. No legacy command can perform live administration.

Production target/exclusion, controller and preparation-finalizer bindings remain pending. The default v2 commands emit `not_run` with `deployment_exclusion_unavailable` before controller dispatch. This includes prepare, probe, enable and disable. Full mutation-journal/corpus/resource source resolution, intent-bound administration and positive mode-to-enable integration remain open. Tasks 1 and 4 are incomplete; the provider-barrier, writer-quiescence and peak-memory gates remain open.

Verification: `npm run verify` exited 0 with 385 tests (shared 11, Worker 317, companion 9, qualification 48). Tests cover source-derived component reports, mode selection, immutable context, caller-verdict rejection, late drift, authorization expiry and private preflight/dispatch. These are local fixtures, including the physical-trial source graph; no live or physical trial occurred. Native code did not change.

## Inline execution record: durable component closure (2026-09-16)

Tasks 1 and 4 remain in progress. `openIntentJournal` reconciles existing consumptions and sample outcomes without creating authority or consuming slots. The store pins the first source by authorization/sample before writing its derived outcome. A restart can recover that source even if outcome publication was interrupted. Exact source hashes, preparation binding, private-file checks and immutable outcomes remain enforced.

`DurableComponentFinalizer` closes every allocation for components with no mutation slots and publishes a complete source graph. It retains omitted/failed samples, verifies observation source bytes, checks expiry after source reads and preserves previous outcomes across restarts. Evidence verification now requires the defined empty journal root for these components. Mutation-bearing preparation and full journal provenance still refuse; production controller/admin wiring and the three feasibility gates remain open.

Tests first reproduced missing runtime finalization, an arbitrary empty-journal root being accepted, loss of a source before outcome publication, and readiness backdated across expiry. The fixes passed `npm run verify`: 397 tests (shared 11, Worker 317, companion 9, qualification 60). Child-process tests terminate after consumption or sample sealing and reopen the same host journal. These prove local restart behavior, not physical power-loss durability.

## Inline execution record: transport, native and assessment checks (2026-09-16)

Task 2 now has 28 Worker scenarios covering four send transports and seven receipt outcomes. The tests exercise approval, idempotency, reserved storage, ambiguous delivery and late direct receipts. Settlement fault tests check linked pending, storage and key state across transaction rollback boundaries. A stalled-body regression reproduced an unbounded wait after response headers. Mutation receipt reads now enforce a 15-second deadline and 65,536-byte limit, with fatal UTF-8 parsing and no send retry. Remaining disable/reconnect and reconciliation schedules stay open.

Task 7 adds five native race tests. They reproduced temporary inode/content replacement and cleanup deleting a replacement file. Publication now verifies the original temporary file and the published receipt; failure retains the temporary entry for identity-checked journal recovery. All 18 native tests and the release build passed. These local tests do not establish installed-client, real login, helper kill-point or physical durability acceptance.

Task 1 validates ordered intent graphs and writes canonical template bytes without a newline. Tests reject forward references, overlapping destinations, literal replacement and altered template hashes. Device evidence import verifies individual source files and exact run identities. Task 11 now has an asynchronous, read-only release assessor because source verification requires artifact reads. It requires both modes and all nine components, rejects foreign targets and altered graphs, and keeps implementation readiness incomplete independently of manifest assertions. Its public result contains finite reasons and counts, without private target details. Neither the importer nor the assessor supplies the missing production controllers.

Verification: `npm run verify` exited 0 with 434 tests: shared 11, Worker 347, companion 9 and qualification 67. Supplemental SQLite checks passed all 18 tests; planning checks passed all 28 checks and strict compilation. CI now fetches the pinned legacy baseline before SQLite conformance. The 136-site workerd writer corpus remains pending; the eighteen SQLite checks do not substitute for it.

The private Downloads directory exists with owner-only permissions. No live target manifest or operation authorization has been supplied. Production controller/admin wiring, mutation-bearing source resolution, remaining fault and native schedules, restore integration, resource measurement and follow-on closure remain incomplete. Provider-barrier, writer-quiescence and peak-memory feasibility gates remain open. No live send, deployment, restore, credential revocation or physical trial occurred.

## Inline execution record: guarded dispatch, restore refusal and captured writers (2026-09-16)

Mutation dispatch now verifies canonical literal arguments and the effective recipient projection, consumes the durable slot before transport, and rechecks the live target, projection and expiry immediately before execution. A lost response or already-consumed slot cannot repeat a mutation. Tests reproduced a changed effective envelope being accepted after consumption; the second projection check closes that gap. Dependent-result resolution and production transport bindings remain pending, and reference-bearing slots refuse.

Restore preparation now validates a separate strict v2 manifest, exact snapshot/generation and hash-bound restore authorization. The private CLI publishes a refusal receipt without platform access. A regression reproduced the old function invoking restore with `drained: true`; the retired v1 entry point now refuses before any platform operation. No supported quiescence mechanism exists in this implementation, so restore execution remains unavailable.

The immutable writer corpus captures all 136 site identities and exact SQL bodies from the pinned baseline. Its generator verifies source line locations and hashes, including duplicate-body sites. Workerd executes 11 original settlement/audit sites before a protocol-2 winner, after it and against matched protocol-1 controls. The 34 tests include exact guard errors, passing/failing assertion setups and full linked-state snapshots. Post-winner zero-row updates establish unchanged state, not guard refusal. The other 125 sites and original whole-batch transaction mappings remain open.

Device controllers import individual attributed samples in allocation order, retain prior observations on failure and check capability, source identity, expiry and target drift. They perform no device operations. Follow-on design drafts now cover all deferred register entries and the retired audit header; independent review remains pending.

Verification: `npm run verify` passed 476 tests (shared 11, Worker 381, companion 9, qualification 75). Native verification passed 18 tests and the release build. Supplemental SQLite checks passed 18 tests; planning checks passed 28 checks and strict compilation. The corpus regeneration check and `git diff --check` passed. No external mutation or device acceptance occurred. These changes advance Tasks 1–4, 7–9, 11 and 12; they do not close the remaining local matrices, production integrations or the three feasibility gates.

## Inline execution record: journal and cron writer mappings (2026-09-16)

Executable corpus coverage now includes 22 of 136 sites: the eleven settlement/audit sites, four operation-journal sites and seven cron sites. Each duplicate journal insertion keeps its original site identity. Tests exercise default protocol-1 insertion, idempotent insertion, dynamic transition predicates, permit refusal and matched legacy maintenance. Cron expiry and audit retention remain allowed maintenance rather than being misclassified as protocol-2 refusal cases.

The original success, failed-safe, unknown-pending and recoverClaimed batches now execute against the installed migrations. Protocol-2 cases preserve operation, pending, storage and idempotency state after refusal; protocol-1 controls establish the expected positive transitions. Standalone tests still exercise statements that a failed batch cannot reach. A test fixture initially computed its stale-row cutoff before seeding; computing the cutoff after setup makes the intended row match and establishes the expected guard refusal.

`npm run verify` passed 509 tests: shared 11, Worker 414, companion 9 and qualification 75. The final journal test also passed after adding an explicit matched terminal-state overwrite refusal. No production source changed in this checkpoint. Native evidence remains the preceding 18-test/release-build result. The remaining 114 site mappings, broader fault schedules and runtime/controller work remain open; no target acceptance or feasibility gate closed.

## Inline execution record: full captured-site execution (2026-09-17)

All 136 captured SQL sites now execute against installed workerd migrations with matched fixtures and state assertions. Eight coverage groups retain file, line and original SQL hash; a site enters the completed set only after its fixture assertions pass. The coverage test rejects omission of a duplicate-body site and registration under the wrong group. Dynamic pending approve/deny/cancel variants and token guardedWrite suffixes preserve their original binding context.

The new groups cover approval, idempotency, authentication, account/token/policy updates, staging and upload/retry/cleanup metadata. Policy fixtures account for the revision trigger's extra write. Materialization fixtures release their own test lease after asserting the result, so they do not block unrelated setup. Protocol-2 tests cover late reservation, download lease edits, terminal cleanup deletion and upload-writer predicates, preserving operation/key/pending/storage/audit state. Matched protocol-1 upload fixtures use the actual upload action rather than claiming coverage from send-action no-ops.

`npm run verify` passed 657 tests: shared 11, Worker 562, companion 9 and qualification 75. The corpus-specific run passed 195 tests before twenty additional upload-fence cases entered the full gate. Full site execution closes the inventory coverage gap. It does not establish every upload transaction interruption schedule, controller integration or live compatibility result; Tasks 2–4 remain open for those requirements. No production source changed in this checkpoint, and no live acceptance or feasibility gate closed.

## Inline execution record: dependent intents and durable results (2026-09-17)

The local dispatcher now resolves declared fields from earlier consumed slots in the same preparation. It verifies source hashes, template/tool/sample/slot identity, primary target, timestamps and the complete consumed record before reconstructing arguments. Resolution rejects literal replacement, overlapping paths, sparse arrays, string indices into arrays and prototype paths. The existing effective-envelope and expiry checks still run before consumption and before transport.

Trusted transport adapters can publish a strict projection containing only the six permitted ID fields. The host journal pins the first projection for each consumed slot through exclusive publication and directory synchronization. Competing replacements fail; reopening the journal or restarting a process preserves the result and cannot grant another consumption. Projection errors, publication failures, target drift and expiry after transport retain the consumed slot and report uncertainty. A staging-to-send integration test resolves the recorded handle, rejects substitution and prevents replay of either slot after reopening.

Production adapters, sacrificial-target dependencies, mutation-bearing preparation closure and the administration interruption matrix remain pending. The local result journal establishes provenance for argument resolution; it does not prove provider settlement or cross-host exclusion. Provider-barrier, writer-quiescence and peak-memory gates remain open. No live mutation or device acceptance occurred.

Verification: `npm run verify` passed 680 tests: shared 11, Worker 562, companion 9 and qualification 98. Planning checks passed 28 cases and strict TypeScript compilation; SQLite checks passed 18 tests. The captured-writer regeneration check and `git diff --check` passed. Reproduce the focused checks with `npm test --workspace=@gmail-mcp/qualification -- --run test/intent-resolution.test.ts test/intent-results.test.ts test/mutation-dispatch.test.ts`. Native code did not change; its preceding 18-test/release-build evidence remains historical.

## Inline execution record: v2 platform identity integration (2026-09-17)

`verifyTargetV2` now consumes the v2 target, authorization and deployment receipt and runs authoritative platform, SELECT-only database and health checks. Shared platform code accepts the fields it reads, so v2 callers do not invent a legacy `exclusiveDeploymentControl` boolean. Tests reject receipt/authorization mismatch, split routing, wrong sender, changed grant, generation drift and expiry before or after the reads.

Verification: `npm run verify` passed 689 tests: shared 11, Worker 562, companion 9 and qualification 107. This adds deployment identity verification to Tasks 1 and 9. It does not establish deployment exclusion, provider barriers, peak memory or reproducible bundle provenance. Read-only discovery checked the exact Worker name in both authenticated Cloudflare accounts without finding an accessible target inventory. A real target remains unidentified; the updated feasibility record retains the three unresolved gates.
