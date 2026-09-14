# Plan 6 Simurgh gauntlet

Verdict: **revise before implementation**. Six actionable findings: four P1 and two P2. No P0 finding. Three additional feasibility gates were already disclosed by the draft; they remain unresolved and are not counted as newly discovered defects.

Reviewed on 2026-09-15 at `ac4eb0c8de666c4e97417dacfe8bab8566b99d3d`, against production baseline `f8a7c86363640c01453ac05a0e3a33838c83933f`. Read all 239 plan lines, 80 design lines and 16 deferred-register lines. The attached line ledger binds each reviewed line to its SHA-256; structural lines are marked separately. “Reviewed” is a reading/disposition record, not proof that a future implementation passes.

Scope: plan review only. The plan, design, register and production code remain unchanged. No live request, deployment, restore, credential access or physical trial was performed. A fresh-context reviewer independently checked evidence and qualification; both returned findings were verified against source and adopted, with no additional duplicate count.

## Findings

### F01 — P1: The normal-probe amendment omits the scheduler predicate

Location: Plan 6 lines 60–74, especially 73; design line 39.

Task 1 names `worker/src/operations/recovery-admission.ts` but omits `worker/src/operations/recovery-cron.ts`. Its instruction to update “all five” predicates is incomplete: `dueRecoveries()` has an independent scratch-only probe filter at source line 56.

Counterexample: revise the listed administration/admission code, insert a valid listed normal-profile probe, then run scheduled recovery. The selector returns no operation, so the new bounded probe never reaches claim or transport. A unit test calling `claimRecovery()` directly can pass while the actual workflow fails.

Evidence: the review probe executes the current selector SQL in a minimal SQLite fixture with all other conditions equal: scratch returns one row; normal returns zero. This is a query-level reproduction, not a workerd integration test.

Correction: enumerate every profile predicate by function, include `dueRecoveries`, and require one end-to-end scheduled selection → claim → request → settlement test for a listed normal operation. Pair it with unlisted, foreign-owner, expired and disabled cases. Avoid a manually asserted predicate count.

### F02 — P1: The pass requirements still mix incompatible recovery modes

Location: Plan 6 lines 62, 72, 130 and 221–222; design line 36.

The plan introduces mode-specific evidence but still requires generated-ID matches/replays “per target mode.” `worker/src/google/recovery-http.ts:42,55` restricts status PUT to `send_session_status` and search GET to `generated_search`. `worker/src/operations/reconcile.ts:161,167` enforces the same separation at settlement. Current `runCases()` also iterates all eleven cases, and the current enable loader requires them all.

Counterexample: a frozen status-mode run cannot produce generated-search recovery evidence. A frozen search-mode run cannot produce status settlement proof. Copying results from the other mode violates the exact-identity contract; checking only a generated header after a status success does not demonstrate generated-search recovery.

Correction: define an explicit required-case/proof-kind matrix for each mode and a separate release-component matrix. Specify which common safety components gate enablement versus release; do not weaken that boundary by omission. Update runner selection, report schema and enable validation together. Require two positive end-to-end run→enable tests, one per mode, plus negative cross-mode substitution tests. The release report can reference independently qualified mode runs without merging identities.

### F03 — P1: Preparation has no frozen attempt identity before fixture sends

Location: Plan 6 lines 116, 125–130; design lines 40 and 52.

The design freezes selection, identity, samples and mutation intents before activity. Task 5 instead creates fixtures, records operation IDs, edits probe state, and only then freezes the qualification epoch. The existing RunIdentity requires both `qualificationEpoch` and `manifestSha256`; the manifest includes the probe IDs that do not exist before fixture creation. No preparation identity/schema or transition is defined.

Counterexample: two preparation attempts fail, three later ones produce useful observations, and the final manifest names only those three operation IDs. Hashing that preparation file after the fact does not prove that it contains the entire precommitted attempt set. A crash before probe creation also has no defined identity for reconnecting the original durable mutation intents to a resumed run.

Correction: add a distinct PreparationIdentity with a precommitted sample-ID set, exact target identity, authorization digest, deadlines and mutation limits. Publish it before the first fixture send. Append one terminal/uncertain observation for every allocated sample, including preparation failures. Define a one-way transition to the probe-bound RunIdentity that includes the complete preparation root. Test omitted failures, extra attempts, substituted IDs, crash before probe and reconstruction after process restart. Keep qualification epochs out of preparation until they exist.

