# Full-project gauntlet

Started 2026-09-17 from `3fca933` on `plan5-recovery`. This is the live ledger for a file-by-file
audit, test, end-to-end, security and debugging pass over the whole repository. It records what was
checked, what broke, and what remains unproven. Entries are appended; nothing is rewritten to look
tidier afterwards.

## Authorization boundary

Local analysis, local implementation, local tests, fake-provider tests and local fault injection are in
scope. Real Gmail mutation, deployment, restore, credential revocation, destructive device tests and
pushing are not, and each unproven case stays `not_run` with the exact missing prerequisite. Synthetic
evidence never becomes live evidence.

Note: a deployment made earlier on 2026-09-17 already exists, and four security fixes were deployed to
it. Further deployment is out of scope for this pass unless separately authorized.

## Baseline

| Item                           | Value                                         |
| ------------------------------ | --------------------------------------------- |
| Commit                         | `3fca933`                                     |
| Branch                         | `plan5-recovery`                              |
| Worktree                       | clean                                         |
| Node                           | v26.8.2                                       |
| npm                            | 11.19.1                                       |
| Swift                          | 6.4, target arm64-apple-macosx27.0.0          |
| Wrangler                       | 4.130.0                                       |
| TypeScript                     | 5.9.3                                         |
| Zod                            | 4.5.4                                         |
| vitest                         | 4.1.11 with `@cloudflare/vitest-plugin` 1.1.6 |
| workers-oauth-provider         | 0.10.3                                        |
| agents                         | 0.22.0                                        |
| `@modelcontextprotocol/server` | 2.0.0                                         |

First-party file counts: worker/test 83, scripts 74, worker/src 73, docs 45, companion/native 18,
companion 15, root 15, shared 9, worker/migrations 6, worker other 6, .github 6. Total 350.

Excluded by class: `node_modules/`, `.git/`, `dist/`, `build/`, `coverage/`, `.build/`, `.swiftpm/`,
`.wrangler/`, `.worktrees/`, `.remember/`.

## Standing classification of the external gates

Set before the work reaches them, so a later result cannot be talked into the shape the run wants.

| Section | Requirement                     | Expected terminal state                                                               | Why                                                                                                                                                                                                                                            |
| ------- | ------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15      | Peak isolate memory             | `not_run / measurement_unavailable` unless an authoritative target profiler exists    | Workers memory is 128 MB per isolate, shared with `waitUntil`, and isolates are reused across requests. Invocation metrics are reservoir-sampled, so a successful request establishes nothing about peak.                                      |
| 29      | Restore quiescence              | `not_run / quiescence_unavailable` unless a supported proof mechanism exists          | Time Travel cancels in-flight queries; it does not establish that a delayed or cross-host old writer cannot write afterwards.                                                                                                                  |
| 30      | Deployment identity             | **test it**                                                                           | Cloudflare exposes deployment and version identity, script ETag and configuration bindings. Binding a build to what is actually served is checkable, and `verifyTargetV2` already reads those fields. Do not pre-classify this as unavailable. |
| 31      | Cross-host deployment exclusion | `not_run / deployment_exclusion_unavailable` unless exclusive control is demonstrated | A local lock does not exclude another laptop, CI runner or operator.                                                                                                                                                                           |

## Tool, action and modifier matrix

The reference oracle for sections 7, 9, 25 and the end-to-end layers. Built from source at `5ea1c6b`,
not from documentation. Thirty-one gated tools reach Gmail through `defineTool`, and seven control
tools register directly, which is the documented thirty-eight.

Default levels come from `DEFAULT_POLICY`. The effective level is the account row if one exists, else
the owner-wide row, else the default; `decide` then raises once if any modifier is present.

### Gated tools

| Tool                            | File              | Action            | Default | Static modifiers                                | Journaled |
| ------------------------------- | ----------------- | ----------------- | ------- | ----------------------------------------------- | --------- |
| `search_threads`                | read.ts           | `read.search`     | allow   | none                                            | no        |
| `get_thread`                    | read.ts           | `read.message`    | allow   | none                                            | no        |
| `get_message`                   | read.ts           | `read.message`    | allow   | none                                            | no        |
| `list_drafts`                   | read.ts           | `read.message`    | allow   | none                                            | no        |
| `get_draft`                     | read.ts           | `read.message`    | allow   | none                                            | no        |
| `list_labels`                   | read.ts           | `read.message`    | allow   | none                                            | no        |
| `download_attachment`           | read.ts           | `read.attachment` | allow   | none                                            | no        |
| `create_draft`                  | drafts.ts         | `draft.write`     | allow   | none                                            | yes       |
| `update_draft`                  | drafts.ts         | `draft.write`     | allow   | none                                            | yes       |
| `label_message`                 | labels.ts         | `label.apply`     | allow   | `+sensitive` when a target id is a system label | no        |
| `unlabel_message`               | labels.ts         | `label.apply`     | allow   | same                                            | no        |
| `label_thread`                  | labels.ts         | `label.apply`     | allow   | same                                            | no        |
| `unlabel_thread`                | labels.ts         | `label.apply`     | allow   | same                                            | no        |
| `update_message_labels`         | labels.ts         | `label.apply`     | allow   | same, over add and remove                       | no        |
| `apply_sensitive_message_label` | labels.ts         | `label.apply`     | allow   | `+sensitive` always                             | no        |
| `apply_sensitive_thread_label`  | labels.ts         | `label.apply`     | allow   | `+sensitive` always                             | no        |
| `create_label`                  | labels.ts         | `label.manage`    | ask     | none                                            | yes       |
| `update_label`                  | labels.ts         | `label.manage`    | ask     | none                                            | yes       |
| `delete_label`                  | labels.ts         | `label.manage`    | ask     | none                                            | yes       |
| `mark_message_spam`             | labels.ts factory | `spam.mark`       | ask     | none                                            | no        |
| `mark_thread_spam`              | labels.ts factory | `spam.mark`       | ask     | none                                            | no        |
| `unmark_message_spam`           | labels.ts factory | `spam.unmark`     | allow   | none                                            | no        |
| `unmark_thread_spam`            | labels.ts factory | `spam.unmark`     | allow   | none                                            | no        |
| `trash_message`                 | labels.ts factory | `trash.move`      | ask     | none                                            | no        |
| `trash_thread`                  | labels.ts factory | `trash.move`      | ask     | none                                            | no        |
| `untrash_message`               | labels.ts factory | `trash.restore`   | allow   | none                                            | no        |
| `untrash_thread`                | labels.ts factory | `trash.restore`   | allow   | none                                            | no        |
| `send_message`                  | send.ts           | `send.message`    | ask     | `+attachment` when attachments present          | yes       |
| `reply`                         | send.ts           | `send.message`    | ask     | same                                            | yes       |
| `forward`                       | send.ts           | `send.forward`    | ask     | same                                            | yes       |
| `send_draft`                    | send.ts           | `send.draft`      | ask     | none                                            | yes       |

### Control tools

| Tool                 | Annotations                   | Notes                                                      |
| -------------------- | ----------------------------- | ---------------------------------------------------------- |
| `list_accounts`      | readOnlyHint                  | `account.read`, default allow                              |
| `get_policy`         | readOnlyHint                  | `policy.read`, default allow                               |
| `list_pending`       | readOnlyHint                  | owner's pending actions                                    |
| `execute_pending`    | not readOnly, openWorld       | runs an approved action once; a second call is a replay    |
| `cancel_pending`     | not readOnly, not destructive | withdraws approval before execution                        |
| `connect_account`    | not readOnly, not destructive | `account.connect`, default ask                             |
| `open_policy_editor` | readOnlyHint                  | `policy.edit` is `browser`, so it has no tool level at all |

### Where each modifier comes from

