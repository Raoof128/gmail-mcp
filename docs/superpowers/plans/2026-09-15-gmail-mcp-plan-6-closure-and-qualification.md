# Gmail MCP Plan 6 Closure and Qualification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline. Steps use checkbox (`- [ ]`) syntax for tracking. The user has already selected inline execution; do not ask them to choose again.

**Goal:** Close the remaining V1 implementation gaps from Plans 4 and 5, provide executable qualification and restore tooling, and account for every deferred feature without claiming unperformed release evidence.

**Architecture:** Finish the evidence contracts and local fault harness before wiring private controllers. Separate recovery-mode qualification from release-wide component evidence, retain exact identity fences, and make unsupported provider or restore guarantees explicit blockers. Keep external actions behind concrete target-specific authorization.

**Tech Stack:** Existing TypeScript/Node >=22.18.0, pinned Zod/Vitest, Cloudflare Worker/D1/R2, Swift/Darwin/SQLite native helper. No new production dependency is assumed.

**Spec:** `docs/superpowers/specs/2026-09-15-gmail-mcp-plan-6-closure-design.md` (draft); inherited contracts: `docs/superpowers/plans/2026-09-13-plan-5-contracts.md`.

## Global constraints

- Draft for review; no implementation or external action has been approved by this document.
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

Create `scripts/qualification/contracts.ts` in Task 1 as the single home for these new interfaces; existing `Manifest`, `RunIdentity` and `CaseOutcome` remain in their current files until callers migrate together:

```ts
export type EvidenceSurface = "synthetic" | "live" | "installed-client" | "device" | "platform";
export type Verdict = "pass" | "fail" | "not_run";
export type Observation = {
  sampleId: string;
  surface: EvidenceSurface;
  sourceSha256: string;
  identitySha256: string;
  verdict: Verdict;
  reason: string | null; // schema-constrained reason enum, never arbitrary error text
};
export type ModeEvidence = {
  version: 2;
  purpose: "recovery-mode";
  mode: "generated_search" | "send_session_status";
  identitySha256: string;
  observationHashes: string[];
};
export type ControllerResult = {
  observations: Observation[];
  verdict: Verdict;
  limitation: string | null;
};
```

Zod schemas must bound arrays/strings, enforce UUID/digest grammar, enumerate reasons and reject unknown keys. Per-case typed payloads extend Observation; this base type is not sufficient evidence by itself. Controllers consume the existing frozen RunIdentity plus verified manifest and receive private sinks; they do not choose identities or verdict requirements.

## Task 1: Correct evidence, authorization and qualification bootstrap contracts (C04–C06)

**Files:** create `scripts/qualification/contracts.ts`, `test/artifacts.test.ts`, `test/evidence.test.ts`; modify `artifacts.ts`, `manifest.ts`, `run.ts`, `evidence.ts`, `preflight.ts`, `admin.ts`, `platform.ts`, `cli.ts`, `cases/types.ts`, `worker/src/operations/recovery-admission.ts`; create `worker/test/recovery-probe-scope.test.ts`.

**Interfaces:** produces version-2 schemas and `validateModeEvidence(input: unknown): ModeEvidence`; consumes the existing frozen RunIdentity and `loadEnableEvidence` entry point. Add a discriminated `purpose` to manifests: `recovery-mode` or `release-component`.

- [ ] Add negative fixtures for forged aggregates, duplicate/missing samples, swapped sample hashes, foreign build/account/grant/mode/epoch, synthetic-as-live and version-1 enablement. Add physical trial fixtures with both acknowledged and uncertain outcomes. Example acceptance assertion:

```ts
expect(() => validateModeEvidence({ version: 1, purpose: "recovery-mode" })).toThrow();
// A generated-id sample marked synthetic must refuse even with a valid source hash.
```

