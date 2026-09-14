# Gmail MCP Plan 6 closure design

Status: draft for review. This document proposes remaining work; it does not authorize deployment, Gmail sends, revocation, restore, power loss or production enablement.

Baseline: `f8a7c86363640c01453ac05a0e3a33838c83933f` on `plan5-recovery`. The Plan 5 implementation ledger records 358 TypeScript tests, 18 supplemental SQLite checks and 13 native tests plus a release build. Those are historical local results, not new Plan 6 verification.

## Purpose and approach

Finish the implementation and acceptance work left by Plans 4 and 5, with an explicit disposition for the original design's deferred features. Preserve server authority, status-only recovery and restore quarantine.

Three approaches were considered. Adding more features first increases the unqualified surface. A documentation-only release checklist leaves the missing controllers unresolved. The recommended approach closes executable contracts and local fault coverage first, then connects private controllers, and finally collects target-specific evidence. Each work package has an independent test gate; a blocked device or platform measurement does not prevent unrelated local implementation.

The implementation plan decomposes that approach into twelve tasks. The user’s existing inline-execution preference applies when implementation is approved. This drafting request does not begin implementation.

## Observed gaps and coverage

| ID  | Current evidence or gap                                                                                                                  | Plan 6 task |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| C01 | Plan 5 Tasks 1/5/8 lack the full transport barrier and captured legacy-writer matrix                                                     | 2, 3        |
| C02 | Administration has limited stale epoch, cap, storage interruption and competing-operator acceptance                                      | 4           |
| C03 | CLI registry has no attached live controllers; MCP adapter is only a component                                                           | 5, 6, 7     |
| C04 | Aggregate artifact counters can describe success without per-sample provenance; mixed synthetic/live requirements need explicit modeling | 1           |
| C05 | Normal-profile bootstrap cannot use scratch-only probes; evidence cannot transfer between builds/profiles/accounts                       | 1, 5        |
| C06 | Physical validator requires three acknowledged saves; contract instead requires correctness for acknowledged and uncertain trials        | 1, 7        |
| C07 | Real Keychain/browser login, installed Code/Desktop/claude.ai and broader native filesystem races remain unverified                      | 7           |
| C08 | RestorePort.drained() is an injected boolean; no concrete maintenance/restore CLI/controller exists                                      | 8           |
| C09 | Exact build/deployment receipts, effective config, compatible rollback and shared deployment control require release integration         | 9           |
| C10 | Peak isolate memory and route CPU need actual target measurements; Node RSS is insufficient                                              | 10          |
| C11 | Live cases and final target release are not run; CI has no native qualification job                                                      | 9, 11       |
| C12 | Phase B, overwrite and original signed IOUs remain outside delivered V1                                                                  | 12          |

Sources: Plan 5 implementation ledger and revision-3 contracts; Plan 4 implementation execution record; current `scripts/qualification/{cli,artifacts,restore,platform}.ts`, `cases/`, `worker/test/recovery-faults.test.ts`, `.github/workflows/ci.yml`; original design sections 3 and 6.

## Contract revisions proposed for approval

1. Evidence format version 2 distinguishes a release run from a recovery-mode qualification run. Preserve version-1 files as historical inputs; reject them for new enablement. A release run references per-mode runs and component suites without merging their frozen identities. A recovery enable consumes only evidence for its exact origin/build/version/account/grant/mode/epoch/generation.
2. Each case contains bounded typed sample records and hashes of source observations. Required aggregate counts derive from those records. Media-boundary and legacy-writer tests remain synthetic components even inside a live release assessment. They cannot satisfy generated-id or session live requirements. No operator-entered aggregate alone can qualify a case.
3. Physical trials record `acknowledged_before_loss`, `recovered_digest_matches` and `uncertain_acknowledged` per trial. Three trials are required; each acknowledged save must survive, and every uncertain save must remain unacknowledged. Include both acknowledged and uncertain publication windows in the scheduled trials. Remove the unsupported requirement that all three trials acknowledge.
4. Add an explicitly authorized, operation-scoped probe on a normal deployment to remove the bootstrap dead end. This is a proposed change to Plan 5's scratch-only restriction, not an interpretation of the old contract. Require a concrete private intent naming owner/account/grant, exact fixture recipient, deployment identity, expiry and at most twenty existing operation IDs. Verify those IDs and their binding ownership before the control edit. Recovery remains confined to that list, with the existing budget, epoch and horizon checks. No broad mode enablement occurs before a matching live run passes. Update every admin, preflight, platform and Worker admission predicate together. If this amendment is not approved, normal-profile enablement stays unsupported and pre-release; do not copy scratch evidence.
5. Expand fixture authorization to include operation count and byte ceilings plus explicit capabilities for send, revoke, device power loss, deployment and restore. The plan document itself grants none of these capabilities. Per-case allocation must fit the run ceiling before credentials are read; each mutation consumes durable intent once. Recovery HTTP stays zero-body Phase A.

## Controller boundaries and evidence

Reuse TypeScript, Zod, Vitest/workerd and the existing Swift helper. Introduce small private controller modules rather than a public fault route. Controllers receive verified manifest context, exact endpoints, credential providers and private evidence sinks. They return typed observations to the runner, which derives verdicts. The CLI must construct real adapters; unit-test ports alone do not complete this work.

