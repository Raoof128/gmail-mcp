# Private release verification

The project remains pre-release. Local verification and target acceptance are separate requirements. The three open feasibility decisions are recorded in [Plan 6 feasibility](../superpowers/reviews/2026-09-16-plan-6-feasibility.md).

## Supported native test host

The package requires macOS 26.6 or later and Swift tools 6.0 or later. This implementation host reports macOS 27.0, arm64 and Apple Swift 6.4. A hosted CI image has not been validated against the package's filesystem requirements. Use a supported private Mac with local APFS or HFS storage and owner-controlled fixture directories:

```sh
sw_vers -productVersion
swift --version
npm ci
npm run verify
npm run verify:native
python3 scripts/qualification/sql_conformance.py
```

Native tests create temporary fixtures. They do not perform real browser/Keychain login cycles, kill a deployed helper or power-cycle hardware. Installed clients and physical durability still require their separate authorized procedures and evidence.

The CI workflow explicitly fetches the immutable legacy baseline before running supplemental SQLite conformance, so a shallow checkout does not silently omit that gate. Those eighteen checks do not establish execution coverage of all 136 legacy writer sites. The workerd corpus remains pending.

## Artifact and target boundaries

Generate the embedded build identity only from clean production inputs and the exact private effective deployment configuration, as described in [release qualification](release-qualification.md). Preserve bundle/configuration/schema hashes, platform ETag, deployment/version and compatible rollback identity privately. A supplied SHA or a successful local build does not establish what the platform serves.

Production v2 administrative/controller bindings and cross-host deployment exclusion remain incomplete. Do not enable modes, deploy, restore or publish a release based on the local verification commands. Each target action requires its concrete authorization and the corresponding verified evidence. Phase A restore has no resume-mutations path.

## Restore preparation

Use a private v2 restore manifest containing `version`, `purpose: "restore"`, `target`, `restore` and a hash-bound `authorization` reference. The strict runtime schemas are in `scripts/qualification/controllers/restore.ts` and `contracts.ts`. The restore snapshot must match the target; both generation fields must agree; authorization must include `restore`, bind the exact target and remain unexpired.

```sh
node scripts/qualification/restore-cli.ts --manifest /absolute/private/restore-manifest.json
```

The command validates private artifacts and publishes an exclusive preparation receipt. It exits 1 with `quiescence_unavailable`; there is no restore transport behind this entry point. The retired v1 function refuses even when a caller supplies `drained: true`. A supported quiescence mechanism and the remaining restore controller must pass review before any restore request can be implemented.

## Captured legacy writers

```sh
python3 scripts/qualification/capture_writer_corpus.py --check
npm test -w @gmail-mcp/worker -- --run test/recovery-legacy-corpus.test.ts test/recovery-legacy-journal.test.ts test/recovery-legacy-cron.test.ts
```

The generator verifies 136 distinct site identities and SQL hashes against the pinned baseline. Current executable mappings cover 22 settlement, audit, journal and cron sites. Matched protocol-1 controls prove positive behavior; enrolled protocol-2 fixtures check refusal or predicate exclusion before and after a winner. Original success, failure and claimed-operation recovery batches also run against the installed migrations. Successful zero-row updates after the winner establish unchanged state, not a guard refusal. The other 114 sites still require executable mappings and transaction-context tests.