| Modifier      | Source                 | Condition                                                                                                                                                                |
| ------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `+external`   | `policy/recipients.ts` | any recipient fails `isTrusted` against self, allowlist and org domains                                                                                                  |
| `+bulk`       | `policy/recipients.ts` | more than 10 distinct normalised recipients                                                                                                                              |
| `+attachment` | `tools/send.ts`        | the compose carries staged or inline attachments                                                                                                                         |
| `+sensitive`  | `tools/labels.ts`      | a target label id matches `/^[A-Z][A-Z0-9_]*$/`, or the tool is an `apply_sensitive_*` tool                                                                              |
| `+overwrite`  | nowhere                | declared in `MODIFIERS` and never emitted. Native publication refuses overwrite, so P4-OVERWRITE stays deferred. Verified by search across worker, shared and companion. |

### Consequences to test against

- Every `allow` row above becomes `ask` as soon as one modifier applies, so an `allow` send carrying an
  attachment still asks. There is no combination that lowers a level.
- `policy.edit` never resolves to a tool level: `effectiveLevel` throws for a `browser` action, so the
  browser requirement cannot be downgraded by writing a policy row.
- The four spam and four trash tools declare `journal: false`, which is the family where Plan 3 found
  executors that never opened the operation a claim had created. Section 12 re-tests that.

## Invariant matrix

Proof type is the strongest evidence found this pass, not the strongest that exists. `read` means I read
the implementation this pass; `located` means the test file exists and names the behaviour but I have
not yet read its assertions, which is weaker and is marked so deliberately. A `document-only` row would
be a finding; there are none yet.

One vocabulary addition: `scope-enforced`, for a guarantee that holds because Google was never asked for
the capability. It is a separate axis rather than a higher rung: it says the external authorization
surface makes a class of action unavailable even if our code goes wrong, which is defence in depth, and
it says nothing about whether our code behaves correctly. A row can need both it and a behavioural
proof.

| #   | Invariant                                                                            | Implementation                                                                                        | Proof type                                                                          | Historical source                     |
| --- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | Attachments come from the approved payload; `claimPending` takes no handles argument | `approval/claim.ts`                                                                                   | DB-enforced + unit-tested (`claim.test.ts`, read)                                   | Plan 1 review, handle-cleanup blocker |
| 2   | A pending action is claimable once                                                   | `approval/claim.ts` `_assert` batch                                                                   | DB-enforced + unit-tested (`claim.test.ts`, located)                                | Plan 1 idempotency race               |
| 3   | Idempotency binds to `(action, payload_hash)`                                        | `tools/idempotency.ts`                                                                                | unit-tested, 4 files incl. `gate.test.ts` (located)                                 | Plan 1 blocker, revision 3            |
| 4   | Modifiers only raise                                                                 | `shared/actions.ts` `raise`, `policy/engine.ts` `decide`                                              | type-enforced + unit-tested (`engine.test.ts`, read)                                | Spec 2.2                              |
| 5   | Ownership is a database constraint, not a `WHERE` you remembered                     | composite FKs; `resolveAccount`, `accountById`, `downloads.ts` JOIN                                   | DB-enforced (read)                                                                  | Plan 1                                |
| 6   | `user_id` never comes from a tool argument                                           | `auth/principal.ts` -> `props.sub`; every tool reads `principal.userId`                               | type-enforced + DB-enforced (read)                                                  | Spec 3.1                              |
| 7   | No permanent delete                                                                  | only `DELETE` is `delete_label`; scope is `gmail.modify`, and `connect.ts` refuses a grant without it | **scope-enforced** + read                                                           | Spec 3.2                              |
| 8   | Audit rows carry counts and ids, never content                                       | `audit/log.ts` renders its own summary                                                                | read; assertions in `cron.test.ts` located                                          | Plan 1                                |
| 9   | Scope and audience checked per route                                                 | `auth/principal.ts`, `auth/scopes.ts`                                                                 | read + integration-tested (`oauth.test.ts`, located)                                | Plan 2                                |
| 10  | `user_id` comes from the verified token's props                                      | `requireScope` checks `props.sub === token.userId`                                                    | read                                                                                | Plan 2                                |
| 11  | OAuth state is used once                                                             | `web/state.ts` single `UPDATE ... RETURNING`                                                          | DB-enforced (read) + tested (13 files, located)                                     | Plan 2, the KV one-use trap           |
| 12  | Remembered consent is bound to an owner                                              | `auth/approved.ts`, sub inside the signed payload                                                     | read + located (`oauth.test.ts`)                                                    | Plan 2 consent-binding blocker        |
| 13  | Credential writes are version-guarded                                                | `google/tokens.ts` `status='active' AND credential_version = ?`                                       | DB-enforced (read) + 10 files (located)                                             | Plan 2 refresh/revoke race            |
| 14  | A policy edit is one transaction                                                     | `policy/engine.ts` `applyPolicyEdit` batch                                                            | DB-enforced (read)                                                                  | Plan 2 policy-atomicity blocker       |
| 15  | Recent authentication means a fresh login                                            | `web/router.ts` `requireRecent`, `authenticatedAt` separate from `lastSeenAt`                         | read + located (3 files)                                                            | Spec 4.6                              |
| 16  | The approval page never renders a payload it does not understand                     | `approval/view.ts`                                                                                    | located (`approve.test.ts`)                                                         | Plan 2 approval-rendering blocker     |
| 17  | Executors keyed by tool name and version, both in the payload                        | `tools/define.ts`                                                                                     | located (`payload_mismatch`, 4 files)                                               | Plan 3                                |
| 18  | The intent hash covers the client's arguments and nothing the server generated       | `tools/define.ts`, `tools/idempotency.ts`                                                             | located (7 files)                                                                   | Plan 3 defect 6, replay timing        |
| 19  | Nothing writes before the decision; nothing settles outside one batch                | `tools/gate.ts`                                                                                       | read (order confirmed) + located                                                    | Plan 3                                |
| 20  | A new client identity needs an owner-opened window                                   | `auth/registration.ts`, `index.ts`                                                                    | DB-enforced + integration-tested (`registration-window.test.ts`, written this pass) | 2026-09-17 security review            |
| 21  | A redirect target is an internal path with no control characters                     | `web/html.ts` `isInternalPath`                                                                        | unit-tested (`html.test.ts`, written this pass)                                     | 2026-09-17 security review            |

### Control tool authority

Not policy-gated must not mean less authorized. Each of the seven either reads only owner-scoped rows,
or grants nothing itself and defers to a browser flow that needs a session, CSRF and recent login.

| Tool                 | Authority path                                                                                | Proof type                            |
| -------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------- |
| `list_accounts`      | `WHERE user_id = ?` bound to `principal.userId`; takes no account argument; returns no tokens | DB-enforced (read)                    |
| `get_policy`         | `resolveAccount` then `effectiveLevel`, both owner-bound; read-only                           | DB-enforced (read)                    |
| `list_pending`       | `WHERE p.user_id = ?` with the accounts join carrying `a.user_id = p.user_id`                 | DB-enforced, composite (read)         |
| `execute_pending`    | the approval already happened in the browser; the claim is once-only                          | DB-enforced + browser-enforced (read) |
| `cancel_pending`     | `cancelPending(db, { id, userId: principal.userId })`                                         | DB-enforced (read)                    |
| `connect_account`    | grants nothing; writes a `browser` decision and returns a URL that needs the owner's session  | browser-enforced (read)               |
| `open_policy_editor` | `policy.edit` is `browser`, so `effectiveLevel` throws rather than resolving a level          | type-enforced (read)                  |

## Test-harness quality rules

Not product defects. Rules this audit binds itself to, because breaking them produces a green test that
tested nothing, and the fault matrix ahead makes that far more likely.

