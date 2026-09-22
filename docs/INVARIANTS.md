# Security invariants

The current set, thirty-six of them. Each one has a test, and each was read back against source at
`15a2381` for this index rather than carried forward from a plan.

This file is the canonical list. It says what holds and where the code that holds it lives. Two other
documents cover what this one does not:
[the design spec](superpowers/specs/2026-09-09-gmail-mcp-design.md) holds the reasoning and the fact each
decision rests on, and
[the full-project gauntlet](superpowers/reviews/2026-09-17-full-project-gauntlet.md) holds the proof type
behind each invariant as of 2026-09-18, the load-bearing predicate table and the findings. The gauntlet's
own matrix covers twenty-one of these, which is what existed when it was written; it is a dated record and
is not edited to keep up.

A change near any invariant must leave its test demonstrating it, or amend the invariant deliberately and
say why in the commit message.

## How to read a proof type

These are not interchangeable, and collapsing them into "tested" is how a guarantee gets overstated.

| Term                  | What it means                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| DB-enforced           | a constraint, composite key or transactional assertion refuses the write                            |
| Type-enforced         | the type system makes the wrong call unwriteable                                                    |
| Scope-enforced        | Google was never asked for the capability, so it is unavailable even if this code is wrong          |
| Unit-tested           | a test proves it directly                                                                           |
| Integration-tested    | a test proves it through the real runtime against emulated storage or a synthetic provider          |
| Mutation-confirmed    | neutralising the named predicate turns a specific named test red, and the changed region was read   |
| Holds by construction | true because the code that could break it does not exist yet, and owes requalification when it does |

`scope-enforced` is a separate axis rather than a higher rung. It says an external authorization surface
makes a class of action unavailable; it says nothing about whether this code behaves correctly. Some rows
need both it and a behavioural proof.

## Approval and the claim

1. **Attachments come from the approved payload.** `claimPending` in `worker/src/approval/claim.ts` takes
   no handles argument. It reads them out of `payload_json`, so a caller cannot influence which files an
   approved operation reserves. DB-enforced and unit-tested.

2. **A pending action is claimable once.** Two concurrent claims yield one success and one operation row.
   D1 batches roll back on a statement error but not on a zero-row `UPDATE`, so the claim asserts the row
   is still `approved` by inserting into `_assert`, which carries `CHECK (x = 0)`. DB-enforced.

3. **Idempotency keys bind to `(action, payload_hash)`.** Reuse with different content is
   `idempotency_conflict` in `worker/src/tools/idempotency.ts`, never a quiet replay of the old result.
   Acquisition is `INSERT OR IGNORE` then a read, so the unique index arbitrates rather than a
   check-then-insert race.

4. **Modifiers only raise.** `raise` in `shared/src/actions.ts` returns `ask` for `allow` and everything
   else unchanged, and `decide` in `worker/src/policy/engine.ts` applies it once. Nothing moves a level the
   other way. Type-enforced and unit-tested.

5. **The approval page never renders a payload it does not understand.** `approvalView` in
   `worker/src/approval/view.ts` returns a typed view per action family and `raw` otherwise, and the page
   prints the whole payload for `raw`.

6. **Executors are keyed by tool name and version, and both live in the payload.** A pending row executes
   from `payload.tool` under `payload.v`. A tool not registered through `defineTool` cannot be approved,
   and a version that has moved on is a `payload_mismatch`.

## Identity and ownership

5. **Ownership is a database constraint.** Child tables carry `(user_id, account_id)` referencing
   `accounts(user_id, id)`, and references to operations carry the whole
   `(user_id, account_id, operation_id)` triple. Lookups put ownership in the query rather than checking
   after the fetch. DB-enforced in `worker/migrations/0001_init.sql`.

6. **`user_id` never comes from a tool argument.** It comes from the verified principal in
   `worker/src/auth/principal.ts`, and every tool reads `principal.userId`.

7. **No permanent delete.** No tool exposes one. The only `DELETE` against Gmail is `delete_label`, and the
   requested scope is `gmail.modify`; `worker/src/google/connect.ts` refuses a grant that does not carry
   it, and `https://mail.google.com/` is never requested. Scope-enforced.

