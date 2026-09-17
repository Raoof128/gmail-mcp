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

| Item | Value |
| --- | --- |
| Commit | `3fca933` |
| Branch | `plan5-recovery` |
| Worktree | clean |
| Node | v26.8.2 |
| npm | 11.19.1 |
| Swift | 6.4, target arm64-apple-macosx27.0.0 |
| Wrangler | 4.130.0 |
| TypeScript | 5.9.3 |
| Zod | 4.5.4 |
| vitest | 4.1.11 with `@cloudflare/vitest-plugin` 1.1.6 |
| workers-oauth-provider | 0.10.3 |
| agents | 0.22.0 |
| `@modelcontextprotocol/server` | 2.0.0 |

First-party file counts: worker/test 83, scripts 74, worker/src 73, docs 45, companion/native 18,
companion 15, root 15, shared 9, worker/migrations 6, worker other 6, .github 6. Total 350.

Excluded by class: `node_modules/`, `.git/`, `dist/`, `build/`, `coverage/`, `.build/`, `.swiftpm/`,
`.wrangler/`, `.worktrees/`, `.remember/`.

## Defects

| ID | Severity | Area | Summary | Status |
| --- | --- | --- | --- | --- |
| G-002 | INFO | shared/staging, companion | `TransferResult.state` is `string` rather than an enum, and the companion revalidates it as `z.string()` before comparing against `awaiting_approval`, `prepared` and `ready`. Comparisons are exact so nothing is exploitable, but a renamed state fails silently instead of at the type level. `TransferIntent` alongside it is a proper discriminated union. | open |
| G-001 | LOW | shared/schemas, mcp | `inline_attachments` admits 50 items of 1,400,000 base64 characters, about 70 MB, while `decodeInline` caps the aggregate at 1 MiB. The schema therefore describes input that can never validate, and `/mcp` has no body ceiling before `JSON.parse`, unlike the 64 KiB caps on web forms and the staging intent body. Authenticated only, so the caller is the owner's own client. | open |

## Coverage ledger

| Area | Files | State |
| --- | --- | --- |
| `shared/src` | 4 | reviewed: actions, errors, schemas, staging |
| `worker/src` static sweep | 73 | reviewed for section 35 signals: no `any`, no `@ts-ignore`, no TODO/FIXME, three deliberate `console.error` calls, no dynamic SQL |
| `companion/src` static sweep | 9 | same sweep, clean |
| Gates | n/a | verify 700, verify:native 18 + release build, sql_conformance 18, `git diff --check` clean |

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