- [ ] Run `npm test -w @gmail-mcp/qualification -- --run test/artifacts.test.ts test/evidence.test.ts`; retain the missing-contract/incorrect-verdict RED results.
- [ ] Implement typed per-sample schemas; derive counts, verify referenced private artifacts before reporting pass, and reject undeclared extra attempts. Keep media-boundary/rollback synthetic and draft-negative mixed. Model the three physical trials without requiring three acknowledgements. A release-component run has no power to enable a mode. Revocation uses a separately authorized sacrificial account/run; its expected grant change must not silently rewrite a recovery-mode identity. Finish revocation/reconnect before qualifying a target grant.
- [ ] Implement the proposed normal-profile bounded probe only after the design amendment is approved: same exact-owner binding checks, explicit private intent, valid expiry and at most twenty existing IDs in all five admin/Worker predicates. No existing operation can be replaced or rebound to qualify. Test foreign/nonexistent IDs, empty/oversized list, expired intent, normal unlisted operation and paused jobs across edit. Without amendment approval, preserve the refusal and record C05 unresolved.
- [ ] Rerun targeted qualification tests and `npm test -w @gmail-mcp/worker -- --run test/recovery-probe-scope.test.ts test/recovery-budgets.test.ts`. Commit `fix(qualification): define attributable mode and release evidence`.

## Task 2: Complete transport and settlement fault schedules (C01)

**Files:** create `worker/test/recovery-barriers.ts`, `worker/test/recovery-transport-matrix.test.ts`; modify `worker/test/recovery-faults.test.ts`, `fake-google.ts` and test fixtures only unless a reproduced production defect needs repair.

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

**Interfaces:** corpus entry `{sourceSha256, file, line, sql, parameters, disposition, expectedOutcome}`; dispositions are guarded-refusal, safe-unrelated or unreachable-with-evidence. Each inventory row needs one entry, including dynamically composed writer variants.

- [ ] Read the exact baseline SQL from Plan 5's CSV with a CSV parser, preserve its byte hashes and bind valid owner/account fixtures. Add a test that fails if any inventory hash lacks a disposition or maps to duplicate unexplained entries.
- [ ] Run the new workerd test and capture RED. Use a coverage assertion such as `expect(new Set(coveredHashes)).toEqual(new Set(inventoryHashes))`, then execute each mapped SQL against real migrations.
- [ ] Run permitless legacy settlement both before and after a protocol-2 winner; assert refused writes and unchanged result/audit/key/storage state. Exercise unrelated protocol-1 maintenance positively. A harmless row update is not required to throw, but must have a reason and state assertions.
- [ ] Make supplemental fixture discovery independent of a developer's full Git history: either fetch the pinned object explicitly in CI or check in the minimal hash-verified fixture corpus. Do not rewrite historical planning manifests. Run workerd and the eighteen SQLite checks.
- [ ] Commit `test(recovery): execute the captured legacy writer corpus`.

## Task 4: Finish private admin, storage and interruption acceptance (C02)

**Files:** modify `scripts/qualification/test/{admin,storage,preflight,lock,platform,run}.test.ts` and corresponding modules only for reproduced defects; create `test/cli.test.ts` and `test/evidence-restart.test.ts`.

**Interfaces:** keep `changeQualification`, `abandonStorage`, `withDeploymentLock` and CLI commands; add durable per-run mutation intent records through the existing private file writer.

- [ ] Add cap 32/64 boundaries, disable/prune/recreate stale epochs, supplied-but-unverified build, credential spies, competing lock holders, unsafe path ancestors, partial evidence writes and post-activation drift. Confirm platform refusal occurs before mutation and containment never overwrites another operator's epoch.
- [ ] Run failing tests before implementing missing checks. For an uncertain producer assert `expect(remove).not.toHaveBeenCalled()`; include DELETE-then-late-PUT scheduling rather than only a static unknown flag.
- [ ] Cover interruptions before/after R2 delete and before bookkeeping; preserve quota debt and operation/key truth. Reject foreign/unrelated handles; prove later direct positive receipt still settles once. Redact injected credential/session-shaped errors from all result paths.
- [ ] Spawn actual Node CLI processes for preflight refusal, synthetic run, crash/restart and immutable failure publication. Consume a fixture mutation intent once before the remote call; on ambiguous completion retain unknown and require a new authorized run, never auto-repeat.
- [ ] Run `npm test -w @gmail-mcp/qualification`; commit `test(qualification): cover administrative interruption and scope`.

## Task 5: Wire real provider qualification controllers (C03, C05)

**Files:** create `scripts/qualification/controllers/provider.ts`, `controllers/provider-barrier.ts`, `controllers/context.ts`, `test/provider-controller.test.ts`; modify `cases/gmail.ts`, `cases/mcp.ts`, `cli.ts`; create `docs/runbooks/provider-qualification.md`.