**QA-001. An adversarial test must prove its trigger fired.** Anything that depends on a hook, barrier,
query result or enumerated row asserts that the thing happened before asserting what followed. In
practice: a non-empty result set where emptiness would pass trivially, an invocation counter on every
hook and barrier, a mutation-call counter, and the expected precondition asserted before any
before-and-after comparison.

Caught twice while writing section 7 and section 12. `expect(leased === "NO ERROR" || leased.length > 0)`
is true for every input, and a `for` loop over an empty `seen` array passes without executing a single
assertion. Both were replaced, and the second exposed a table, `download_streams`, that the snapshot was
not watching at all.

**QA-002. A surviving mutation is evidence only after the changed region has been read.** Before a null
result is recorded as "this guard is redundant", the exact source region changed must be printed, the
changed code inspected, and the intended predicate or ordering confirmed to be what was modified. A
successful string replacement is not proof that the mutation landed where it was aimed.

This exists because it happened twice in one pass. `replace(old, new, 1)` takes the first occurrence in
the file, and `!response.ok` appears both in the API helper and in the health read, while the
`"resources", "rollback"` tail appears in two separate case lists. Both times the neutralisation landed
on unrelated code and the suite passed for the wrong reason, which is worse than running no mutation at
all: it downgrades a real guard to redundant on false evidence. The line-targeted versions then failed
exactly as expected.

The one genuine redundancy finding in this audit, the `receipt.state` check in native recovery, predates
this rule but survives it: it was established by removing each guard alone and then both together, with
0, 1 and 4 failures respectively. A pattern of three only makes sense if the guards really are redundant.

## Defects

| ID    | Severity | Area                      | Summary                                                                                                                                                                                                                                                                                                                                                                             | Status |
| ----- | -------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| G-003 | LOW      | worker/src/crypto         | `canonicalize` mapped over arrays, and `map` skips a hole while `join` renders it, so a sparse array emitted `[1,,3]`, which no JSON parser accepts. Unreachable from schema-validated input because `JSON.parse` never yields a hole, but this primitive backs `payload_hash` and the intent hash. Fixed: arrays are walked by index and a hole throws.                            | fixed  |
| G-004 | INFO     | worker/src/crypto         | `frameAad` joins its three parts with NUL while `hmac.ts` length-prefixes its fields and documents why. None of `userId`, `accountId` or `field` is caller-controlled, so no boundary can be shifted today, but the codebase disagrees with itself about framing.                                                                                                                   | open   |
| G-002 | INFO     | shared/staging, companion | `TransferResult.state` is `string` rather than an enum, and the companion revalidates it as `z.string()` before comparing against `awaiting_approval`, `prepared` and `ready`. Comparisons are exact so nothing is exploitable, but a renamed state fails silently instead of at the type level. `TransferIntent` alongside it is a proper discriminated union.                     | open   |
| G-001 | LOW      | shared/schemas, mcp       | `inline_attachments` admits 50 items of 1,400,000 base64 characters, about 70 MB, while `decodeInline` caps the aggregate at 1 MiB. The schema therefore describes input that can never validate, and `/mcp` has no body ceiling before `JSON.parse`, unlike the 64 KiB caps on web forms and the staging intent body. Authenticated only, so the caller is the owner's own client. | open   |
| G-006 | INFO     | scripts/qualification     | `measurement_unavailable` is declared in two reason enums and returned by nothing, so the peak isolate memory gate is enforced by the absence of any measurement rather than by a refusal anyone can test. Nothing claims the measurement exists, so nothing is overclaimed, but a reader of the enum could reasonably think the refusal is implemented.                            | open   |

## Section 7: owner and account isolation

Fourteen adversarial cases in `worker/test/owner-isolation.test.ts`, run against real D1 in workerd.
All hold. Proof type is DB-enforced throughout: each refusal comes from the query or a constraint.

| Attack                                                                        | Result                                                          |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| owner A reads owner B's account by id                                         | `account_not_found`                                             |
| owner A reads owner B's account by alias, where both own the alias `personal` | each owner resolves to their own row                            |
| `assertAccount` with a foreign account id                                     | `account_not_found`                                             |
| default-account read for each owner                                           | never crosses owners                                            |
| revoked account through explicit alias, and through id                        | `account_needs_reconnect` on both paths                         |
| per-account policy read from the owner's other account                        | does not leak; falls back to the default                        |
| owner-wide policy read by another owner                                       | does not leak                                                   |
| account row versus owner-wide row for one action                              | account row wins, other accounts keep the owner-wide row        |
| `setPolicy` writing a per-account row for a foreign account                   | `account_not_found`                                             |
| modifier applied to an `allow` account policy                                 | raises to `ask`, base stays `allow`; nothing lowers             |
| `cancel_pending` against another owner's pending action                       | returns false, row stays `pending`, real owner can still cancel |
| trust context for one account                                                 | carries only its own allowlist                                  |
| allowlist row inserted for a foreign account                                  | FOREIGN KEY constraint                                          |
| pending action inserted for a foreign account                                 | FOREIGN KEY constraint                                          |

Still to attack in this section: owner A against owner B's operation, staging handle, attachment
download id and qualification evidence; and the stale grant epoch case, which belongs with section 27.

## Section 12: the operation state machine

Read from code. Four creators insert an operation: `approval/claim.ts` (any approved action, so the
claim can be once-only), `operations/journal.ts` twice, and `staging/transfers.ts` for
`attachment.stage_upload`. `beginOperation` is the only `claimed -> executing` writer for Gmail work and
throws when the row was not claimed.

| From                   | To                 | Writer                     | Guard                                                                |
| ---------------------- | ------------------ | -------------------------- | -------------------------------------------------------------------- |
| none                   | `claimed`          | claim, journal, transfers  | insert                                                               |
| `claimed`              | `executing`        | `beginOperation`           | one row changed, else `internal`                                     |
| `executing`            | `executed`         | `settleExecuted`           | `WHERE state='executing'` plus an `_assert` that it is now executed  |
| `claimed`, `executing` | `failed_safe`      | `settleFailedSafe`         | `_assert` it is now failed_safe; reservations released, not consumed |
| `executing`            | stays `executing`  | `settleUnknown`            | writes no operation state at all                                     |
| `executing` (stale)    | `delivery_unknown` | `cron.ts`                  | promotes only after the stale window                                 |
| `claimed` (stale)      | `failed_safe`      | `cron.ts` `recoverClaimed` | safe because claimed means nothing was sent                          |

`settleUnknown` is the row that matters for step 7: it never writes `failed_safe`, and it does not move
the operation at all, so a committed-but-unobserved send stays `executing` until the cron promotes it to
`delivery_unknown`. There is no path from an ambiguous provider outcome to `failed_safe`.

Seven tests in `worker/test/operation-state-machine.test.ts`. The step 3 assertion records every
operation row's state at the instant the fake Gmail receives a non-GET request and requires that none is
`claimed`, for a journaled send, a draft and `create_label`.

The non-journalled contract is different and is tested separately, as it should be. `journal: false`
governs the direct path only: `label_message` and `untrash_message` under an `allow` policy open no
operation. Through approval the claim does open one, the executor must call `beginOperation` on it, and
the replay is refused. Both halves are asserted.

### Faults driven through the real transport

Three cases in `worker/test/operation-faults.test.ts`, measuring what Gmail received rather than what was
attempted, and reading the terminal state from the row rather than the tool's reply.

| Case                                           | External mutations                 | Terminal                                | Notes                                                      |
| ---------------------------------------------- | ---------------------------------- | --------------------------------------- | ---------------------------------------------------------- |
| transport throws at the first mutating request | Gmail received 0, one attempt made | `delivery_unknown`, `byte_admitted = 1` | the honest answer, see below                               |
| provider commits, response lost                | 1 body, retry adds none            | `delivery_unknown`                      | idempotency key held; no executed audit                    |
| two concurrent `execute_pending`               | 1                                  | `executed`                              | one executed result, one executed audit, one operation row |

