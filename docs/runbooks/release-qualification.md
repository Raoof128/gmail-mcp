# Recovery qualification and rollback

Release remains **pre-release**. Plan 5 implements status-only recovery for new generated-message sends. It never resumes MIME bytes. Existing protocol-1 operations and ambiguous draft sends require manual review. A missing search result or expired session does not establish that mail was not sent.

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

`manifest.ts` defines the complete strict input schema. A manifest names the exact origin, Worker, platform account, D1 database, owner/account/grant version, profile, mode, embedded build, deployment/version, external restore generation, expected qualification epoch, selected cases, receipt and result paths. Probe mode requires a scratch deployment and at most twenty explicit operation IDs. Account alias and authorized sender must match the authoritative D1 account before Worker traffic. Sender/recipient authorization includes an expiry and exact capabilities; it is not inferred from a plan document.

```sh
node scripts/qualification/admin.ts probe --manifest /private/operator/evidence/manifest.json
node scripts/qualification/admin.ts disable --manifest /private/operator/evidence/manifest.json
node scripts/qualification/run.ts --manifest /private/operator/evidence/manifest.json --synthetic
node scripts/qualification/admin.ts enable --manifest /private/operator/evidence/manifest.json
node scripts/qualification/admin.ts abandon-storage --manifest /private/operator/evidence/storage.json
```

Platform credentials come from `CLOUDFLARE_API_TOKEN` only after local preflight. Do not put credentials, session URIs, SQL or mail bodies on the command line. The optional real MCP fixture adapter acquires a Worker credential through its injected private credential provider; it does not retry mutation requests.

All administration uses one host-wide deployment lock keyed by platform account and Worker name. Keep exclusive operator control over deployment on every host for the entire run and enable sequence. An independent Wrangler rollout does not participate automatically: operators must use the same lock wrapper or suspend other deployment mechanisms. A stale lock requires investigation; never remove it solely because a timer expired.

Every control edit generates a fresh 256-bit epoch and a seven-day expiry. A stale expected epoch refuses the transaction. Enable requires one complete live run, matching artifact hashes and mandatory sample metrics under one frozen identity. It records the run hash and a private receipt containing the parent run/epoch. Synthetic evidence cannot enable a live mode.

## Cases and current live boundary

The executable registry includes generated identity, session status, draft negative, byte round trip, media boundary, reply/revoke, installed clients, native, physical durability, resource measurements and rollback. Synthetic mode invokes the selected workerd regression suites. Native-device, physical-power and deployed-resource cases remain `not_run` in synthetic mode.

Live fixture controllers are explicit ports. The current command-line registry does not attach recipient-bearing fault controllers or installed client/device controllers; it records `missing_authorization` or `missing_adapter` instead of executing an approximation. The real MCP adapter validates every credentialed response's serving identity and constrains fixture sends to the authorized sender/recipient. Connecting it to the full provider-commit-loss and device procedures remains required before live qualification. No current CLI run can satisfy all live release gates.

Freeze the run identity before the first live case. Check deployment, configuration, grant and qualification identity before and after each case and check each credentialed Worker response. Drift or a safety failure stops subsequent cases. Do not retry a failed live case until it passes. Preserve its first failure record. Missing selected or mandatory cases produce a nonzero exit.

The normative sample counts and stop rules are in `docs/superpowers/plans/2026-09-13-plan-5-contracts.md`. Resource qualification needs measured peak isolate memory below 128,000,000 bytes and CPU below the actual configured limit. Node RSS and an absence of runtime errors do not establish that measurement. A process kill is not a physical power-loss test.

## Storage abandonment

A storage manifest adds an exact operation ID, verified staging bucket and a `storageIntent` containing explicit handles, intent reference and expiry. Administration checks owner/account/operation linkage and published, stopped producer evidence before any R2 delete. Unknown producers refuse deletion and retain quota debt.

The transaction marks selected objects deleting under storage permits. R2 deletion occurs outside the D1 transaction; bookkeeping then removes only the selected deleting rows under fresh permits. An interruption retains cleanup debt. This operation never changes delivery truth or removes the operation/idempotency key. A late positive direct response can still settle once after the storage objects are gone.

## Restore quarantine and compatibility floor

`restore.ts` implements the quarantine orchestration contract through a trusted maintenance/deployment controller. No public endpoint or generic manifest command can bypass its drain proof. Prepare the exact database/bookmark/deployment target, concrete restore authorization and an external private receipt first.

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