8. **Scope and audience are checked per route.** An `mcp` token is refused at `/staging` and a `staging`
   token at `/mcp`. The OAuth library checks signature, expiry and audience; `requireScope` in
   `worker/src/auth/principal.ts` checks the scope against the route and that the token's props belong to
   the token's own owner.

9. **`user_id` comes from the verified token's props.** Never from a query string, a form field or a tool
   argument, on any route including the browser pages.

10. **OAuth state is used once.** `oauth_states` lives in D1 and is consumed by a single
    `UPDATE ... RETURNING` in `worker/src/web/state.ts`. Two callbacks carrying one state yield one
    session; two consent decisions on one request yield one grant. Workers KV cannot express this: it is
    eventually consistent, so `get` then `delete` races inside a colo as well as across them.

11. **Remembered consent is bound to an owner.** The `__Host-approved` cookie names the Google `sub` it was
    signed for, and login clears it when the owner changes.

12. **Recent authentication means a fresh login.** Policy edits, account revocation, allowlist and
    organisation-domain changes, raising a send limit and companion registration all require
    `authenticated_at` within fifteen minutes. `requireRecent` in `worker/src/web/router.ts` reads that
    column; `last_seen_at` never counts.

13. **A new client identity needs an owner-opened window.** Dynamic registration is closed by default and
    the owner opens ten minutes of it from the accounts page, behind CSRF and a recent login. The window is
    a database row, so nothing a registration request carries can open it. Client ID Metadata Documents
    stay off (`clientIdMetadataDocumentEnabled: false` in `worker/src/index.ts`): a CIMD client identifies
    by URL and never registers, so accepting them is the same door with no lock.

14. **A redirect target is an internal path with no control characters.** `isInternalPath` in
    `worker/src/web/html.ts` is the one definition and `redirect` calls it. A URL parser strips tab, CR and
    LF before resolving a reference, so `"/\t//evil.test"` satisfies any rule that only inspects the
    character after the leading slash; the check matches the whole control range.

## Credentials and the grant epoch

13. **Credential writes are version-guarded.** Every write that stores or refreshes a Google token carries
    `status = 'active' AND credential_version = <read>` and must change exactly one row. Revocation is
    local-first and bumps the version, so a refresh in flight cannot resurrect a revoked account.
    DB-enforced in `worker/src/google/tokens.ts`.

14. **A policy edit is one transaction.** The rows, the `policy.edit` audit row and the revocation of the
    owner's other sessions land together or not at all. The same holds for an approval decision and its
    audit row.

15. **A recovery settles only under the grant it was admitted under.** `operation_recovery` records the
    `credential_version` it bound, and `recoveryFences` in
    `worker/src/operations/recovery-admission.ts` requires the account still to match it
    (`a.credential_version = r.credential_version`). A reconnect or revoke mid-recovery stops it at the
    token pin, the admission gate or the settlement fence depending on how far it had got, and
    `dueRecoveries`, `claimRecovery` and `cleanupRecovery` then refuse to resume it. **An ordinary access
    token refresh is not a new grant** and must leave all of this alone. Mutation-confirmed: removing that
    one clause lets a reconnect mid-recovery settle against the replacement grant, and it is the only
    guard in that path that does.

16. **A lease names the qualification epoch it was admitted under.** `qualificationFence` re-reads
    `recovery_control` on every request and binds `c.epoch`, so disabling the mode or replacing the epoch
    stops a recovery already in flight, not just the next one. Replacing the epoch parks the row at
    `manual`, which no cron pass picks up; re-arming it is an operator act.

### Which layer refuses first

The refusal reasons are not interchangeable, and which one arrives tells you which layer turned the
request away.

| Layer             | Where                                     | Reason it produces                         |
| ----------------- | ----------------------------------------- | ------------------------------------------ |
| token pin         | `getAccessTokenPinned`, called first      | `suspended` with `account_changed`         |
| durable admission | `admitRequest`, reached inside `fetchOne` | `suspended` with `disabled`, or `deferred` |
| settlement fence  | `recoveryFences`                          | the settlement does not land               |

