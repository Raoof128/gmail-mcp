# Gmail MCP Plan 6 continuation handoff

Updated 2026-09-17. This file contains implementation history and safe continuation instructions. It contains no credentials, tokens, email contents, target secrets, or private topology.

## Repository state

- Repository: `/Users/raoof.r12/Desktop/Raouf/gmail`
- Branch: `plan5-recovery`
- Worktree at handoff: clean
- Latest commit: `310964f test(audit): scope the owner-leak assertion to the rendered table`
- Preceding security commits: `eaf55cd`, `1c97467`, `ba56f9b`, `c252ae8`

## Implemented work

Plan 6 contracts, private artifacts, v2 runner/CLI refusal paths, durable intent consumption, restart-safe component outcomes, native receipt identity checks, full captured legacy writer execution, dependent intent resolution, durable result projections, and read-only v2 platform identity checks are implemented.

The dependent-intent path resolves only declared fields from earlier slots in the same preparation. It checks the exact source hash, preparation commitment, template, tool, sample, slot, target, timestamps, and durable consumption record. It rejects literal replacement, overlapping or unsafe paths, sparse arrays, unknown projection fields, changed effective envelopes, expiry, and replay after consumption.

`verifyTargetV2` checks deployment routing, version ETag, configuration bindings, schema markers, account status and credential version, sender identity, installation generation, health headers, and authorization expiry before and after reads. It is read-only and does not assert cross-host exclusion.

## Verification evidence

- `npm run verify`: passed 765 tests (shared 11, Worker 627, companion 9, qualification 118).
- Planning contract checker: 28 passed with strict TypeScript validation.
- SQLite conformance: 18 passed.
- Legacy writer corpus regeneration check: passed; all 136 captured sites are accounted for.
- Native evidence from the preceding checkpoint: 18 tests and release build passed. Native code did not change in the latest checkpoint.
- `git diff --check`: passed.

## Open Plan 6 work

Production controllers and positive mode-to-enable wiring remain incomplete. Sacrificial-target dependent intents, mutation-bearing preparation closure, complete administration interruption handling, full upload transaction/race acceptance, resource controller, provider controller, transfer/reply/revoke controller, restore integration, and complete release assessment remain open.

Three feasibility gates remain explicitly open:

1. Provider barrier: no supported mechanism has been shown to isolate a Gmail provider commit from a Worker receipt on the exact deployed artifact without changing that artifact's identity.
2. Writer quiescence and deployment exclusion: the local lock and D1 restore behavior do not prove that delayed or cross-host old writers cannot issue later writes.
3. Peak memory: Cloudflare invocation metrics use sampled memory observations and do not establish complete peak-isolate coverage for the required maximum-payload serial and concurrent runs.

These gates must remain refusal paths. Do not replace them with operator booleans, elapsed timeouts, successful requests, Node RSS, or mocked receipts.

## Cloudflare and client setup status

The token IP restriction is resolved. That token verifies but carries no permission on either
accessible account, so a dedicated account-scoped token was minted for this work and stored in the
private qualification directory with owner-only permissions. It expires 2026-10-17. Its permissions are
account-wide for Workers, D1 and KV because Cloudflare cannot scope those to one script, so it also
reaches unrelated Workers and buckets in the same account. Narrow or revoke it once setup is finished.

A first deployment now exists. Resources were created, all five migrations were applied to the remote
database, the six secrets were set, and the Worker answers `/healthz` with `ready`. The account
identifier, database and namespace identifiers, hostname and generation are recorded only in the private
directory and in the untracked `worker/wrangler.prod.jsonc`, and are absent here by design.

The installation marker was bound by hand. The reviewed trusted installer is still one of the missing
controllers, so the schema was verified first: five migrations applied, all three protocol-2
triggers present, zero operations and zero accounts, which is the never-restored condition the design
requires for initial service. That is an operator installation, not the reviewed one, and the private
record says so. The embedded build identity remains `unqualified`.

Google OAuth is still the blocker for login. The Worker holds placeholder client credentials, and
`OWNER_GOOGLE_SUBS` is empty, which is the documented bootstrap state: the login page shows the Google
`sub` of an address in `OWNER_EMAILS` and grants no session while doing it. A real OAuth Web application
client with this deployment's two callback URIs must exist before anyone can log in.

Because registration is now closed by default, adding a Claude client has an order: log in, open the
registration window from the accounts page, then run `claude mcp add` or `codex mcp add` against the
HTTPS `/mcp` endpoint. A window is ten minutes and closes on its own.

## Security review, 2026-09-17

Four defects were found against the deployed Worker and fixed test-first. Each was reproduced before the
fix and re-attacked after it.

1. Dynamic client registration answered any unauthenticated caller, which is enough to phish the owner's
   own consent page into handing an attacker an `mcp` token.
2. Client ID Metadata Documents were accepted, which reopened the same hole without registration and made
   the authorisation server fetch a caller-chosen URL. This one was found only by re-reviewing against
   current MCP security guidance after the first fix, which is the argument for doing that pass.
