# Recovery qualification and rollback

Release remains **pre-release**. Recovery for new generated-message sends is status-only and never resumes MIME bytes, which `allowed()` in `worker/src/google/recovery-http.ts` enforces by refusing any Gmail recovery request whose `init.body` is not null rather than by recording a flag. Existing protocol-1 operations and ambiguous draft sends require manual review. A missing search result or an expired session does not establish that mail was not sent: absence of positive evidence is not proof of non-delivery, and an operation stays `delivery_unknown` until authoritative positive evidence resolves it.

## Local verification

Run from the repository root with the pinned lockfile dependencies:

```sh
npm ci
npm run verify
npm run verify:native
```

The Worker tests run in workerd with synthetic Google transport. Qualification administration also has isolated SQLite tests. Native tests and a release build verify local code; they do not establish installed Keychain/browser flows or physical power-loss durability.

## Deployment identity and initial installation

Apply migration 0005 before routing protocol-2 code. Preserve its triggers on every compatible rollback. The migration deliberately creates no active installation marker. A trusted installer must verify the full schema and bind `recovery_installation` to the deployment's external `RESTORE_GENERATION` before activating initial, never-restored service.

The checked-in build identity is `unqualified`. After committing clean production inputs, generate an embedded identity from the private effective deployment configuration:

```sh
node scripts/qualification/build-id.ts --config /private/operator/evidence/effective-config.json
```

Use that exact effective configuration for bundling and deployment. Production source, migrations, lockfile and configuration enter the digest; documentation and test edits do not. Record the actual bundle SHA-256, platform script ETag, deployment and version IDs, configuration and schema fingerprints in a private deployment receipt. `RECOVERY_COMPAT_VERSION=3` is an operator certification of the permit-aware writer, linked-write guards, separated cron and installation checks. A supplied digest alone is insufficient: administration checks authoritative platform state and served embedded identity.

The runtime binds `WORKER_VERSION` using Cloudflare version metadata. Every Worker response, including health and errors, carries its embedded build and serving version. Admission and settlement check the installation marker. The default configuration has an uninstalled generation; copying it into production is not installation.

All modes remain disabled until qualified. No public administration or fault-injection route exists.

## Private manifests and command-line administration

Create an owner-only directory outside repositories and attachment roots, with mode 0700. JSON inputs and outputs must be regular owner-only files, at most 64 KiB. Symlinks and unsafe writable ancestors are refused. Results publish atomically without replacing an existing file.

`contracts.ts` defines the strict v2 phase manifests. `preflight-v2.ts` defines deployment receipts and preparation commitment records. Preflight checks exact artifact hashes, deployment snapshots, authorization expiry, preparation allocation and intent budgets. Reading a deployment-exclusion artifact does not verify its claim.

```sh
node scripts/qualification/cli.ts run --manifest /private/operator/evidence/manifest-v2.json
```

The default v2 CLI currently writes a private `command-status` with `not_run` and `deployment_exclusion_unavailable`, then exits 1. Production target/exclusion verification and controller construction are still pending. Durable preparation finalization currently supports only components without mutation slots. The same boundary applies to `prepare`, `probe`, `enable` and `disable`; these commands do not currently perform administrative changes. Credentials, session URIs, SQL and mail bodies must stay off the command line.

The internal v2 driver accepts trusted verification and controller ports. It checks authorization before and after target verification, validates the returned source graph before publishing a pass, and records expiry or target drift after execution as failure. Controllers receive frozen identity and authorization values. Local tests exercise these ports with fixtures; they do not establish live deployment exclusion.

Historical v1 diagnostics are available only with this explicit synthetic form:

```sh
node scripts/qualification/run.ts --manifest /private/operator/evidence/manifest-v1.json --synthetic
```

The host journal supports read-only reconciliation after interruption. Component finalization preserves the first sample source and outcome; reopening a preparation cannot replace a failure with a success. Consumed slots never grant a second mutation.

The legacy path rejects live and administrative commands. Its reports cannot enable recovery. The old host lock used by synthetic diagnostics does not exclude independent deployments across hosts.