The first row is the interesting one. The fixture knows Gmail received nothing, because it owns the
fake. The Worker cannot: once the body is handed to the transport, a thrown `fetch` is indistinguishable
from a commit whose response was lost. `recovery-state.ts` makes the conservative answer structural:

```ts
const state = op.state === "claimed" && op.byte_admitted === 0 ? "failed_safe" : "delivery_unknown";
```

`failed_safe` is unreachable unless bytes were provably never admitted, so step 7's invariant is designed
in rather than tested in. Treating a transport exception as evidence of non-delivery would be the defect.

### Injectability boundary

A fault strictly before `claimed -> executing` is not reachable. The design has no production fault
selector, so the transport is the earliest injection point and `beginOperation` has already run by then.
Adding a hook to reach it would change the deployed artifact, which is the thing the design refuses. The
companion proof is in `operation-state-machine.test.ts`: at the first mutating request no row is ever
`claimed`.

Still open in section 12: the remaining barrier points from `recovery-barriers.ts` beyond headers and
provider commit, and settlement-statement level faults.

## Section 27: the grant epoch

A recovery binds one grant for its whole life. `operation_recovery.credential_version` records the epoch
it was admitted under, and every later step requires the account still to be on that same epoch. The
question this section answers is what happens when the owner moves the epoch underneath a recovery that
is already in flight, and the matching question nobody asks: whether an ordinary token refresh, which is
not a new grant, is mistaken for one.

Six cases in `worker/test/recovery-grant-epoch.test.ts`, driving the real cron path per operation:
`claimRecovery`, then `observeDelivery`, then `settleRecovered`. The reconnect is the real
`upsertAccount` and the revoke is the real `revokeAccount`, not an `UPDATE` on the version column.

| Case                                        | Epoch moves              | Where it stops                | Result                                     |
| ------------------------------------------- | ------------------------ | ----------------------------- | ------------------------------------------ |
| control, epoch left alone                   | no                       | nowhere                       | `settled`, one executed audit row          |
| reconnect between the two observation legs  | 0 to 1                   | `getAccessTokenPinned`        | `account_changed`, second leg never issued |
| reconnect after the evidence was read       | 0 to 1                   | settlement identity fence     | `fenced`, delivery was confirmed           |
| revoke after the evidence was read          | 0 to 1, status `revoked` | settlement identity fence     | `fenced`                                   |
| reconnect while the token call is in flight | 0 to 1                   | `guardedWrite` zero-row check | `account_changed`, no Gmail request        |
| ordinary access token refresh               | no                       | nowhere                       | `settled`, epoch still 0                   |

The control row is load-bearing. Every other row asserts an absence, and an absence proves nothing in a
harness that could never produce the presence. The last row is the inverse the user asked for and the one
a careless fix to the rows above would break: refreshing an access token must not advance the epoch or
invalidate the recovery. Both the account epoch and the bound epoch are read back as 0 after it.

### Which fence actually does the work

Each case was mutation-tested, because "it refused" is a weaker claim than "this specific guard refused".

| Guard removed                                                   | Consequence                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| `a.credential_version=r.credential_version` in `recoveryFences` | the reconnect case **settles** against the replacement grant |
| the `expectedVersion` refusal in `getAccessToken`               | the mid-observation case proceeds to the second leg          |
| `guardedWrite`'s zero-row check alone                           | still refused, by the trailing `checkPinned` re-read         |
| that check and `checkPinned` together                           | still refused, by the durable admission fence, as `disabled` |

Two results worth carrying forward. The refresh leg is covered three deep: the zero-row credential write
guard, the trailing re-read, and the admission fence, and no single one of them is a single point of
failure. The settlement fence is not: one clause, `a.credential_version=r.credential_version`, is the
only thing standing between a replaced grant and a recovery settling on it. Removing it does not merely
weaken a check, it produces a wrong settle. That clause deserves the same treatment as a migration.

The revoke case is protected twice over, by the epoch and by `a.status='active'`, which is why it survived
the first mutation while the reconnect case did not. A reconnect leaves the account active and moves only
the version, so it is the sharper of the two tests and the one to keep.

### Resumption is also closed

Refusing the settle is not enough on its own: a fenced recovery must not come back for another attempt
against the grant it was never admitted under. After the epoch moves, `dueRecoveries` no longer returns
the row, `claimRecovery` returns null for it, and `cleanupRecovery` moves it to `suspended` while leaving
the operation at `executing`. The operation's truth is untouched throughout; only the recovery attempt
ends.

Every case also snapshots the operation state, both audit counts, the settlement permit table and the
recovery state before the attack and requires them unchanged afterwards, so a refusal that still wrote
something adjacent would fail.

## The failure ladder, first mutating request to client reply

Section 12's remaining barrier points, run as one ladder with a single evidence tuple at every rung:
provider mutation count, requests made, body bytes admitted, operation state, `byte_admitted`,
idempotency row, total and executed audit counts, settlement permit rows, recovery row, pending row and
error, staged object reservation and consumption, and the result the client actually receives.

Six rungs in `worker/test/recovery-barrier-ladder.test.ts`. The first five run over the resumable
transport, which is the only one that streams the body and therefore the only one where "partially
admitted" is a real state rather than a hypothetical.

| Rung                 | Gmail has it | Operation state    | Client is told                        |
| -------------------- | ------------ | ------------------ | ------------------------------------- |
| headers              | no           | `delivery_unknown` | `delivery_unknown`                    |
| partial body         | no           | `delivery_unknown` | `delivery_unknown`                    |
| provider commit      | yes          | `delivery_unknown` | `delivery_unknown`                    |
| response             | yes          | `executing`        | `executed`, `local_settlement_failed` |
| settlement statement | yes          | `executing`        | `executed`, `local_settlement_failed` |
| settlement commit    | yes          | `executed`         | `executed`                            |

The first two rows are the honest ones. The fixture knows Gmail received nothing, because it owns the
fake; the Worker cannot know, so it says unknown. The fourth and fifth are the ones that would be easy to
get wrong in the other direction: Gmail has the message, so reporting a failure there would invite a
retry of a delivered send. The client is told `executed` with `local_settlement_failed`, and the cron
picks the operation up.

The settlement-statement rung is a sweep, not a single case: it splices one guaranteed failure into the
real settlement transaction at every statement boundary in turn and re-runs a fresh send for each, then
finishes with the same transaction unspliced to prove it settles exactly once. Driving it through the
gate rather than through `settleDirect` is what puts the client-observable result into the tuple;
`worker/test/recovery-faults.test.ts` covers the same boundaries from below.

### The one that matters

No rung at or after byte admission may report `failed_safe`, because `failed_safe` is a promise that
Gmail did nothing. Every rung asserts it, on the operation and on the pending row's error code, and the
pending row's state is deliberately not asserted: `failed` is a legitimate state there, and the error
code is what carries the claim.

What enforces it is not a check but an ordering. `beginSend` runs strictly before the byte-moving
request and sets `byte_admitted=1` and `state='executing'` together, so `recordFailure`'s condition,
`state='claimed' AND byte_admitted=0`, is already false by the time any of these rungs can be reached.
Measured, not argued: skipping `beginRecoverableOperation` makes the headers rung report `failed_safe`
with the bytes already streamed. Two conditions guard it and either alone suffices, so the ordering is
the thing to protect.

## Administration arriving mid-recovery

Five cases in `worker/test/recovery-administration.test.ts`, applying what the disable and
epoch-replacement arms of `changeQualification` write, while a recovery holds a live lease.

