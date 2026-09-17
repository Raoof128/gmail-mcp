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

## Defects

| ID    | Severity | Area                      | Summary                                                                                                                                                                                                                                                                                                                                                                             | Status |
| ----- | -------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| G-003 | LOW      | worker/src/crypto         | `canonicalize` mapped over arrays, and `map` skips a hole while `join` renders it, so a sparse array emitted `[1,,3]`, which no JSON parser accepts. Unreachable from schema-validated input because `JSON.parse` never yields a hole, but this primitive backs `payload_hash` and the intent hash. Fixed: arrays are walked by index and a hole throws.                            | fixed  |
| G-004 | INFO     | worker/src/crypto         | `frameAad` joins its three parts with NUL while `hmac.ts` length-prefixes its fields and documents why. None of `userId`, `accountId` or `field` is caller-controlled, so no boundary can be shifted today, but the codebase disagrees with itself about framing.                                                                                                                   | open   |
| G-002 | INFO     | shared/staging, companion | `TransferResult.state` is `string` rather than an enum, and the companion revalidates it as `z.string()` before comparing against `awaiting_approval`, `prepared` and `ready`. Comparisons are exact so nothing is exploitable, but a renamed state fails silently instead of at the type level. `TransferIntent` alongside it is a proper discriminated union.                     | open   |
| G-001 | LOW      | shared/schemas, mcp       | `inline_attachments` admits 50 items of 1,400,000 base64 characters, about 70 MB, while `decodeInline` caps the aggregate at 1 MiB. The schema therefore describes input that can never validate, and `/mcp` has no body ceiling before `JSON.parse`, unlike the 64 KiB caps on web forms and the staging intent body. Authenticated only, so the caller is the owner's own client. | open   |

## Coverage ledger

| Area                         | Files | State                                                                                                                             |
| ---------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| `shared/src`                 | 4     | reviewed: actions, errors, schemas, staging                                                                                       |
| `worker/src` static sweep    | 73    | reviewed for section 35 signals: no `any`, no `@ts-ignore`, no TODO/FIXME, three deliberate `console.error` calls, no dynamic SQL |
| `companion/src` static sweep | 9     | same sweep, clean                                                                                                                 |
| Gates                        | n/a   | verify 700, verify:native 18 + release build, sql_conformance 18, `git diff --check` clean                                        |

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