**Interfaces:** `createProviderCases(context: VerifiedControllerContext): Partial<Record<CaseId, (identity: Readonly<RunIdentity>) => Promise<CaseOutcome>>>`. Define VerifiedControllerContext in `controllers/context.ts` with manifest, credential provider, bounded transport, private sink and durable intent store; CaseId comes from `(typeof caseIds)[number]`.

- [ ] First write a feasibility record for loss between Gmail commit and Worker receipt on the exact target. Document the mechanism, identity impact, provider observation and absence of public controls. If the only available technique changes Worker bytes/config, qualify that identity only. A client disconnect does not satisfy this barrier.
- [ ] Add refusal tests for missing barrier, missing authorization, extra recipient/CC/BCC, expired intent, request/byte ceiling, wrong account/grant, repeated mutation and changed serving identity. Example: `expect(await controller.run(identity)).toMatchObject({ result: "not_run", limitation: "provider_barrier_unavailable" })` when its verified barrier capability is absent; define `controller.run` in the test adapter with the declared CaseOutcome return type.
- [ ] Implement prepare/probe/run sequencing: authorized fixture creation produces sealed operation bindings and provider observations; probe binds only those existing IDs, then freeze its epoch for status/search checks. Hash the preparation record into the run. Do not label pre-epoch fixture preparation as an earlier qualification. Select status before search for session mode, and poll at five-minute cadence up to the 24-hour horizon using persisted scheduling state. No busy loop or retry-until-green.
- [ ] Wire real controllers into CLI registry. Update the MCP adapter's current scratch-only send restriction in the same reviewed amendment as normal-profile probes; a normal fixture send still requires exact recipient, account, deployment and durable intent limits. Generated-id: three exact matches/replays per target mode. Session: three >5 MiB bound commits with final receipt and one audit each. Draft: three synthetic reused-ID fixtures and one separately authorized live old-draft observation, zero automatic search confirmations. Preserve explicit unavailable-controller outcomes where feasibility fails; C03 stays open in that case.
- [ ] Run controller tests and an actual local CLI with fake network endpoints injected only by tests. Commit `feat(qualification): connect provider evidence controllers`. Live sends occur only in Task 11 with concrete authorization.

## Task 6: Connect attachment, reply and revocation controllers (C03)

**Files:** create `controllers/transfers.ts`, `controllers/reply-revoke.ts`, `test/transfer-controller.test.ts`, `test/reply-revoke-controller.test.ts`; modify `cases/gmail.ts`, `cases/mcp.ts`, `cli.ts`; reuse `companion/src/{transfers,http,native}.ts`.

**Interfaces:** controllers use VerifiedControllerContext and return the same CaseOutcome; companion operations run through the real CLI/native protocol, never arbitrary path arguments or shell commands from manifests.

- [ ] Add tests for exact digest/size, reused idempotency keys, denied/expired approval, download ACK lost response and unexpected recipient refusal. Read the final stored message bytes back through the Worker rather than assuming the request body arrived unchanged.
- [ ] Run the two targeted controller tests for RED; implement six round trips, three each at zero and 26,214,400 attachment bytes, and record encoded MIME <=36,700,160 bytes. Count each remote mutation against explicit intent limits.
- [ ] Keep the six exact MIME transport-boundary samples synthetic (three at 5 MiB, three at 5 MiB+1); include their independently typed proof in the release assessment. A live payload chosen by approximate attachment size cannot certify the exact encoded boundary.
- [ ] Implement three authorized replies on a fixture thread and a separate sacrificial-account revocation run. Refuse subsequent credential use; finish reconnect before freezing any new mode run. Retain first failures and block unexpected recipient expansion.
- [ ] Run targeted tests plus the existing Worker upload-ceiling, send-tools and companion round-trip suites. Commit `feat(qualification): connect transfer and revoke acceptance`.

## Task 7: Implement installed-client and native durability evidence (C03, C06, C07)

**Files:** create `controllers/clients.ts`, `controllers/native.ts`, `controllers/power-trials.ts`, `test/client-controller.test.ts`, `test/native-controller.test.ts`, `companion/native/Tests/NativeCoreTests/RaceTests.swift`; modify `cases/clients.ts`, `cases/native.ts`, native code only for reproduced defects; update `docs/runbooks/companion.md`.

