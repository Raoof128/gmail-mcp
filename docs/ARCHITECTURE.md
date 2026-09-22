# Architecture

This is the orientation document: what the pieces are, why they are split the way they are, and where to
look in the code. The complete design, including the reasoning behind every decision and the facts each
one rests on, is in [the design spec](superpowers/specs/2026-09-09-gmail-mcp-design.md).

## The governing rule

> Claude is not the authority. The MCP client is not the authority. Tool annotations are not the
> authority. The authenticated server-side policy engine is the authority.

Everything below follows from that sentence. The model proposes; the server decides; a human approves
anything consequential.

## Two halves, deliberately unequal

The Cloudflare Worker holds all the authority. Credentials, account selection, policy, approvals, the
operation journal, the audit log and attachment metadata live there, and it is the only component that
talks to Gmail.

The local companion holds none of it. It knows nothing about Gmail. It exchanges opaque staging handles
for files on disk and enforces the filesystem rules that only a process on that filesystem can enforce.
Its uploads still clear the Worker's policy engine before any byte is accepted.

The split exists because the two jobs have different trust requirements. Authority needs to be somewhere
the owner controls and the model cannot reach. Filesystem access needs to be on the filesystem. Putting
both in one place would mean either shipping credentials to the laptop or giving a remote service a path
into it.

Attachments cross the boundary only as handles, which has a useful side effect: attachment bytes never
enter the model's context, so a 20 MB PDF costs nothing to move.

## Request lifecycle

A mutating tool call travels the same path every time:

```
tool call
   │
   ├─ resolve the account          explicit for writes; never guessed
   ├─ validate arguments           caps on recipients, subject, body, payload size
   ├─ compute modifiers            +external, +attachment, +bulk, +sensitive
   ├─ policy decision              allow | ask | deny  (modifiers only raise)
   │
   ├── deny  ──▶ refused and audited
   │
   ├── ask   ──▶ pending action created, canonicalised and hashed
   │             nothing has touched Gmail
   │                │
   │                └─ human approves in a browser, or via URL-mode elicitation
   │                       │
   │                       └─ claim: one atomic transaction
   │                              creates the operation
   │                              moves pending to executing
   │                              reserves the attachments named in the approved payload
   │
   └── allow ──▶ claim directly
                    │
                    └─ execute against Gmail, journaled
                           executed | failed_safe | delivery_unknown
```

## The parts that carry the weight

### Identity

`worker/src/auth/`, `worker/src/web/session.ts`

Two kinds of caller reach the Worker, and neither carries an identity it chose for itself.

A Claude client or the companion holds an OAuth token issued by `@cloudflare/workers-oauth-provider`. The
library checks the signature, the expiry and the audience before any handler runs. `requireScope` then adds
what the library leaves to the application: the token's scope must match the route, and the identity in the
token's props must be the token's own owner. A `mcp` token cannot reach `/staging` and a `staging` token
cannot reach `/mcp`, because the scope and the audience differ per route. The owner decides which scope a
client may hold at consent time: the pre-registered companion may hold `staging`, everyone else `mcp`.

The owner's browser holds a session cookie whose value never reaches the database, only its sha256. A
session lasts twelve hours and dies after two idle hours. Editing policy or revoking an account needs a
Google login within the last fifteen minutes, and activity never counts towards that.

Google refresh tokens live only in the Worker, encrypted per account with framed additional data. Every
write that stores or refreshes one carries the `credential_version` read at the start, so a revocation that
lands mid-refresh wins and the refreshed token is thrown away rather than stored against a revoked account.

One-use OAuth state lives in D1 and is consumed by a single `UPDATE ... RETURNING`. KV holds the provider's
own records: it is eventually consistent, so a read followed by a delete is not a one-use consume.

### Policy engine

`worker/src/policy/`

Policy keys on _actions_ (`send.message`, `trash.move`, `label.apply`) rather than tool names, so adding a
tool cannot accidentally add a permission. Each action resolves to `allow`, `ask` or `deny`, looked up as
account override, then owner-wide setting, then the built-in default.

