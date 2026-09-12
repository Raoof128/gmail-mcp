# Plan 4 review resolution

Updated 2026-09-12. All 18 pasted findings have a disposition in design revision 3. These are design corrections, not implemented security fixes.

| Item | Decision                                                                                                                         | Plan section |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| B1   | Use OAuth bearer plus an owner-bound ticket identifier. No ticket secret in a URL and no extra proof header.                     | 6            |
| B2   | Monotonic generations, one active generation, three-attempt cap, immutable approval deadline and replay-safe explicit retry IDs. | 6            |
| B3   | Durable snapshot/request row before remote effects, owner-bound automatic recovery and separate idempotency-key uniqueness.      | 5            |
| B4   | Native descriptor-relative publication; V1 refuses all overwrite. No claim to sandbox malicious same-user processes.             | 3            |
| B5   | One helper uses Security.framework directly; no credential-bearing CLI arguments.                                                | 3            |
| B6   | Numeric Worker and companion budgets, transactional admission and retained cleanup debt.                                         | 8            |
| M1   | Require exact issuer on discovery and callback, including missing/duplicate rejection.                                           | 4            |
| M2   | Confirmed in installed provider 0.10.3 and existing port-61234 test; preserve regression coverage.                               | 4            |
| M3   | No redirects on discovery/token/revocation/staging calls; authority and route checks.                                            | 4            |
| M4   | Completion requires active account and unchanged credential_version, covering revoke/reconnect.                                  | 6            |
| M5   | Fixed five-minute lease, four-minute transport deadline; no heartbeat or implied proof of transport termination.                 | 6            |
| M6   | Persist deterministic generation keys before bytes; verify actual digest and retain debt for late writers.                       | 6            |
| M7   | Private SQLite journal with full synchronization, file identities and explicit ambiguous-publication handling.                   | 5            |
| M8   | Seven-day owner/account-bound ACK tombstone; idempotent response distinct from physical deletion.                                | 7            |
| M9   | Download lease plus atomic cleanup claim, closing the existing select/delete race.                                               | 7            |
| M10  | Logical root IDs and permissions in tools; absolute paths only in owner configuration/CLI.                                       | 2            |
| M11  | Symmetric private-tree overlap and filesystem identity checks.                                                                   | 2            |
| M12  | NFC before hashing; exclusive filesystem operation arbitrates collision.                                                         | 2            |

The review's recommendations were retained with important refinements: ticket IDs need no separate secret; generation replay needs its own request identity; account status needs a credential epoch; deterministic R2 keys do not prevent late object recreation; GET leases alone do not fix cleanup races; native path anchoring does not sandbox the owner process.

## Verified evidence

On macOS 26.6.2, a synthetic C probe compiled with Xcode clang and linked Security.framework. With `RENAME_EXCL | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH`, it returned EEXIST for an existing destination, succeeded for a new destination, refused a symlinked parent (errno 62) and refused parent traversal (errno 107). It touched only its temporary fixture directory, which was removed. No Keychain operations were invoked. This supports selecting the primitives, not a finished helper safety claim.

Installed provider source emits `iss`, derives it from token-endpoint origin and matches loopback redirects while varying only the port. `worker/test/oauth.test.ts` already exercises an ephemeral port. The previous full repository gate passed 250 tests; that remains baseline evidence, not proof of Plan 4.

Apple explicitly cautions against secret-bearing `security -p/-w` arguments. [Apple Security source](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.c).

D1 batches roll back on statement failure; the application still must assert zero-row CAS failures. [D1 batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

R2 consistency does not turn R2 and D1 into a transaction or prevent a later stale writer. [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/).

Native flags were checked against installed headers and Apple's published source. [Apple XNU stdio header](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/stdio.h).

SQLite journal synchronization is selected as documented; hardware durability still needs validation. [SQLite pragmas](https://www.sqlite.org/pragma.html).

## Assessment

Design coverage improved from an open-ended draft to selected mechanisms and budgets. Implementation readiness still depends on writing and executing the tests: authority contract 8/10, filesystem evidence 6/10, recovery contract 7/10, implementation readiness 7/10. These are reviewer judgments, not measured security scores. The user approved inline implementation on 2026-09-12.