**Interfaces:** bounded observation import `importDeviceObservation(path: string, identity: Readonly<RunIdentity>): Promise<Observation>` with case-specific versioned payload and source artifact hash. An operator observation is labeled as such; no aggregate counter import qualifies a client.

- [ ] Add filesystem race fixtures for rename/symlink/root replacement, file growth/shrink, hardlink/private-root overlap, concurrent publication, fsync errors, capacity failure, killed helper and journal reopening. Derive deterministic pause points from existing helper boundaries; keep test hooks out of the release helper.
- [ ] Run `swift test --package-path companion/native --filter RaceTests` for RED, then repair only demonstrated defects. Assert no overwrite, no out-of-root access and no ACK before durable receipt publication.
- [ ] Implement actual client run instructions and evidence capture for allow, ask and timeout continuation on Code, Desktop and claude.ai. Record versions and capability applicability; claude.ai has no local companion claim. Missing installed clients remain not-run. Verify the correct result/single send and absence of credentials/byte bodies from retained model-visible projections.
- [ ] Implement three real Keychain/browser login/logout cycles and ten process-kill publication points on the supported test host. Add three separate operator-supervised physical trials on disposable hardware, including acknowledged and uncertain windows. A process kill never supplies a power-trial observation. Tooling must refuse before disruptive steps without explicit device authorization.
- [ ] Run local controller tests and `npm run verify:native`; commit `test(native): add race and device qualification procedures`. Record real-device results only when Task 11 runs them.

## Task 8: Build maintenance and restore administration (C08)

**Files:** create `scripts/qualification/restore-cli.ts`, `controllers/restore.ts`, `controllers/quiescence.ts`, `test/restore-controller.test.ts`; modify `restore.ts`, `platform.ts`, `manifest.ts`; extend `worker/test/restore-floor.test.ts` and `docs/runbooks/release-qualification.md`.

**Interfaces:** replace boolean drain proof with `verifyQuiescence(target): Promise<VerifiedQuiescence>`; define an opaque validated type in `controllers/quiescence.ts` that includes database, generation, routed-version digest, issuer evidence hash and validity interval. No JSON boolean or timer can construct it. `restore-cli.ts --manifest <private-path>` accepts a separate strict restore manifest, not a qualification manifest repurposed by optional fields.

- [ ] Establish a supported way to exclude old/queued writers through restore and record its authoritative source and failure assumptions. Write tests that withhold proof, introduce an old routed version or release a delayed write. Without a defensible mechanism, implement preparation and refusal only and report C08 unresolved; do not manufacture quiescence.
- [ ] Run controller tests for RED. Example: `await expect(controller.restore(target)).rejects.toThrow("quiescence")`; assert the restore POST spy has zero calls, and maintenance remains active. Define the controller factory in this task using the new verified-proof interface and existing platform API.
- [ ] Implement private preflight, shared deployment exclusion, external generation rotation, routed maintenance verification, streamed private journal/key export and external receipt publication. Archive data separately from <=64 KiB result JSON; hash and verify the complete archive before restore. Recheck authorization and proof immediately before the single restore request.
- [ ] Test lost restore response without repeating POST, pre-0005 snapshots, old active flags/epochs, lost sent keys, partial migration failure and private receipt failure. Reapply append-only migrations only under maintenance and install a frozen marker. No resume path. Update the controller to reconcile uncertain response state through read-only authoritative queries.
- [ ] Run restore tests plus existing installation/cron regressions; commit `feat(recovery): add guarded private restore administration`. Actual Time Travel requires its own concrete authorization and proven quiescence.

## Task 9: Reproducible deployment, rollback and CI controls (C09, C11)

**Files:** create `scripts/qualification/release.ts`, `controllers/deployment.ts`, `test/release.test.ts`, `docs/runbooks/release.md`; modify `build-id.ts`, `lock.ts`, `.github/workflows/ci.yml` and qualification scripts as needed.

**Interfaces:** `prepareRelease(manifestPath: string): Promise<string>` publishes a private hash-bound preparation receipt; `verifyRelease(receiptPath: string): Promise<Verdict>` inspects current platform state. Preparation performs no deployment.