For a Gmail request the token pin fires before the durable admission gate, so a grant epoch that moved
mid-recovery surfaces as `account_changed` rather than `disabled`. Predicting the admission reason there
is wrong.

## The gate and the operation journal

8. **Audit rows carry counts and ids, never content.** `worker/src/audit/log.ts` renders its own summary
   from structured facts, so a caller cannot pass a subject line or a message body through it. The journal,
   not the audit log, is authoritative for delivery.

9. **The intent hash covers the client's arguments and nothing the server generated.** Inline bytes appear
   as digests and staging handles never appear, so an idempotent replay, an elicitation resume and a
   duplicate all hash alike.

10. **Nothing writes before the decision and nothing settles outside one batch.** A tool's `build` runs
    only after policy said `allow` or `ask`; the operation, its reservations, the pending row and the
    outcome audit row change together.

11. **`journal: false` governs the direct path only.** `ToolSpec.journal` decides whether the gate opens an
    operation when a tool runs straight through. An approval always opens one, because `claimPending` needs
    it to make the claim once-only, so a non-journalling tool reached through `execute_pending` does have
    an operation and its executor must call `beginOperation` on it. **`JOURNALED_ACTIONS` in
    `shared/src/actions.ts` is documentation and nothing reads it**; the comment above it says so. It is
    not authoritative for whether an operation exists.

## Ambiguous delivery

The rule these three encode: **absence of positive evidence is not proof of non-delivery.** A `fetch` that
threw, a timeout, a lost response and a vanished session are all indistinguishable from a commit whose
answer never arrived.

21. **`failed_safe` means the bytes were provably never admitted.** `recordFailure` in
    `worker/src/operations/recovery-state.ts` picks it only for `state = 'claimed'` with
    `byte_admitted = 0`; everything else ambiguous is `delivery_unknown`, which is never retried on its
    own. Never widen this.

22. **`failed_safe` is enforced by an ordering, not by a check.** `beginSend` runs strictly before the
    byte-moving request and sets `byte_admitted = 1` and `state = 'executing'` together, so
    `recordFailure`'s `state = 'claimed' AND byte_admitted = 0` is already false at every failure point
    downstream. Move the byte-moving request ahead of `beginSend` and a transport failure reports
    `failed_safe` with the bytes already streamed. Mutation-confirmed by reordering the two.

23. **No mutating Gmail transport may be entered before the operation has atomically left `claimed` and
    recorded `byte_admitted = 1`.** This is invariant 25 stated as a rule about the transport rather than
    about `failed_safe`. `beginSend` is the only place that transition happens, and every byte-moving call
    site sits after it. Measured consequence of breaking it: a connection reset before the first body byte
    reports `failed_safe` while the bytes were already handed to the transport.

### Recovery never resumes MIME

Worth stating separately, because the mechanism is stronger than the flag an older plan described.
`allowed()` in `worker/src/google/recovery-http.ts` refuses any recovery request to Gmail whose
`init.body` is not null, at both the session-status and the search branches. Recovery therefore _cannot_
send MIME rather than recording that it did not. The one exception is the token refresh, which must be a
`POST` to Google's exact token URL with a `URLSearchParams` body at most 16 KiB.

There is no `phase_b_verified` field anywhere in this codebase. If you find the name, it is in a dated
plan describing an intent that was never implemented that way.

## Staging, uploads and downloads

27. **Storage cleanup deletes the object before its row, never the reverse.** A row without its object is
    recoverable debt that a retry settles; an object without its row is an orphan nothing will collect.
    `purgeExpired` in `worker/src/staging/store.ts` claims the row, deletes from R2, then deletes the row,
    and each per-object batch is fenced by the installation record so a restore landing mid-cleanup stops
    it.

28. **An unknown writer is never declared stopped.** `failUpload` sets `writer_stopped = 1` only when the
    put never started or provably returned. A rejected put has an unknown remote outcome, so its debt stays
    charged, the sweep deletes the object on every pass, and a delayed write that lands later is removed
    again. Neither a timer nor an absent object proves a writer has stopped.