## Cases and current live boundary

Each v2 run selects one mode proof or one common release component. Mode evidence must later combine the corresponding mode proof with all nine required common components under the reviewed identity rules. `SourceCaseAdapter` derives verdicts from observations and exact private source artifacts; caller-supplied verdicts are rejected. Duplicate samples, identity drift and nonzero safety counters cannot pass.

The legacy synthetic registry runs selected workerd regression suites. Native-device, physical-power and deployed-resource cases remain `not_run`. The real MCP adapter and administrative modules remain programmatic building blocks; the v2 CLI does not yet connect them to live procedures. Durable mutation-journal resolution, corpus/resource verification and the complete mode-to-enable flow remain pending. No current CLI run can satisfy all live release gates.

Check deployment, configuration, grant and qualification identity before and after each live case and on each credentialed Worker response. Preserve the first failure and its observations. A retry must not erase an earlier failed or uncertain preparation.

### Release authority is unreachable by construction

`assessRelease` in `scripts/qualification/assess-release.ts` is read-only and returns a verdict rather than granting anything. Three facts about its shape, all of them structural rather than incidental:

- `implementation` is hard-coded to `not_run`, because implementation readiness is code-owned and no manifest may assert it.
- `implementation_incomplete` is always the first blocker, on every path including the invalid-manifest path.
- `release` is only ever `fail` or `not_run`. It has no `pass` branch.

`qualification` _can_ read `pass`, when both modes and all nine `CommonCases` verify. Release cannot. This is a current inability rather than an implemented and tested release-authority controller, and writing a release path is a change that must be requalified against the invariants rather than treated as filling in a blank.

A supplied digest, a green local gate or a successful request closes none of this.

The current sample counts, source requirements and stop rules are in `docs/superpowers/plans/2026-09-15-plan-6-contracts.md`. Resource qualification needs measured peak isolate memory below 128,000,000 bytes and CPU below the actual configured limit. Node RSS and an absence of runtime errors do not establish that measurement. A process kill is not a physical power-loss test.

Three feasibility decisions remain open, recorded in [Plan 6 feasibility](../superpowers/reviews/2026-09-16-plan-6-feasibility.md): the provider commit barrier, writer quiescence **together with cross-host deployment exclusion**, and peak isolate memory. The second decision covers two guarantees and refuses them separately, as `quiescence_unavailable` and `deployment_exclusion_unavailable`; naming only one of them would read as though the other were closed.

**A declared reason is not an implemented refusal.** Of the four reasons the `Reason` enum in `contracts.ts` reserves for these gates, two are emitted and two are not.

| Reason                             | Emitted where                                                  | Tested                 |
| ---------------------------------- | -------------------------------------------------------------- | ---------------------- |
| `quiescence_unavailable`           | `controllers/quiescence.ts` throws it, `restore.ts` records it | yes, four cases        |
| `deployment_exclusion_unavailable` | `cli.ts`, at two sites                                         | yes, three cases       |
| `measurement_unavailable`          | **nowhere**; also listed in `legacy-run.ts`                    | no refusal path exists |
| `provider_barrier_unavailable`     | **nowhere**                                                    | no refusal path exists |

No code measures, refuses or records anything about peak isolate memory, and no code emits a provider-barrier refusal either. Do not read either enum member as evidence that its refusal is implemented; the gauntlet recorded this for peak memory as finding G-006 and did not record the provider-barrier case, which this pass found by reading the emitters.

What holds instead for peak memory is the aggregate. `resources` is a mandatory member of `CommonCases`, `assessRelease` iterates that list rather than the supplied components, and a missing component adds a `missing_component` blocker without incrementing `verifiedComponents`, so a pass is arithmetically unreachable. The measurement is unavailable **and** its absence blocks qualification; neither fact substitutes for the other. The provider barrier has no equivalent aggregate member of its own, so what blocks it is the live-case requirement rather than a named component.

## Storage abandonment