Modifiers are the interesting part. `+external`, `+attachment`, `+bulk` and `+sensitive` describe risk in
the specific call, and they can only raise a level. There is no path by which a modifier makes something
more permitted. A send that is `allow` for your own address becomes `ask` the moment a stranger is on the
recipient list.

`recipients.ts` decides what "stranger" means. It uses a deliberately restricted address grammar, because
this is a permission boundary where a false negative is an inconvenience and a false positive is an
unintended send. Domains are lower-cased and punycoded; local parts are left case-exact except where a
provider is known to fold them.

### Approval engine

`worker/src/approval/`

`ask` never means "do it and mention it". It creates a pending action, stores the canonical
([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html)) form of the arguments, hashes exactly those
stored bytes, and returns without touching Gmail.

The claim is one D1 batch that either fully succeeds or fully rolls back. D1 batches are transactional,
but a zero-row `UPDATE` is not an error, so the batch inserts into a table constrained `CHECK (x = 0)`
when a precondition fails. That turns "the row was not in the state I expected" into a rollback.

The attachments an operation reserves are read back out of the approved payload. The caller does not pass
them. This is what makes approval mean something: you approved a specific payload, and the reservation
comes from that payload rather than from whatever the next call happens to say.

### The tool gate

`worker/src/tools/`

Every Gmail tool is registered through `defineTool`, which resolves the account from the verified
principal, hashes the client's intent, answers a known idempotency key before anything else, and asks the
tool for a plan: modifiers, a summary, audit facts, and a `build` that produces the execution payload.
The gate hands that plan to `runGated`, which decides policy first and calls `build` only afterwards, so a
denied or replayed call writes nothing at all.

`allow` opens a journal row when the tool journals, reserves the handles and runs the executor. `ask`
stores the canonical payload, holds the handles past the pending expiry, and answers with a URL
elicitation on the 2026-07-28 revision when the client can open one, else with the approval URL as text.
`deny` writes its intent row and stops.

Executors are registered by tool name and version and receive nothing but the stored payload and the
account, so a later request holding only the row can execute it, and never under code the payload was not
approved for.

`ToolSpec.journal` governs the direct path only. An approval always opens an operation, because the
atomic claim needs one to be once-only, so a tool that does not journal still has an operation when it
is reached through `execute_pending` and its executor must move that operation to `executing` before the
first mutating request. `JOURNALED_ACTIONS` is documentation; no code reads it, and it is not
authoritative for whether an operation exists.

### The send pipeline

`worker/src/mime/`, `worker/src/operations/send.ts`

`composeMime` reads staged bytes and any carried originals and builds one MIME message under
`<op_…@host>` as a pull stream whose length is known before a byte moves. At or under 5 MB the upload is
`media`, or `multipart` when a thread id must travel with it; above that a resumable session is opened
first, because opening one moves no bytes and may be retried, and only then does the operation move to
`executing` and the PUT open.

New send-message, reply, forward and send-draft operations persist a protocol-2 binding before bytes are admitted. Generated-message sends may qualify for exact Message-ID search or zero-body resumable status observations. Draft sends remain manual. Once admitted, an error of any HTTP class preserves an unknown delivery outcome and holds its idempotency key; a 401 never repeats the original MIME request.

Positive evidence and direct replies share one guarded settlement transaction. D1 permits enforce one operation transition and one matching audit, while compatibility triggers reject legacy writers on protocol-2 rows. The first result identity and label set survive replay, metadata expiry and storage cleanup. See the [release qualification runbook](runbooks/release-qualification.md) for the current live boundary.

### Operation journal

`worker/src/operations/journal.ts`

Every non-idempotent external side effect gets a row before it happens. Gmail has no idempotency key, so
this table is the only thing that makes a retry safe.

An idempotency key binds to one action and one payload hash. Reusing a key with different content is an
`idempotency_conflict`, not a silent replay of the old result. Acquisition is `INSERT OR IGNORE` followed
by a read, so the unique index arbitrates rather than a check-then-insert race.