### F04 — P1: Probe authority can outlive the proposed fixture intent

Location: Plan 6 line 73; design lines 39–40.

The amendment requires an expiring private intent but does not define the persisted expiry or its enforcement during later recovery admission. The inherited admin transaction writes `expires_at = now + 604800000` (`scripts/qualification/admin.ts:82`) and does not read fixture authorization expiry. Worker request/settlement fences consult the control expiry, not the private manifest.

Counterexample under a literal reuse of the current transaction: the normal-profile probe is created with one minute remaining on its intent. After the operator intent expires, its control remains eligible for seven days and a bound operation can still admit recovery within its 24-hour horizon. A preflight expired-intent test does not cover this schedule.

Correction: specify what expiry authorizes. For the proposed time-bounded fixture authority, persist `probe.expires_at = min(now + 7 days, intent.expiresAt)` and check it in selection, claim, each HTTP admission and settlement. If already-admitted work has a grace rule, state its exact bound; do not inherit seven days silently. Test expiry while paused before request, during token refresh and before settlement. Keep ordinary enabled-qualification lifetime a separate rule.

This is a gap in the proposed contract, not a claim that normal probes already work in the current release.

### F05 — P2: Hash-set coverage loses distinct legacy writer sites

Location: Plan 6 lines 101–105.

The proposed set-equality check uses SQL hashes as row identities. The baseline CSV has **136 rows but only 129 unique SQL hashes**. Identical SQL occurs in different call sites with different surrounding transactions and bindings.

Counterexample: keep one fixture per unique SQL hash and discard the seven other locations. The proposed `Set(coveredHashes) == Set(inventoryHashes)` assertion passes. The corpus no longer meets the adjacent requirement to cover every inventory row.

Correction: use a stable site key containing baseline commit, path, source location/occurrence and SQL hash. Compare site-key multisets and validate each binding/disposition. SQL bodies may be deduplicated for storage, but every call-site context retains its own execution or independently justified reachability proof. Add a negative test deleting one duplicate-hash site.

Evidence: the review probe reproduced the exact 136/129 counts and demonstrated that the proposed set comparison accepts the reduced corpus.

### F06 — P2: The new interfaces are not sufficient to execute the plan

Location: Plan 6 lines 29–56, 125, 158 and 185; file lists in Tasks 1 and 5–10.

The plan supplies only a base Observation and hash list, without exact case payload schemas, numeric bounds, canonical identity encoding, reason enum, source-observation resolution or the required-case matrix. `VerifiedControllerContext` lists concepts rather than typed members. `verifyQuiescence(target)` has no defined target type. Provider controllers return the old `CaseOutcome`, while the new resources controller returns `ControllerResult`; the adapter into runner validation is not defined. Several file paths are shorthand without a declared base.

Concrete mismatch: Task 5 returns `provider_barrier_unavailable` as a CaseOutcome limitation. The existing reason enum in `scripts/qualification/run.ts:17–27` rejects it. A direct schema probe confirmed rejection; the runner would convert that invalid outcome to a failure rather than preserving the intended not-run reason. Task 1 lists `run.ts`, but does not specify the new enum or version transition needed to make this example executable.

Correction: add a normative version-2 contract appendix with complete bounded discriminated schemas, domain-separated canonical identity hashes, exact context/sink/intent interfaces, reason values, CaseOutcome/ControllerResult adapters and artifact layout. Expand file paths from the repository root. Include compilable representative tests for each task and split multi-subsystem steps into independently testable units. Resolve these contracts before implementing the controllers; a placeholder-word scan alone cannot establish execution readiness.

## Feasibility gates already disclosed, not new defects

| Gate                                       | What the draft gets right                                                                                                 | Evidence still needed before claiming closure                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Provider commit/response-loss barrier      | Distinguishes losing the client response from losing Gmail's response; refuses identity transfer from instrumented builds | A supported mechanism on the exact qualification artifact, its threat boundary and observed commit/response chronology |
| Writer quiescence and deployment exclusion | Refuses boolean/time-based proof and cross-host checkbox authority                                                        | A concrete mechanism excluding old and queued writers through restore, plus verifiable exclusive deployment control    |
| Deployed peak memory                       | Rejects Node RSS and successful requests as substitutes                                                                   | A supported measurement source with sufficient isolate/lifetime coverage for the stated peak gate                      |