29. **An abandoned object can never become the authoritative one.** No `staging_objects` row is written for
    an abandoned generation, and a retry is issued its own `r2_key`. Resurrected bytes are harmless because
    nothing can reference them; a reference to them would not be.

30. **A reservation outranks a reader.** `acknowledgeDownload`'s consuming update carries
    `reserved_by_operation_id IS NULL`, so an acknowledgement records that the reader got the bytes but
    cannot release an object an operation has claimed. Reaching that predicate needs the read to be
    admitted first, because a reserved handle is otherwise turned away by the lookup before the update.
    Only read, then reserve, then acknowledge exercises it.

31. **Releasing a download lease recomputes it from the streams that remain.**
    `download_lease_until` is set from `MAX(lease_until)` over the surviving `download_streams` rows, never
    cleared outright, so one reader finishing does not strip the lease from another still reading. The slot
    itself is returned in a `finally` inside the stream's `cancel`, so a client that vanishes mid-body does
    not hold one of the two per-owner downloads until expiry.

32. **Materialization exclusivity is lease-bounded, not process-lifetime.** Admission in
    `worker/src/staging/materialization.ts` asserts that no row has `lease_until > now`, so at most one
    materializer is admitted while a valid lease exists, and a holder stalled past `leaseMs` stops
    excluding anyone even if its `finally` never ran. **Two materializers can overlap in exactly that
    window.** That is the deliberate price of not letting one dead process wedge every later job, and the
    cron deletes the abandoned row. It is not absolute mutual exclusion and must not be described as one.

## Companion and native publication

33. **No acknowledgement claims durability without a matching durable receipt.** `save` in
    `companion/src/transfers.ts` ends with `if (receipt.state !== "acknowledged") throw`, so a helper that
    reports success while leaving the receipt short of it produces `publication_unknown` rather than a
    success the user would trust. A retry after a failure that preceded durable publication is a legitimate
    second attempt, not a duplicate publication: count durable effects, not attempts.

34. **A file at the destination proves nothing on its own.** Native recovery is decided by the receipt and
    the verified identity behind it, never by bare existence. A published receipt whose destination stopped
    matching becomes `publication_unknown` and stays refused; an established publication never turns into
    permission to write there again. The exclusive rename is what stops a transfer overwriting a file it
    cannot account for: `gm_publish` in `companion/native/Sources/CNative/CNative.c` is
    `renameatx_np(..., RENAME_EXCL | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH)`.

35. **Liveness, not safety: the receipt says `verified` before the rename and `published` only after it.**
    A failure in between then recovers as retryable. Claiming `published` early turns a recoverable
    transfer into a permanent `publication_unknown`, which loses it rather than endangering it.

## Two guarantees that hold by construction

These are stronger than a check while they last and weaker the moment the code arrives. Both must be
re-tested as rules on the day a controller appears, and neither inherits a safety claim it has not earned.

- **No blind retry of an uncertain restore.** `prepareRestore` ends in refusal and there is no restore
  controller, so no restore request can be issued and none can be uncertain. The doctrine the future
  implementation owes: an uncertain restore response is reconciled by an authoritative read-only pass, never
  by repeating the POST.
- **Release authority is unreachable.** `assessRelease` in `scripts/qualification/assess-release.ts` hard-codes
  `implementation: "not_run"`, always carries `implementation_incomplete` as a blocker, and reports `release`
  as only `fail` or `not_run`. `qualification` can read `pass`; `release` cannot.

## What a change to any of this owes

Three obligations, from the post-gauntlet baseline tagged `post-gauntlet-2026-09-18`.

1. Keep the invariant true, or amend it here deliberately and say why.
2. Rerun the mutation-confirmed regression for any predicate that changes, not only the suite.
3. Re-qualify anything recorded above as holding by construction, because a construction guarantee does not
   survive the arrival of the code it was the absence of.

And three rules about the evidence itself, which the gauntlet converged on in order of how easily each is
missed. The assertion must not be vacuous. The named guard must actually be reached, since a case can be
sound and still never run the clause it was written around. And the mutation must have changed the exact
source region intended, because a first-occurrence replace can land elsewhere and report a false survival.