| Case                                        | Refused by                        | Recovery row after |
| ------------------------------------------- | --------------------------------- | ------------------ |
| control, no administration                  | nothing                           | `completed`        |
| operator disables the mode                  | control state, and row suspension | `suspended`        |
| control row disabled, row not yet suspended | control state alone               | `manual`           |
| qualification epoch replaced                | `c.epoch=?` alone                 | `manual`           |
| control row disabled between cron passes    | `cleanupRecovery`                 | `suspended`        |

Two results. The disable path is two deep: the control state clause and the recovery row suspension
refuse independently, which the third case proves by separating them. The epoch clause is not: removing
`c.epoch=?` from `qualificationFence` lets a lease minted under the replaced epoch carry on to its second
request. It is the same shape as the credential-version clause in section 27 and deserves the same care.

One behaviour worth naming because it is easy to describe wrongly. Replacing the epoch under a running
recovery does not merely pause it: the observation is `suspended`, so the cron parks the row at `manual`
and `dueRecoveries` stops returning it. Re-arming is an operator act. The operation's delivery truth is
untouched throughout, and once re-armed the same evidence settles under the new epoch.

## Administration interrupted partway

Six cases in `scripts/qualification/test/storage-interruption.test.ts`, against real SQLite rather than a
mock port, covering `abandonStorage` where it is most exposed: between marking a row and deleting the
object it names.

| Interruption                            | Object     | Row              | Retry     |
| --------------------------------------- | ---------- | ---------------- | --------- |
| none                                    | deleted    | deleted          | n/a       |
| before the object delete                | intact     | `deleting`       | completes |
| after the object delete                 | gone       | `deleting`, debt | completes |
| installation record replaced mid-action | first gone | `deleting`, debt | refused   |
| foreign user, account or operation      | untouched  | `retained`       | refused   |
| operation no longer `delivery_unknown`  | untouched  | `retained`       | refused   |

The ordering is the whole design. A row without its object is recoverable debt that a retry settles; an
object without its row is an orphan nothing will ever collect. Reversing the two statements breaks three
of these cases, and removing the installation assertion from the per-object batch breaks the fourth, so
both are load-bearing rather than decorative. The foreign-target rows also confirm the scope refusal
happens before any select or delete, so a mistyped manifest cannot reach another owner's storage.

## Known-good baseline

Pinned before the companion and native work begins, because that phase crosses into filesystem and
process lifecycle where a clean rollback anchor is worth more than it is in pure worker code.

| Anchor   | Value                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------- |
| Commit   | `2f92e2edb206342ab715306e31ca98129fc562cb`                                                      |
| Branch   | `main`, in sync with `origin/main`                                                              |
| Gate     | `npm run verify` exit 0, 772 tests (shared 11, worker 634, companion 9, qualification 118)      |
| CI       | run 35331147488, conclusion success                                                             |
| Native   | 18 XCTest tests and a release build, from the preceding checkpoint; native code unchanged since |
| Worktree | clean                                                                                           |

Everything below this line in the ledger was proved at or before that commit. Anything after it that
touches the companion, the native helper or the materialization slot should be compared against it.

## Standard of proof for a security-sensitive guard

Three things are required, and a case that supplies only the first two is not evidence. Prove the code
path reaches the guard. Mutate only that guard, leaving bind counts and statement structure intact.
Observe the one intended test turn red. A case that passes without reaching the clause it names is a
distinct failure from a vacuous assertion, and it is the one that hid longest here.

## Load-bearing predicates

A predicate is load-bearing when removing it alone produces a wrong outcome, as opposed to being caught by
a second guard. Every row here was established by neutralising the clause and watching a specific test
turn red, and each is the only thing standing between the system and the failure named beside it. They
are listed together because they deserve the same care as a migration: never edited casually, never
refactored without re-running the test that names them.

| Predicate                                          | Where                                           | Removing it alone                                         |
| -------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| `a.credential_version=r.credential_version`        | `recoveryFences`                                | a recovery settles against a grant the owner replaced     |
| `c.epoch=?`                                        | `qualificationFence`                            | a lease survives the epoch replacement that revoked it    |
| `beginSend` before the byte-moving request         | `operations/send.ts`                            | a transport reset reports `failed_safe` after streaming   |
| `writerStopped = !putStarted \|\| putReturned`     | `staging/upload.ts` `failUpload`                | an object with an unknown writer is deleted and released  |
| unconditional `STAGING.delete` in the debt sweep   | `staging/recovery.ts`                           | a late write survives every later sweep                   |
| object deleted before its row                      | `scripts/qualification/storage.ts`              | an orphan object nothing will ever collect                |
| `RestoreTarget` generation and database refinement | `scripts/qualification/contracts.ts`            | the restore generation becomes a second source of truth   |
| `row.identitySha256` against the run identity hash | `scripts/qualification/contracts-validation.ts` | evidence re-points at another run, manifest or start time |

Defence in depth exists elsewhere and is worth knowing about separately: the refresh leg of a recovery is
three deep, and the disable arm of administration is two deep. Those are noted in their own sections.

## Upload races across D1, R2 and the response

Seven cases in `worker/test/upload-race-matrix.test.ts`, each carrying the upload tuple: whether the R2
object exists and its size, the transfer row, every generation row with its cleanup state and
`writer_stopped` flag, the `staging_objects` rows keyed by `r2_key`, the audit count, and what the caller
received.

| Case                                          | R2 object   | Generation                     | Handle |
| --------------------------------------------- | ----------- | ------------------------------ | ------ |
| nothing races                                 | one, kept   | `completed` / `published`      | one    |
| publication transaction fails after the bytes | deleted     | `failed` / `released`          | none   |
| put entered, outcome never returned           | debt, swept | `abandoned` / `debt`, writer 0 | none   |
| a late write lands after abandonment          | swept again | `abandoned` / `debt`, writer 0 | none   |
| retry after an abandoned generation           | new key     | old stays abandoned            | one    |
| superseded ticket presented after a retry     | none        | refused as stale               | none   |
| two writers on one ticket                     | one         | one generation                 | one    |
| body longer than the declared length          | none        | `failed`                       | none   |

The invariant is that no retry can create two authoritative objects or make an abandoned object reusable,
and the second half of that is the interesting one. An abandoned generation whose put never answered keeps
`writer_stopped = 0`, so nothing is allowed to declare the writer dead. The sweep deletes the bytes on
every pass and leaves the debt charged, which means a delayed write that lands later is removed again on
the next pass, for as long as the writer might be alive.

Resurrection of the bytes is not itself the danger. A reference to resurrected bytes would be, and there
is never one: no `staging_objects` row is written for an abandoned generation, and a retry is issued its
own `r2_key`, so the authoritative object can never be the abandoned one. Both halves are asserted.

Two predicates carry this and neither has a partner. Treating an unknown put outcome as a stopped writer
deletes the object and releases the debt, after which a late write persists forever. Making the debt
sweep's delete conditional on a known-stopped writer has the same effect by a different route.

## Restore: what is reachable and what is not

Restore has no implementation, on purpose. `prepareRestore` takes a private sink and no platform port,
`QuiescenceVerifier` always refuses, and the controller behind it refuses again. Most of the restore
matrix is therefore not reachable from here, and is recorded as `not_run` rather than passing.

| Case                                            | State     | Missing prerequisite              |
| ----------------------------------------------- | --------- | --------------------------------- |
| preflight passes, no request is sent            | pass      | none                              |
| restore request sent, response lost             | `not_run` | no restore request can be issued  |
| restore succeeds, acknowledgement lost          | `not_run` | same                              |
| delayed writer resumes after restore            | `not_run` | `quiescence_unavailable`          |
| migration reapplication fails after restore     | `not_run` | no restore request can be issued  |
| verification receipt write fails after restore  | `not_run` | same                              |
| restore generation changes unexpectedly         | pass      | none                              |
| quiescence record expires between the two steps | pass      | none, via `intent_expired`        |
| routed deployment or version changes            | pass      | none, via the snapshot comparison |