Before the controller implementation tranche, add a feasibility decision record for each: selected mechanism and proof, or an explicit unresolved gate that limits the deliverable. This draft is honest about those unknowns; honesty does not make them implemented.

## Primary-source cross-check

- Standards: [RFC 9110 §9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2) supports the restriction on automatic retries of non-idempotent requests without additional knowledge. It does not prove a send was absent after a timeout.
- Incidents: [Cloudflare's June 12, 2025 outage report](https://blog.cloudflare.com/cloudflare-service-outage-june-12-2025/) records a broad service outage. It supports testing control-plane/evidence unavailability, not a claim that this repository experienced that incident.
- Provider behavior: [Gmail upload documentation](https://developers.google.com/workspace/gmail/api/guides/uploads) documents status queries; it does not supply this application's fault-injection mechanism.
- Restore: [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) explicitly says in-flight queries are cancelled. That does not by itself exclude an old Worker issuing a new query after restoration. The draft's refusal to infer full quiescence remains justified.
- User surface: [Anthropic's connector guidance](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors) distinguishes local and remote connectors. Retaining separate installed-client applicability is correct.

Checked on 2026-09-15. These sources constrain the review; none establishes live acceptance for this project.

## Simurgh limit pass

The operator who bears the immediate risk is the Gmail account owner, Raoof: duplicate sends or false delivery confirmation can affect real recipients. A reviewer or release operator could use the artifact tomorrow, but needs executable evidence contracts before enabling recovery. This work strengthens verifiable guarantees; it does not establish a new market category.

The concrete improvement beyond the first draft is a machine-checkable chain from precommitted fixture intent through every attempt to mode-specific enablement, with no omitted writer sites. It would replace several prose promises with recomputable negative tests.

| Generator                   | Review outcome                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| G1: unpublished number      | Report 136 writer sites separately from 129 unique SQL bodies; neither count proves runtime coverage        |
| G2: real failure            | Preserve outage/uncertain-response failure evidence; do not rename a test as proof of an unrelated incident |
| G3: incumbent limitation    | Status semantics do not supply provider-barrier instrumentation                                             |
| G4: honest self-consistency | Same target identity and mode must survive preparation, observations and enable validation                  |
| G5: adversarial filing      | Require all precommitted attempts when presenting a successful run                                          |
| G6: missing branch          | Each admitted mutation ends in proven result or explicit uncertainty, including crashes                     |
| G7: auditable absence       | Distinguish absent controller/proof from a failed test; neither qualifies                                   |
| G8: missing voice           | Recipient authorization remains exact and separate from operator deployment authority                       |
| G9: clock witness           | Intent expiry must reach durable control and request fences                                                 |
| G10: unnecessary privilege  | Retain preflight credential spies and credential-free review probes                                         |
| G11: hostile user           | Remove one duplicate-hash call site or preparation failure and require refusal                              |
| G12: prose protocol         | Compile required-case and evidence-schema contracts instead of trusting a checklist                         |

## Scorecard

Scores are review judgments, not reliability measurements. The final scores reflect the counterexamples above.

| Axis                    | Before counterexample checks | After gauntlet | Artifact that moves it higher                                                |
| ----------------------- | ---------------------------- | -------------- | ---------------------------------------------------------------------------- |
| Safety intent           | 8/10                         | 7/10           | Explicit probe-expiry fence and end-to-end normal scheduler test             |
| Evidence falsifiability | 7/10                         | 4/10           | Preparation commitment plus mode-specific evidence contract and tamper tests |
| Execution readiness     | 6/10                         | 4/10           | Complete bounded schemas, typed adapters and task-level runnable tests       |
| Closure feasibility     | 4/10                         | 4/10           | Supported provider barrier, quiescence/exclusion and peak-memory mechanisms  |

## Verification and disposition

`python3 docs/superpowers/reviews/2026-09-15-plan-6-review-probes.py` passes three counterexample checks. The initial minimal SQL fixture had a placeholder-count error; it was corrected before obtaining the selector result. No production check was loosened. A separate direct Node schema check rejects the planned new limitation value, as expected against the existing version-1 schema.

The probes establish specific defects/contract gaps; they are not Plan 6 implementation tests. No unchanged runtime suite was rerun or presented as new proof. The line ledger and manifest record reviewed inputs and review artifacts. All six findings remain open; no plan or implementation fixes were applied during this gauntlet.