The programmatic storage-abandonment module remains available for integration; the v2 CLI has no storage command. Its legacy storage manifest adds an exact operation ID, verified staging bucket and a `storageIntent` containing explicit handles, intent reference and expiry. Administration checks owner/account/operation linkage and published, stopped producer evidence before any R2 delete. Unknown producers refuse deletion and retain quota debt.

The transaction marks selected objects deleting under storage permits. R2 deletion occurs outside the D1 transaction; bookkeeping then removes only the selected deleting rows under fresh permits. An interruption retains cleanup debt. This operation never changes delivery truth or removes the operation/idempotency key. A late positive direct response can still settle once after the storage objects are gone.

## Restore quarantine and compatibility floor

Three things are commonly collapsed into "restore", and they have three different states.

| Layer                             | State                                   | Where                                                                                            |
| --------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Preflight and refusal             | implemented, tested, mutation-confirmed | `prepareRestore` validates the manifest, authorization, target equality and expiry, then refuses |
| The restore request itself        | **not implemented**                     | no transport exists behind `restore-cli.ts`; nothing can issue a restore POST                    |
| Uncertain-response reconciliation | **not implemented / `not_run`**         | unreachable, because there is no request whose response could be uncertain                       |

`prepareRestore` returns a `not_run` receipt carrying `quiescence_unavailable` when `QuiescenceVerifier`
refuses, which it always does. If a supported verifier is ever supplied, the next line throws
`restore_controller_unavailable` rather than proceeding, so adding a working quiescence proof cannot
silently activate an unreviewed restore implementation. `restore-cli.ts` publishes the receipt and exits 1
in every case.

The doctrine the future implementation owes, recorded now because it is a required invariant rather than a
behaviour anything currently exhibits: an uncertain restore response must never be answered by repeating
the POST. Reconcile with an authoritative read-only pass first. Today "no blind retry" holds only by
construction, because there is no request to retry, and it owes requalification the day a controller exists.

`restore.ts` re-exports that contract and keeps the v1 entry point as a refusal: `quarantineRestore` throws
`version_1_restore_retired` whatever a caller supplies, because a `drained` boolean never established writer
quiescence. No public endpoint or generic manifest command can bypass the drain proof. Prepare the exact
database/bookmark/deployment target, concrete restore authorization and an external private receipt first.

1. Route only a compatible maintenance build that refuses all mutation ingress and scheduled writes. Rotate `RESTORE_GENERATION` outside D1 and verify every routed version is frozen.
2. Establish verifiable quiescence of prior database writers. An elapsed timeout, settled promise or Gmail cancellation does not establish it. Refuse Time Travel while this proof is unavailable.
3. Export surviving operation and idempotency records privately. Persist an external receipt before restoration.
4. Restore under unchanged maintenance routing. Reapply schema/guards if the snapshot predates 0005. Install a **frozen** marker with the new generation and invalidate restored qualifications.
5. Keep mutation access quarantined. Do not roll back to a normal writer or reactivate an old generation.

**Phase A never resumes mutations after Time Travel.** A snapshot may erase sent operations and their keys. Missing restored keys cannot become new sends. Resume requires a separately reviewed incident reconciliation plan covering the entire lost interval, preserved external evidence and fresh qualification. Incomplete evidence leaves access frozen.

Only compatibility-version-3 writers are rollback candidates. Never remove the guards or route an older writer merely because its build was previously deployed. Health remains available as `ready` or `maintenance`; it never treats a missing operation as evidence of non-delivery.

## Acceptance record

Local verification, live Gmail behavior, installed clients, supported native flows, physical durability, deployed memory/CPU and rollout/restore are separate evidence surfaces. This implementation run performed no Gmail send, deployment, restore or physical-power trial. Preserve pre-release status until every mandatory live surface is verified.

For supplemental installed-SQL regression checks, run `python3 scripts/qualification/sql_conformance.py` from the repository root. It requires Python 3 and the pinned baseline Git object. It runs eighteen SQLite checks in a temporary fixture, using actual migration 0005 and immutable baseline writers; it does not replace workerd or live D1 verification.