The rule that an uncertain restore POST is not a retryable restore POST is not tested, because no POST
exists to be uncertain about. Recording that as a pass would be inventing evidence.

Five cases in `scripts/qualification/test/restore-identity.test.ts` cover the reachable half. The identity
condition the reviewer asked to be made explicit is already a schema refinement rather than a call-site
check: `RestoreTarget` refuses any value whose `generation` differs from `snapshot.restoreGeneration`, or
whose `databaseId` differs from the snapshot's, in either direction. The duplicate is therefore not a
second source of truth and no call site can forget to compare them, which the first case asserts both ways.

One line had no coverage at all and now has some. The controller ends with
`throw new Error("restore_controller_unavailable")`, guarding against a future working verifier silently
activating an unreviewed restore. While the real verifier always refuses, that line is unreachable, so the
guarantee was only a comment. Replacing the verifier module in the test reaches it without changing
production code, and mutating the throw into a success turns the case red.

## Download races between the stream, the acknowledgement and the lease

The download side has the same shape as the upload side, R2 bytes on one hand and D1 rows on the other,
but the failure modes are mirrored: the danger is not an orphaned object, it is a leaked slot or bytes
released while something else still has a claim on them. Seven cases in
`worker/test/download-race-matrix.test.ts`, each carrying the download tuple: whether the object exists,
the `staging_objects` row with its consumption, cleanup state, lease column and reservation, the live
`download_streams` and `download_admissions` rows, the acknowledgement row, the settlement permit count,
and what the caller received.

| Case                                          | Slot     | Consumed | Handle after        |
| --------------------------------------------- | -------- | -------- | ------------------- |
| read completes, acknowledged                  | released | yes      | closed              |
| stream dies mid-body                          | released | no       | still readable      |
| two readers, the first finishes               | one left | no       | second lease live   |
| acknowledgement lands during an open stream   | released | yes      | closed to new reads |
| reservation exists before the acknowledgement | none     | no       | reserved            |
| reservation lands after the read was admitted | released | no       | reserved            |
| foreign owner                                 | none     | no       | untouched           |

Three predicates carry these and each was isolated by mutation.

The survivor's lease is recomputed rather than cleared. `release` sets `download_lease_until` from
`MAX(lease_until)` over the streams that remain, so one reader finishing does not strip the lease from
another that is still reading. Replacing that subquery with a constant breaks only the concurrent case,
which is what makes it the right test for it.

The reservation outranks the reader. The consuming update carries
`reserved_by_operation_id IS NULL`, so an acknowledgement cannot release bytes an operation has claimed.
The simple version of this case cannot reach the predicate, because the lookup turns a reserved handle
away before the update runs; the ordering that does reach it is read first, so an admission row exists,
then reserve, then acknowledge. There the caller is told the acknowledgement was recorded, which is true
since the reader did receive the bytes, and the object stays unconsumed. Telling the reader otherwise
would be harmless; releasing the bytes would not.

The slot is returned on cancel. `finish` runs in a `finally` inside the stream's `cancel`, so a client
that vanishes mid-body gives its slot back rather than holding one of the two per-owner downloads until
the lease expires. Dropping that `finally` leaks the slot, and the mid-body case is what notices.

One invariant is asserted in every case rather than its own: the settlement permit count is zero
throughout, including while a stream is open. `storageBatch` takes a permit and clears it inside the same
transaction, so no permit ever spans R2 I/O, which is what keeps a slow reader from blocking settlement.

## Companion save, crashed at every edge of the handoff

The authority handoff runs worker intent, companion accepts, transfer, durable local receipt,
publication, acknowledgement, worker closure. Thirteen cases in
`companion/test/save-crash-matrix.test.ts` kill the companion at each edge and then resume from whatever
actually survived, which is the only way to tell a durable receipt from an in-memory one. The stand-in
for the native helper keeps what the helper keeps: whether a temporary file exists, whether a published
file exists, and the receipt.

| Crash point                         | Durable file | Receipt after | Retry redownloads |
| ----------------------------------- | ------------ | ------------- | ----------------- |
| none                                | one          | acknowledged  | n/a               |
| before the temporary file           | none         | prepared      | yes               |
| after the temporary file            | none         | prepared      | yes               |
| before the bytes were made durable  | none         | prepared      | yes               |
| after fsync, reply lost             | one          | published     | no                |
| acknowledgement transport lost      | one          | published     | no                |
| acknowledged remotely, receipt lost | one          | published     | no                |
| digest mismatch                     | none         | prepared      | n/a, refused      |
| authority 401 or 404                | none         | prepared      | n/a, refused      |

The invariant is that no retry produces two authoritative local publications and no acknowledgement
claims durability without a matching durable receipt. The first half needs care in the measurement: a
crash before the bytes land legitimately causes a second publish attempt, so the fixture counts attempts
and durable publications separately and the invariant is asserted on the second number. Counting attempts
would read a correct retry as a duplicate.

### The guard that three passing cases failed to reach

`save` ends with `if (receipt.state !== "acknowledged") throw new Error("publication_unknown")`. Removing
that throw left the entire suite green. Every case either reached `acknowledged` or returned early
through the acknowledgement catch, so none of them ever ran the line. It is reachable only when the
helper reports success while leaving the receipt short of it, and two cases now do that: an
acknowledgement the helper does not record, and a receipt state the protocol does not recognise. With
those present the mutation turns exactly those two red.

This is the failure mode the standard of proof above exists for. The suite was not vacuous, its
assertions were real, and it still proved nothing about the guard it was written around.

## The global materialization slot

`withMaterialization` allows one holder at a time across the whole deployment, which makes it both a
correctness boundary and the most obvious place to wedge the system. Six cases in
`worker/test/materialization-slot.test.ts` probe the two halves against each other.

Safety holds: a second claimant is refused while a lease is live, the same owner is refused a second
concurrent job, a live upload generation blocks materialization, and a refused reservation leaves no slot
row behind. Liveness holds too: the body runs inside a `try` whose `finally` deletes the row, so a job
that throws returns the slot immediately, and the admission predicate is `lease_until > now`, so a holder
that stalls past its lease stops excluding anyone even if its `finally` never runs.

That second mechanism is worth naming rather than presenting as free. The property is **lease-bounded
exclusivity**: at most one materializer is admitted while a valid lease exists, and exclusivity expires on
purpose to preserve liveness. Reading "global slot" as process-lifetime mutual exclusion would be wrong: a holder stalled beyond `leaseMs` no longer excludes a new claimant, so two
materializers can overlap in exactly that window. That is the price paid for not letting one dead process
wedge every later job, and the cron then deletes the abandoned row. Three mutations confirm which
mechanism does what. Removing exclusivity breaks five cases, removing the release breaks five, and
ignoring the expiry breaks only the liveness case, which is the one that names it.

## Native publication, restarted from each surviving state

Where filesystem truth, process death and receipt truth meet. The existing suite already covered the
exclusive rename, symlink and traversal refusals, root replacement, temporary replacement and a crash
after the rename. Four cases in `companion/native/Tests/NativeCoreTests/RestartTests.swift` add the
restart combinations that were missing, each one starting from a different set of survivors.

| Survivors                                 | Recovery answer       | Destination     |
| ----------------------------------------- | --------------------- | --------------- |
| temporary only, rename refused            | `prepared`, retryable | untouched       |
| published file and a matching receipt     | `published`           | kept            |
| published receipt, destination replaced   | `publication_unknown` | left as found   |
| acknowledged receipt, destination removed | `publication_unknown` | not recreated   |
| destination file with no receipt at all   | `nil`, then refused   | not overwritten |

