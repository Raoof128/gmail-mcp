# Plan 5 inline implementation ledger

Approved: revision 3, user instruction “proceed with inline implementation”. Baseline `6e78bc548c97bbe5194e3f780c717e5519930c1a`; branch `plan5-recovery` in the main checkout. Git cannot create `main/plan5-recovery` because the existing `main` ref occupies that namespace.

Execution uses the approved design, plan and contracts, with local synthetic tests. No live Gmail recipients, deployment, database restore or physical power loss authorized. Phase B byte continuation remains excluded.

| Task                        | Status                                    | Current evidence and remaining work                                                                                                                                                                                                              |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 SQL/common state          | Implemented; acceptance expansion ongoing | Migration 0005, permit counters, linked-write guards, workerd rollback and two-winner tests. Full baseline writer replay remains to be expanded.                                                                                                 |
| 2 Pinned transport          | Implemented                               | Grant-pinned refresh, admitted bounded status/search transport, timeout through body EOF, Retry-After, request budgets.                                                                                                                          |
| 3 Session grammar           | Implemented                               | Typed send/draft endpoints, raw URL refusal before token acquisition, both 308 Range forms, typed final receipt.                                                                                                                                 |
| 4 Durable binding/failures  | Implemented                               | New send tools bind protocol 2 before bytes; admitted HTTP failures remain unknown; original body never repeats after 401.                                                                                                                       |
| 5 Evidence settlement       | Implemented; acceptance expansion ongoing | Positive-only generated search/session proof, common first winner, immutable labels on replay, direct success after metadata expiry.                                                                                                             |
| 6 Scheduler/retention       | Implemented                               | Actual-time request ledger, window deduplication, eligibility before LIMIT with account fairness, producer proof retained while staging exists.                                                                                                  |
| 7 Qualification/admin       | In progress                               | Private CLI, strict manifest/artifact schemas, host-wide deployment lock, canonical build inputs, authoritative deployment/account verification, epoch transactions and storage repair are implemented. Full operator acceptance matrix remains. |
| 8 Fault/live runner         | In progress                               | Real settlement SQL boundary rollback, one-winner audit, concurrent request budgets and run identity drift tested. Synthetic CLI and eleven-case registry implemented; complete fault matrix and live controllers remain.                        |
| 9 Restore/release artifacts | In progress                               | Installation guards, quarantine orchestrator, release runbook and documentation implemented. Concrete maintenance/restore controller and target-specific release receipt remain; live/device/resource acceptance is not-run.                     |

## Verification notes

- Initial baseline required formatting the generated review bundle and reinstalling exact lockfile dependencies with `npm ci`; no dependency upgrade.
- Core targeted suites passed, including state/binding, token/session parsing, HTTP, search, send-tool and scheduler/storage regressions. Full Worker run initially passed 303/306; three obsolete fixtures were updated for the authorized no-byte-repeat behavior and required test environment identity.
- Review reproduced and fixed malformed 2xx send receipt acceptance, grant change during resumable initialization, maintenance freeze during token refresh, scheduler starvation, and premature producer-evidence deletion. Regression tests cover each.
- Qualification file publication race reproduced with eight concurrent writers; exclusive hard-link publication now produces exactly one winner.
- Local qualification SQL runs against Node SQLite in addition to workerd core tests. It does not establish live D1/platform qualification.
- Final local verification results are recorded below; none establish live qualification.

Historical revision-3 planning manifests and source snapshots remain planning evidence. Do not rewrite them to claim implementation conformance: migration 0005 and production source changes require a new implementation evidence record.

## Current local evidence

- `npm run verify`: formatting, lint, typecheck and all workspace suites pass: 358 tests across 73 files (shared 11, Worker 313, companion 9, qualification 25).
- `npm run verify:native`: 13 XCTest tests pass and the release build succeeds. This is local native evidence, not installed-client or physical-power qualification.
- `python3 scripts/qualification/sql_conformance.py`: 18 supplemental SQLite checks pass against actual migration 0005 and the pinned baseline writer fixtures. The wrapper leaves historical planning artifacts unchanged; it does not exhaustively execute every writer inventory entry in workerd.
- The actual synthetic CLI ran the selected rollback suite, published private evidence, and correctly exited 1 because ten mandatory cases were not run. Synthetic reports cannot enable recovery.
- Added concurrent global/per-account attempt and rolling HTTP-budget checks, exact UTF-8 binding/cipher bounds and ownership refusal tests.
- Final qualification review reproduced post-write deployment drift and account alias/sender mismatches. Activation now attempts a guarded disable of exactly the epoch it wrote on post-write verification failure, reports unverified containment if that fails, and publishes a finite private failure record. Alias and sender must match the authoritative account before Worker traffic.
- No production build identity, deployed receipt, Gmail send, deployment, restore or physical-power trial was produced. The checked-in build identity remains `unqualified`.

## Remaining implementation and acceptance

Tasks 7–9 remain in progress. The registry deliberately reports missing live controllers as `not_run`; the MCP adapter is not yet wired into provider-commit-loss, installed-client, device or resource procedures. The restore orchestrator still requires a concrete trusted controller with verifiable writer quiescence. These are implementation gaps, separate from the missing authorization and live prerequisites. The complete transport fault schedule and all captured legacy-writer replay cases also remain to be expanded. Do not mark Plan 5 complete or enable production recovery from this local record.