The states distinguish four things that are usually conflated: race prevention, replay prevention,
external idempotency, and delivery reconciliation. `delivery_unknown` exists because "the request may have
reached Gmail and we never recorded the answer" is a real state that deserves a name instead of a guess.

### Staging

`worker/src/staging/store.ts`

Handles are 32 random bytes, non-enumerable, and carry no Google identifiers. Objects live in R2 with a
30-minute TTL and metadata in D1.

Uploads use an owner-bound transfer and at most three ticket generations. D1 reserves capacity before admission. The Worker counts and hashes bytes before writing the deterministic R2 key, then publishes a handle only through a transaction that checks the current generation, lease and account credential version.

R2 writes and D1 commits are separate. A rejected or expired writer leaves cleanup debt. The Worker releases that charge only after writer termination and deletion; an absent object or elapsed timer is insufficient. Existing Gmail attachment materialization shares the upload buffer admission limit and reserves retained-byte capacity before fetching data.

Download GET admits a bounded lease before opening R2. Purge claims the row before deletion, and ACK records a seven-day owner-bound tombstone independent of the object row.

Reservation, consumption and release are separate steps so a crash mid-send leaves handles reserved rather
than reusable, and the scheduled job releases them only when it can prove the operation never started.

### Schema

`worker/migrations/`

Two ideas do most of the work.

Ownership is a foreign key. Child tables carry `(user_id, account_id)` referencing
`accounts(user_id, id)`, and references to operations carry the whole `(user_id, account_id, operation_id)`
triple. A coding mistake cannot reserve one account's attachment for another account's operation, because
the database refuses the write.

Nullable keys need partial unique indexes. Owner-wide policy rows have `account_id IS NULL`, and SQLite
treats NULLs as distinct inside a composite primary key, so a plain `PRIMARY KEY` would have allowed
duplicate global policies. Two partial unique indexes say what the constraint actually is.

### Audit

`worker/src/audit/log.ts`

Two rows per mutating call: intent before any side effect, outcome after. The module renders its own
summary from structured facts, so a caller cannot pass a subject line or message body into it even by
accident. Privacy is enforced where the writing happens rather than in every caller's good intentions.

The journal, not the audit log, is authoritative for delivery. If the outcome row fails to write after
Gmail succeeded, the call still reports success and the write failure goes to telemetry: the audit system
must never undermine idempotency.

### Scheduled recovery

`worker/src/cron.ts`

Every five minutes cron handles legacy maintenance separately from protocol-2 delivery observation. Qualified observations use durable leases, per-window attempt limits and both scheduled-window and actual rolling-time HTTP budgets. Refreshes and retries consume the same request budget. Eligibility and per-account ordering precede the candidate limit so blocked work cannot hide another account.

Session ciphertext expires at the 24-hour observation horizon or on disable/revoke. Recovery metadata expires after seven days without deleting operation truth or idempotency bindings. Published producer records remain while their staging objects exist, allowing safe cleanup after a late delivery receipt. Unknown producers retain cleanup debt.

Every mutation ingress, network admission and protocol-2 settlement checks the installation's external restore generation. Time Travel remains quarantined because an older snapshot may have lost sent operations and keys. Restoring an active flag does not authorize resuming service.

Materialization exclusivity is bounded by a lease rather than by process lifetime. Admission tests
`lease_until > now`, so at most one materializer is admitted while a lease is valid, and a holder stalled
past the lease stops excluding anyone even if its cleanup never ran. Two materializers can overlap in
exactly that window. That is the deliberate price of not letting one dead process wedge every later job,
and the cron deletes the abandoned row. It is not absolute mutual exclusion and should not be described
as one.

## Local companion

`companion/src/` contains the stdio tools, HTTPS adapter and loopback PKCE login. `companion/native/` contains the Swift helper with Darwin filesystem calls, SQLite and Security.framework.