The last row is the one that keeps recovery honest: a file at the destination proves nothing on its own.
Recovery is decided by the receipt and the verified identity behind it, never by bare existence, and the
exclusive rename is what stops the transfer from overwriting a file it cannot account for.

Producing the pre-rename failure needed no test-only hook. An occupied destination makes
`renameatx_np` with `RENAME_EXCL` refuse while the temporary file is still intact, which is exactly the
state a crash at that point would leave behind.

### What the mutations actually showed

Four mutations, and the interesting result is the one that did not fail.

| Mutation                                                          | Failures | Reading                                        |
| ----------------------------------------------------------------- | -------- | ---------------------------------------------- |
| `RENAME_EXCL` dropped from `gm_publish`                           | 2        | the no-overwrite primitive was already covered |
| receipt says `published` before the rename rather than `verified` | 1        | the ordering is load-bearing and now covered   |
| the `receipt.state == published` check in `recover` removed       | 0        | redundant, see below                           |
| the `receipt.file != nil && !discarded` check removed             | 1        | carries the property on its own                |
| both of those removed together                                    | 4        | the property is genuinely guarded, twice       |

The state check is not a single point of failure. For a published receipt the temporary file has already
been renamed away, so `discardTemporary` returns false and the second check produces
`publication_unknown` by itself. Removing either one alone leaves the property intact and removing both
breaks four cases, which is defence in depth rather than a load-bearing predicate. Recording it in the
load-bearing table would have been wrong, and only the mutation showed which it was.

The ordering is a different matter, and belongs to liveness rather than the no-overwrite safety family. The receipt is written as `verified` before the rename and only
becomes `published` after it, so a failure in between recovers as retryable. Claiming `published` early
turns that into a permanent `publication_unknown`, which loses the transfer rather than endangering it: a
liveness failure rather than a safety one, and worth keeping separate from the safety guards around it.

## Restore refusal predicates, one case apiece

The question this section answers is narrow on purpose: after an ambiguous restore, what authoritative
read-only fact says whether it happened? The answer here is that the question cannot arise, because no
restore request can be issued, and the honest half of the matrix is therefore the refusal that comes
first.

Seven cases in `scripts/qualification/test/restore-predicates.test.ts`, one per refusal predicate in
`prepareRestore`, plus a control that reaches the quiescence gate and stops there. Every predicate was
neutralised on its own, and in every instance exactly one case turned red, the one named after it.

| Predicate neutralised                                               | Case that failed                            |
| ------------------------------------------------------------------- | ------------------------------------------- |
| `canonicalize(target.snapshot) !== canonicalize(snapshotOf(...))`   | snapshot is not the target's own            |
| `auth.targetHash !== identityHash("target", ...)`                   | authorization issued for a different target |
| `target.authorizationSha256 !== identityHash("authorization", ...)` | target names a different authorization      |
| `target.authorizationExpiresAt > auth.expiresAt`                    | intent outlives the authorization           |
| `!auth.capabilities.includes("restore")`                            | authorization lacks the restore capability  |
| `recordedAt >= target.authorizationExpiresAt`                       | intent has expired                          |

Six for six, with no predicate covered only by a case that also trips a neighbour. That is the outcome
the companion work made me check for rather than assume.

### The reconciliation half is not_run, and why

There is no reconciliation implementation. Nothing consumes `RestoreTarget.bookmark`, and
`prepareRestore` exposes no platform port, so the following are recorded as `not_run` with the missing
prerequisite rather than passed.

| Case                                               | State     | Missing prerequisite                      |
| -------------------------------------------------- | --------- | ----------------------------------------- |
| POST sent, transport fails before a result         | `not_run` | no restore request can be issued          |
| restore succeeds, response lost                    | `not_run` | same                                      |
| response arrives, local receipt write fails        | `not_run` | same                                      |
| generation changes between preflight and reconcile | `not_run` | no reconciliation step exists             |
| reconciliation sees the expected bookmark          | `not_run` | nothing reads a post-restore bookmark     |
| reconciliation sees neither old nor expected state | `not_run` | same                                      |
| migration reapplication fails after a restore      | `not_run` | no restore request can be issued          |
| operator retries an uncertain restore command      | `not_run` | there is no uncertain state to retry from |

The rule that an uncertain restore must not produce a blind second POST is currently enforced by
construction rather than by a check: there is no POST. That is a stronger guarantee than a guard while it
lasts, and a weaker one the moment a controller appears, so it should be re-tested as a rule the day one
does.

## The three feasibility gates

Each stays open. What can pass is the refusal, and for two of the three it now does.

| Gate                 | Refusal path                       | Tested                |
| -------------------- | ---------------------------------- | --------------------- |
| writer quiescence    | `quiescence_unavailable`           | yes, four cases       |
| cross-host exclusion | `deployment_exclusion_unavailable` | yes, three cases, new |
| peak isolate memory  | none exists                        | no, and see below     |

Three cases in `scripts/qualification/test/exclusion-refusal.test.ts` cover the exclusion gate, which was
emitted at two sites in `cli.ts` and tested at neither: no mechanism at all, and a mechanism whose check
fails. Both write a `not_run` record and neither reaches dispatch, the private failure text never reaches
the record, and `CommandStatus` pins `result` to the literal `not_run` so a passing verdict cannot be
written there by mistake. Both sites were mutation-confirmed.

### Finding: the peak memory gate has no refusal path

`measurement_unavailable` appears in two reason enums and is returned by nothing. The gate is therefore
open not because a refusal path reports it, but because no code measures, refuses or records anything
about peak isolate memory at all. That is the same shape as `+overwrite` in section 7: declared and
emitted nowhere. It is recorded here because a reviewer reading the enum could reasonably conclude the
refusal is implemented, and it is not. Severity INFO: nothing claims the measurement exists, so nothing
is overclaimed, but the gate is enforced by absence rather than by a refusal anyone can test.

## Deployment identity: the code actually receiving the traffic

Nine cases in `scripts/qualification/test/deployment-identity.test.ts`, walking the chain from a local
production input through `BUILD_ID`, the deployed version, the routing and receipt, to the qualification
target. The invariant is that qualification evidence must describe the code serving now, not a deployment
object that once existed, so the decisive checks are the ones the running Worker answers for itself.

Six authoritative comparisons, each neutralised on its own, each turning exactly the case named after it
red.

| Comparison neutralised                                    | Case that failed                              |
| --------------------------------------------------------- | --------------------------------------------- |
| served `x-recovery-build` against `workerBuildId`         | serving Worker reports a different build      |
| served `x-recovery-version` against `deploymentVersionId` | serving Worker reports a different version    |
| `active.id` against the target's deployment               | deployment object is no longer the active one |
| `active.versions[0].version_id` against the target        | active deployment routes a different version  |
| `version.resources.script.etag` against the receipt       | stale receipt whose etag no longer matches    |
| `!response.ok` on the health read                         | unhealthy Worker with matching identifiers    |

The first two are the ones that carry the invariant. Every platform-side identifier can line up while the
code answering `/healthz` is something else, and those two headers are the only place the running Worker
speaks for itself. Two further cases cover a changed configuration binding and a missing protocol-2
schema marker, both refused through the fingerprint and digest comparisons rather than by inspection.

### A process correction worth more than the cases

Two mutations in this pass reported a clean survival that was not one. `replace(old, new, 1)` takes the
first occurrence in the file, and `!response.ok` exists in both the API helper and the health read, while
the `"resources", "rollback"` tail appears in two separate case lists. Both times the neutralisation
landed on unrelated code and the suite passed for the wrong reason. The corrected, line-targeted mutations
then failed exactly as expected. A null mutation result is only evidence once the mutated region has been
printed and read.