3. `isInternalPath` and `redirect` allowed a tab, so `/<TAB>//evil.test` left the origin after login.
4. Unauthenticated requests grew `oauth_states` faster than the cron could drain it.

Attacks that held: the confused-deputy conditions, the remembered-consent cookie against every one of
its stated requirements, token audience separation per route, state-handle ownership and entropy, MIME
header injection, the recipient trust grammar, content-security-policy injection through the consent
page, cross-site request forgery, and session handling.

One deviation is accepted rather than fixed: both protected-resource documents advertise both scopes,
because the provider takes a single metadata object. A client that requests both is refused.

## Full-project gauntlet, 2026-09-17

A file-by-file audit, test and security pass is underway. Its live ledger is
`docs/superpowers/reviews/2026-09-17-full-project-gauntlet.md`, which carries the baseline, the standing
classification of the external gates, a tool matrix built from source, an invariant matrix with proof
types, the findings and the coverage state. Append to it; do not tidy it.

Covered so far: the baseline gates, the repository inventory of 350 first-party files, the shared
contracts, a static sweep of every worker and companion source, `crypto` and `policy` in depth, the
thirty-eight tool matrix, all twenty-one invariants mapped to a proof type, owner and account isolation,
and the operation state machine including transport-level faults.

Five findings, three fixed. The two open ones are contract-level and neither is exploitable: the inline
attachment schema describes far more input than the 1 MiB aggregate cap can ever accept and `/mcp` has no
body ceiling before parsing, and `frameAad` joins with NUL while `hmac.ts` length-prefixes.

Three results are worth carrying into any later review. No modifier combination lowers a policy level.
`+overwrite` is declared and emitted nowhere, which is what a genuinely deferred feature looks like. And
`failed_safe` is structurally unreachable unless the bytes were provably never admitted, so an ambiguous
provider outcome cannot be downgraded to "Gmail did nothing".

The grant epoch race is now closed. A recovery that binds epoch N and resumes after a reconnect or revoke
has produced N+1 stops at the token pin, the admission gate or the settlement fence, and cannot be
resumed afterwards; an ordinary access token refresh leaves it intact. Each fence was mutation-tested, and
one of them turned out to be the single point of failure in that path: removing
`a.credential_version=r.credential_version` from `recoveryFences` settles the operation against the
replacement grant. No defect, but that clause now has a named invariant.

The barrier ladder and the administration interruption matrix are done too. Six rungs from the first
mutating request to the client's reply, five administration cases arriving while a recovery holds a live
lease, and six storage-cleanup interruptions against real SQLite. Each rung carries the same evidence
tuple, and every clause believed to be enforcing something was mutation-tested rather than trusted.

Three results carry forward. `failed_safe` is enforced by an ordering, not a check: `beginSend` runs
before the byte-moving request, and moving the request ahead of it makes a transport reset claim the send
was safe. The qualification epoch clause is a single point of failure the way the credential-version
clause is. And storage cleanup deletes the object before its row on purpose, because a row without an
object is debt a retry settles while an object without a row is an orphan nothing collects.

Upload race acceptance and restore integration are done. Seven upload cases carry the R2 object, both
database sides and the caller's result; five restore cases cover the reachable half, and the live half is
recorded as `not_run` with its prerequisite rather than passed.

The ledger now has a Load-bearing predicates section: seven clauses whose removal alone produces a wrong
outcome, each established by neutralising it and watching a named test turn red. That list is the thing to
re-read before refactoring anything in recovery, staging cleanup or the restore contracts.

Remaining sections are listed at the end of the ledger.

## Safe next actions

1. Create a Google OAuth Web application client for this deployment and replace the placeholder client
   credentials, then log in once and pin the returned `sub` in `OWNER_GOOGLE_SUBS`.
2. Open a registration window from the accounts page, then point Claude and Codex at the HTTPS `/mcp`
   endpoint and complete consent.
3. Narrow or revoke the qualification token once setup is finished. It reaches unrelated Workers and
   buckets in the same account.
4. Generate a build identity only from clean production inputs and the private effective configuration,
   then write a deployment receipt and run `verifyTargetV2`. Until then the served build is
   `unqualified`, which is honest rather than a gap to paper over.
5. Keep live sends, restore, revocation, device trials and mode enablement closed until their specific
   authorization and evidence gates are present.

## Files changed in the latest implementation checkpoints

Qualification work:

- `scripts/qualification/intent-resolution.ts`
- `scripts/qualification/intent-results.ts`
- `scripts/qualification/mutation-dispatch.ts`
- `scripts/qualification/platform-v2.ts`
- `scripts/qualification/platform.ts`
- focused qualification tests for intent resolution, result sealing, dispatch, and platform identity
- Plan 6 closure and feasibility records

Security review:

- `worker/src/auth/registration.ts` and `worker/test/registration-window.test.ts`
- `worker/src/index.ts`, `worker/src/web/pages/accounts.ts`
- `worker/src/web/html.ts`, `worker/src/web/state.ts`
- `worker/test/html.test.ts`, `worker/test/state-growth.test.ts`, `worker/test/browser.ts`,
  `worker/test/oauth.test.ts`, `worker/test/audit-page.test.ts`