The helper reads owner-only configuration and holds a permanent process lock during each transaction. Tool arguments name logical root IDs and relative paths. Snapshots precede remote intent creation, and request keys include the authenticated Worker owner, origin and client ID. Repeated calls recover the original snapshot and result. A new explicit idempotency key requests a fresh snapshot.

For saves, the helper records the temporary path and inode before publication. Exclusive rename prevents
replacement. Recovery verifies the destination identity and hash before ACK; missing or changed evidence
produces `publication_unknown`. The journal reserves snapshot and save capacity across helper processes.
Logout persists an epoch change before deleting the Keychain item.

The receipt says `verified` before the rename and `published` only after it, which is a liveness
decision rather than a safety one: a failure in between recovers as retryable, where claiming
`published` early would strand the transfer as `publication_unknown` permanently.

A charge released only on proof needs a way out when the proof can never arrive.
`recoverStartup` collects a leftover temporary on every helper start by checking the device and inode it
recorded; when it cannot, the receipt becomes `publication_unknown` and the reservation stays charged
against the 25 MiB save budget until a human acts. `gmail-mcp-companion debt` is that action. It lists
what is charged, and `debt --scope SCOPE --release HANDLE` clears a charge in exactly one state: a
`publication_unknown` receipt whose temporary is provably absent, where ENOENT is the only outcome
accepted as proof and a permission error or a lost root answers `unknown` and refuses. Releasing repairs
accounting and leaves publication truth alone. The scope is required because a reservation id is
`sha256(scope + NUL + handle)` and cannot be inverted.

Two consequences follow from `recoverStartup` running before the command loop. A collectable temporary
never reaches a listing, because answering `debt` is itself a helper start. And a row that does survive
with its temporary present is one the collector refused, which no restart will fix.

## Technology choices

| Choice                | Why                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Cloudflare Workers    | Remote by requirement, so the server works from claude.ai and mobile, not only a laptop           |
| D1                    | Transactional batches and real constraints, which is what the ownership and claim invariants need |
| R2                    | Attachment bytes are large, short-lived and do not belong in a row                                |
| KV                    | OAuth client and grant storage; one-use web state remains in D1                                   |
| Stateless MCP handler | Matches the 2026-07-28 protocol revision and suits a Worker with no sticky sessions               |

The Workers Paid plan is assumed: the free plan's 10 ms CPU limit is not enough to hash a 25 MB
attachment.

## How to read a claim in this repository

The documentation distinguishes several things that are easy to collapse into "tested", and the
distinction is load-bearing when the subject is a security guarantee.

| Term                   | What it means                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| Locally verified       | a test proves it inside the real Workers runtime or the native suite                                |
| Mutation-confirmed     | neutralising the named predicate turns a specific test red, and the edit was checked                |
| Live                   | it additionally ran against the deployed Worker and real Google infrastructure                      |
| Holds by construction  | true because the code that could break it does not exist yet, and owes requalification when it does |
| Refusal path tested    | the system refuses without evidence; this is not the evidence                                       |
| Defence in depth       | a guard that is real but redundant, because another condition catches the same case                 |
| Load-bearing predicate | mutation testing showed this single clause is the only thing preventing the failure                 |
| `not_run`              | no evidence exists, which is a status rather than a failure                                         |

Never read a refusal path as the underlying guarantee, and never read `not_run` as `pass`.

## Where to read next

- [The design spec](superpowers/specs/2026-09-09-gmail-mcp-design.md) holds every decision, the fact each
  one rests on, the threat model, how the system is verified (4.7) and the qualification architecture
  with the five external gates (4.8).
- [The full-project gauntlet](superpowers/reviews/2026-09-17-full-project-gauntlet.md) is canonical for
  the invariant matrix with its proof types, the load-bearing predicate table and the findings.
- [SECURITY.md](../SECURITY.md) puts the threat model in a table and says what the design does not cover.
- [The runbooks](runbooks/) cover Google Cloud setup, the companion, release and release qualification.
- The plans and reviews under `superpowers/` are the development record. They describe what was true when
  they were written, not necessarily what is true now; this document and the spec are the present tense.