## The resource gate cannot vanish from the aggregate

Finding G-006 says the peak memory gate has no refusal path of its own. What has to hold instead is one
step further out: the absence of resource evidence must not be able to disappear from the release
aggregate. It cannot, and four cases in
`scripts/qualification/test/resource-gate-aggregation.test.ts` now hold that shut.

`resources` is a member of `CommonCases`, `assessRelease` iterates that list rather than the supplied
components, and a case with no component adds a `missing_component` blocker without incrementing
`verifiedComponents`. Qualification reads `pass` only when `verifiedComponents === CommonCases.length`
and both modes verified, so a missing resource record makes a pass arithmetically unreachable.

The decisive case supplies every other component and nothing else, and asserts the missing list is
exactly `["missing_component:resources"]`, so the refusal is attributable to that one gap rather than to a
partial aggregate. Two mutations confirm it: treating a missing component as verified, and dropping
`resources` from `CommonCases`, each turn the relevant cases red.

Two structural facts alongside it. `release` is never reported as passing at all, only `fail` or
`not_run`, and `implementation` is fixed at `not_run` with `implementation_incomplete` always among the
blockers. Release authority is therefore unreachable by construction today, which is the same shape as the
restore situation and should be re-tested as a rule if either ever becomes reachable.

G-006 stays INFO on that basis: the vocabulary exists, nothing emits it, and nothing downstream can
mistake its absence for satisfaction.

## Qualification evidence isolation and graph integrity

Twenty-four cases in `scripts/qualification/test/evidence-isolation.test.ts`. The identity half changes
the run identity in the report **and** in the expectation together, so `assertEqual(report.identity,
identity)` is satisfied and only a deeper binding can refuse. Moving one side alone would prove nothing
beyond that the equality check exists.

Twelve axes, all refused: owner, account, grant epoch, deployment, deployed version, build, origin,
profile, schema digest, run id, manifest digest and start time. Alongside them, a report whose identity
disagrees with the expectation, a component claiming a case its preparation did not allocate, and a
report that did not pass.

The graph half corrupts one edge at a time: a reference whose digest does not match the stored bytes,
observation bytes changed after they were referenced, a duplicated sample in place of a distinct one, a
swapped authorization, a preparation root that does not hash its own preparation, an attempt count that
disagrees with the allocations, a version-1 shaped artifact handed to the v2 verifier, and a source whose
recorded observation digest was recomputed over different bytes. Every one is refused.

### Which binding carries which axis

| Binding removed                                        | Axes no longer refused                  |
| ------------------------------------------------------ | --------------------------------------- |
| `row.identitySha256 !== identityHash("run", identity)` | run id, manifest digest, start time     |
| `assertEqual(prep.target, identity.target)`            | none                                    |
| `assertEqual(report.identity, identity)`               | report disagreeing with the expectation |

The observation identity binding is the load-bearing one and joins the table above. Every observation
carries a hash of the whole run identity, so the nine target axes are refused twice, by that hash and by
the preparation target equality, while the three non-target axes have only the hash. Remove it and a
component's evidence can be re-pointed at a different run, a different manifest or a different start time
while still verifying.

The preparation target equality is redundant: removing it alone changes nothing, because the target is
inside the identity the observations already hash. That is worth recording rather than quietly listing it
as a guard, and it is the second such case this audit has found.

### A case that named a guard it did not reach

The failing-report case first asserted `case_failed` while flipping `result` alone. `CaseReport` refines
that a non-passing report must carry a limitation, so a bare flip is refused by the schema and the
verifier's own check is never reached. Supplying the limitation makes the case test what it claims. Same
shape as the companion acknowledgement guard, caught this time because the assertion named the reason
rather than accepting any rejection.

### Sacrificial account, as a distinction rather than a weakening

The reply and revoke component needs a sacrificial grant, and the graph keeps the two separate rather
than loosening mode identity to accommodate it. The mode's `RunIdentity.target` stays the qualification
target and is hashed into every observation, while the authorization is what carries the capability set
for that component, checked per case against `capabilities[report.caseId]`. A component may therefore hold
`send` and `revoke` without any part of the mode identity moving, which is the property to preserve if a
sacrificial account is ever wired in.

## Coverage ledger

| Area                         | Files | State                                                                                                                             |
| ---------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| `shared/src`                 | 4     | reviewed: actions, errors, schemas, staging                                                                                       |
| `worker/src` static sweep    | 73    | reviewed for section 35 signals: no `any`, no `@ts-ignore`, no TODO/FIXME, three deliberate `console.error` calls, no dynamic SQL |
| `companion/src` static sweep | 9     | same sweep, clean                                                                                                                 |
| Grant epoch (section 27)     | 3     | `google/tokens.ts`, `operations/recovery-admission.ts`, `operations/reconcile.ts`: six cases, each fence mutation-tested          |
| Failure ladder (section 12)  | 3     | `operations/send.ts`, `tools/gate.ts`, `tools/settle.ts`: six rungs, one evidence tuple, ordering mutation-tested                 |
| Administration (mid-flight)  | 2     | `operations/recovery-admission.ts`, `operations/recovery-cron.ts`: five cases, each clause isolated                               |
| Administration (interrupted) | 2     | `scripts/qualification/storage.ts`, `admin.ts`: six cases against real SQLite                                                     |
| Upload races                 | 3     | `staging/upload.ts`, `staging/recovery.ts`, `staging/transfers.ts`: seven cases, two load-bearing predicates                      |
| Restore identity             | 3     | `scripts/qualification/contracts.ts`, `controllers/restore.ts`: five reachable cases, six recorded not_run                        |
| Download races               | 3     | `staging/downloads.ts`, `staging/settlement.ts`, `staging/store.ts`: seven cases, three isolated predicates                       |
| Companion save crashes       | 2     | `companion/src/transfers.ts`, `http.ts`: thirteen cases, the receipt guard reached at last                                        |
| Materialization slot         | 2     | `staging/materialization.ts`, `staging/recovery.ts`: six cases, safety and liveness separated                                     |
| Native restarts              | 3     | `native/SaveReceipts.swift`, `SafeFiles.swift`, `CNative.c`: four restart cases, ordering proved, one guard shown redundant       |
| Restore predicates           | 2     | `controllers/restore.ts`, `contracts.ts`: six predicates, each neutralised alone, one case red apiece                             |
| Exclusion refusal            | 1     | `cli.ts`: both emission sites, previously untested                                                                                |
| Deployment identity          | 2     | `platform.ts`, `platform-v2.ts`: nine cases, six authoritative comparisons mapped one to one                                      |
| Resource gate aggregation    | 2     | `assess-release.ts`, `contracts.ts`: the missing measurement cannot leave the aggregate                                           |
| Evidence isolation and graph | 2     | `contracts-validation.ts`, `contracts.ts`: twelve identity axes and eight graph corruptions                                       |
| Gates                        | n/a   | verify 838, verify:native 22 + release build, sql_conformance 18, `git diff --check` clean                                        |

## Checked and held

- `raise()` only ever moves `allow` to `ask`; `ask` and `deny` are returned unchanged.
- `decodeInline` caps the aggregate at 1 MiB and projects each item's decoded size from its string
  length before decoding, so fifty items just under the per-item cap cannot combine past the cap.
- `TransferIntent` is a discriminated union, every member is a `strictObject`, and only `retry` carries
  `expected_generation` and `retry_request_id`.
- The canonical filename refinement rejects non-NFC input, `.`, `..`, both separators, and every
  `\p{Cc}` and `\p{Cf}` code point.
- `senderFor` resolves an explicit `from` against the account address and its verified send-as list.
- Every `_assert` condition is a literal fragment with bound values, and the one interpolated column
  list is a module constant.