- [ ] Test dirty/untracked production input, changed lockfile/config/schema, missing embedded build, mismatched uploaded bundle/ETag, traffic split, unsupported rollback writer and drift immediately after enable. A supplied SHA is not authoritative proof.
- [ ] Run release tests for RED; implement bundle inspection and actual platform receipt generation using the exact effective configuration. Keep generated identity normalization reproducible; record migration order and a permit-aware compatible rollback candidate. Never remove migration guards during rollback.
- [ ] Ensure deployment and qualification commands use the same exclusion mechanism. A local lock covers only this host: require an enforceable single deployment controller or verified disabled external deployment actors for target runs. An operator checkbox alone cannot prove cross-host exclusion. Refuse if exclusive control cannot be established.
- [ ] Add a native CI lane on a validated supported macOS runner or a documented private-runner command. Verify host capabilities before choosing the runner; do not assume an available hosted image proves native durability. Keep live/disruptive tests out of pull-request jobs, scope credentials, and make the pinned legacy corpus available to shallow checkouts.
- [ ] Run local release tests, root verification and native gate; commit `ci(release): verify artifacts and compatible rollout controls`. External publication remains Task 11.

## Task 10: Implement deployed resource observations (C10)

**Files:** create `controllers/resources.ts`, `test/resource-controller.test.ts`; modify `cases/resources.ts`, `artifacts.ts`; create `docs/runbooks/resource-qualification.md`.

**Interfaces:** `collectResourceObservation(context: VerifiedControllerContext): Promise<ControllerResult>` validates the platform measurement source, deployment/version, sampling coverage, configured route CPU limit and fixture intent budget.

- [ ] Add tests rejecting Node RSS, incomplete isolate coverage, missing memory measurement, wrong tier/version, CPU >= limit, peak memory >=128,000,000 and resource-limit errors. `expect(result.verdict).toBe("not_run")` for unavailable measurement; exceeded limits produce fail.
- [ ] Run the resource test for RED. Establish the exact supported profiler/telemetry mechanism for this target; record limitations and sampling coverage. If it cannot establish peak isolate memory, implement the refusal and keep C10's live gate unresolved.
- [ ] Implement ten maximum-payload serial round trips plus two concurrent allowed download streams under explicit byte/send quotas. Record per-operation CPU and measured peak memory with source hashes; do not infer a pass from successful requests.
- [ ] Inject resource error and identity drift mid-run; assert immediate stop, no additional fixture admission, preserved first failure and safe cleanup debt.
- [ ] Run targeted tests; commit `feat(qualification): collect attributable resource observations`.

## Task 11: Run authorized target acceptance and release assessment (C03, C07–C11)

**Files:** create `scripts/qualification/assess-release.ts`, `test/release-assessment.test.ts`; update release runbooks, README and implementation ledger. Actual manifests/results live in private storage, never this repository.

**Interfaces:** `assessRelease(input: unknown): { verdict: Verdict; blockers: string[] }` consumes signed-off source observations, exact per-mode evidence and component runs with explicit identities. It cannot call enable or deploy.

- [ ] Write tests that refuse missing mandatory cases, mismatched component versions, malformed artifacts, unperformed device/resource checks, unapproved normal probe contract and transferred scratch evidence. Test that revocation component evidence cannot enable a new grant.
- [ ] Run assessment tests for RED; implement a public projection containing only finite status/reason/count/hash fields and private artifact references. Separate implementation, qualification and release verdicts; unresolved controller feasibility blocks implementation completion.
- [ ] Prepare exact targets, recipients, accounts, count/byte budgets, capabilities, expiry, disposable device and release/rollback identities. Complete all authorized local preparation before requesting missing external action authorization. Never infer it from “proceed with implementation.”
- [ ] Run the eleven cases with the exact sample requirements in the table below when prerequisites exist. Preserve first failures, stop for safety/drift, and keep unavailable cases not-run. Enable each mode only from its own valid target run under deployment exclusion; use a fresh epoch and verify post-write containment. Publish/deploy only when the user explicitly authorizes that target action.
- [ ] Run `npm run verify`, `npm run verify:native`, `python3 scripts/qualification/sql_conformance.py` and `git diff --check`; record actual results and commits. Keep README pre-release for missing mandatory acceptance. Commit `docs(release): record qualified surfaces and remaining blockers`.