Implement deterministic synthetic barriers in test fixtures around binding, reservation, stream start, headers, partial bytes, provider commit, response, each settlement statement, settlement commit, disable and reconnect. Do not ship these hooks in the production Worker.

A real lost-response case requires evidence that Gmail committed before the Worker lost the relevant provider response. Dropping only the client-to-Worker response is a different case. The first controller milestone must establish a supported, private method on the exact qualification target. Any instrumented Worker has a different build identity and qualifies only itself. If a safe method cannot exercise the production artifact, emit `not_run: provider_barrier_unavailable`; it is an unresolved acceptance requirement, not a passing approximation.

Use authenticated Worker MCP/staging APIs and inherited-pipe native IPC. Installed-client observations come from the actual named/versioned client, with model traces checked for credential and byte leakage. Avoid retaining full traces or MIME in result files. Keep any necessary fixture transport buffers in memory; persist only allowed IDs in private operational state and counts/digests in evidence. Session URIs and tokens never enter result artifacts, including private results.

The runner freezes case selection, identity, sample allocation and operation intents before activity. Stop on the first duplicate send, false confirmation, unexpected recipient, credential leak, overwrite, resource error or identity drift. Interrupted runs preserve their first attempt records. Resumption cannot silently rerun a mutation or replace failure evidence. New attempts require a new explicitly authorized run.

## Restore safety and its feasibility gate

Cloudflare documents a bookmark-based restore API. The sources checked for this draft do not establish a general proof that previously admitted Worker/D1 writers have drained. A healthy maintenance response, no recent logs, empty local promises or an elapsed lease cannot supply that proof.

Task 8 must first produce a supported quiescence mechanism and its counterexample tests. A controller accepts structured evidence bound to the exact database, routed versions, generation and validity interval, not `drained: true` from a manifest. Exclude all old writers and hold exclusive deployment control; prove queued writes cannot land during or after restore. If the platform cannot provide that guarantee, ship the maintenance/preparation/refusal path, mark restore execution unavailable and retain the acceptance gap. A new writer architecture would need its own design amendment before implementation.

When proof exists, export the surviving journal and keys into a separate private archive, hash it, publish the external preparation receipt, reverify the proof, then call restore once. Do not put the journal into bounded result JSON. A lost restore response is an uncertain restore; retain maintenance and inspect authoritative state instead of repeating POST. Reapply append-only migrations under maintenance for a pre-0005 snapshot, install the new frozen marker and invalidate qualifications. Phase A has no resume command. Lost sent keys remain quarantined pending a separate incident-reconciliation design.

## Release conditions and retained constraints

Retain compatibility floor 3, protocol-2 permits, `_assert` preconditions, owner/account composite constraints, fresh grant and qualification fencing, 24-hour recovery, seven-day metadata, 8,192-byte combined binding/cipher cap and 4,124-byte cipher cap. Preserve ten attempts/window, two/account, thirty requests/window and thirty actual rolling-five-minute requests including refresh, 288 attempts/operation, 45-second attempts, 15-second HTTP-through-EOF limits, 240-second runs and 60-second leases. Keep ledger caps 3,000/9,000 and qualification caps 32/owner and 64/global. Preserve attachment 26,214,400 bytes, MIME 36,700,160 bytes, staging 262,144,000/owner and 524,288,000/global. V1 refuses overwrite.

Track three separate outcomes: implementation complete, target qualification complete, and production release complete. A complete registry includes actionable refusal paths, but a required case marked not-run prevents qualification. Unsolved controller feasibility also prevents claiming all Plan 6 implementation complete. Actual deployment, recipients, credentials, client installations and disposable hardware are external prerequisites; report them by name.

Never derive peak isolate memory from Node RSS, payload size or absence of crashes. Require provenance for target memory/CPU measurements. Preserve pre-release status while mandatory evidence is absent. CI can establish local portability and native tests only; it cannot certify live login, physical power loss or production resources.

## Deferred feature disposition

“All remaining” includes accounting for these signed IOUs, without silently replacing V1 boundaries: Phase B byte continuation; P4-OVERWRITE; batch label/trash/spam; all-account search; full local proxy; multi-user signup; Google verification/CASA; downloads above 25 MB. Task 12 gives each a dependency, exit criterion and follow-on design deliverable. Google verification/CASA gets a release applicability assessment; do not assume a broad launch has the same requirements as the owner-only product.

Phase B requires provider evidence authorizing another writer, immutable encrypted MIME chunks and manifest/AAD, pinned sources, quota accounting including encryption overhead, one retained MIME/owner, one global materializer/writer, 24-hour retention, at most three byte admissions and cleanup debt for uncertain producers. A lease timeout or status response alone cannot authorize continuation. Keep `phase_b_verified=false` unless a separately approved design and its live acceptance pass.

## Primary sources checked on 2026-09-15

- [Gmail attachment uploads](https://developers.google.com/workspace/gmail/api/guides/uploads): empty PUT status queries and resumable response semantics; this does not certify this application's lost-response fixture.
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/): bookmark restoration and its limits.
- [D1 Time Travel API](https://developers.cloudflare.com/api/resources/d1/subresources/database/subresources/time_travel/): bookmark and restore endpoints. No writer-drain guarantee is inferred from the endpoint's existence.