## Task 12: Close the ledger and define signed-IOU follow-ons (C12)

**Files:** update `docs/superpowers/plans/2026-09-15-gmail-mcp-deferred-feature-register.md`; update the Plan 6 execution ledger and original spec links without rewriting old evidence.

**Interfaces:** each register entry has ID, current behavior, dependency, next design deliverable, acceptance condition and status. `deferred` is distinct from implemented or verified.

- [ ] Reconcile each item in the drafted register against implementation; fail the document coverage check if any original section-6 IOU, P4-OVERWRITE or Phase B entry is absent.
- [ ] Phase B: prepare a separate provider-proof/design package covering preceding-response authorization, immutable encrypted MIME chunks/manifest/AAD, source pinning, quotas including ciphertext, one retained MIME/owner, one global materializer/writer, 24h retention, three admissions and cleanup debt. Keep `phase_b_verified=false`; inconclusive provider evidence means no continuation implementation.
- [ ] Specify follow-on designs for overwrite with native approval/durability semantics; batch mutations with server-side +bulk; all-account search with per-account authorization and pagination; full local proxy with path confinement; multi-user onboarding/tenant isolation; Google verification/CASA applicability and evidence; >25 MB download streaming with quotas. These are independently reviewed expansions, not implicit Plan 6 production changes.
- [ ] Cross-check C01–C12 against committed tests, working controller entry points and real evidence. Open items keep their blocker and next action; do not close a task solely because a stub returns not-run.
- [ ] Commit `docs(roadmap): account for remaining release and feature work`.

## Acceptance matrix copied from Plan 5, with evidence-surface amendments

| Case                | Required samples and outcome                                                                                                               | Surface                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| generated-id        | 3 approved fixture sends per target mode; 3 exact matches and same-result replays, zero unrelated confirmation; poll every 5 min up to 24h | Live, exact mode identity                                    |
| session-status      | 3 bound >5 MiB sends; lose provider response after commit; status before search; 3 final receipts and one executed audit each              | Live, exact mode identity                                    |
| draft-negative      | 3 reused-ID/thread fixtures plus 1 authorized old-draft observation; zero automatic draft search confirmation                              | Synthetic + live, separately typed                           |
| byte-round-trip     | 3 at 0 bytes and 3 at 26,214,400 attachment bytes; exact digest/size; MIME <=36,700,160                                                    | Live                                                         |
| media-boundary      | 3 at exactly 5 MiB encoded MIME and 3 at 5 MiB+1; expected transport and one mutation each                                                 | Synthetic                                                    |
| reply-revoke        | 3 replies in fixture thread, one scratch revocation, subsequent use refused                                                                | Live component run; no identity transfer                     |
| installed-clients   | Allow/ask/timeout continuation per applicable Code/Desktop/claude.ai flow, exact versions; companion only Code/Desktop                     | Installed client                                             |
| native              | 3 real login/logout cycles, 10 process-kill publication points, no overwrite/stale epoch                                                   | Supported native host                                        |
| physical-durability | 3 supervised physical trials; acknowledged saves survive exact digest, uncertain saves stay unacknowledged                                 | Disposable physical device                                   |
| resources           | 10 maximum-payload serial round trips, 2 concurrent downloads; measured peak isolate memory <128,000,000; CPU below configured route limit | Exact deployed tier                                          |
| rollback            | Mixed writers, disable/prune/recreate, protocol-1/protocol-2/staging maintenance; refusal and one winner                                   | Synthetic corpus plus target deployment compatibility checks |

Do not force installed-client evidence into an unexplained aggregate of nine or classify synthetic components as live. Enumerate applicable flows before the run and record each one. Required capabilities cannot be waived merely because an installed client is unavailable.

## Plan review and completion

Planning checks: verify C01–C12 task coverage, existing referenced paths, proposed interface consistency, explicit contract amendments, specimen assertions against actual state names and absence of placeholder steps. Format the documents and run `git diff --check`. Planning does not require rerunning unchanged production tests or claim new runtime evidence.

Implementation complete requires real controller wiring, full local matrices and passing verification, with no unresolved feasibility gaps hidden behind ports. Target qualification complete requires the mandatory observations. Production release complete additionally requires an authorized rollout and observed target results. Deferred feature designs remain separately tracked; they are not delivered features.
