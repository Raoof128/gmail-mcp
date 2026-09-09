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

**The Cloudflare Worker holds all authority.** Credentials, account selection, policy, approvals, the
operation journal, the audit log and attachment metadata all live there. It is the only component that
talks to Gmail.

**The local companion holds none.** It knows nothing about Gmail. It exchanges opaque staging handles for
files on disk and enforces the filesystem rules that only a process on that filesystem can enforce. Its
uploads still pass through the Worker's policy engine before any byte is accepted.

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

### Policy engine — `worker/src/policy/`

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

### Approval engine — `worker/src/approval/`

`ask` never means "do it and mention it". It creates a pending action, stores the canonical
([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html)) form of the arguments, hashes exactly those
stored bytes, and returns without touching Gmail.

The claim is one D1 batch that either fully succeeds or fully rolls back. D1 batches are transactional,
but a zero-row `UPDATE` is not an error, so the batch inserts into a table constrained `CHECK (x = 0)`
when a precondition fails. That turns "the row was not in the state I expected" into a rollback.

The attachments an operation reserves are read back out of the approved payload. The caller does not pass
them. This is what makes approval mean something: you approved a specific payload, and the reservation
comes from that payload rather than from whatever the next call happens to say.

### Operation journal — `worker/src/operations/journal.ts`

Every non-idempotent external side effect gets a row before it happens. Gmail has no idempotency key, so
this table is the only thing that makes a retry safe.

An idempotency key binds to one action and one payload hash. Reusing a key with different content is an
`idempotency_conflict`, not a silent replay of the old result. Acquisition is `INSERT OR IGNORE` followed
by a read, so the unique index arbitrates rather than a check-then-insert race.

The states distinguish four things that are usually conflated: race prevention, replay prevention,
external idempotency, and delivery reconciliation. `delivery_unknown` exists because "the request may have
reached Gmail and we never recorded the answer" is a real state that deserves a name instead of a guess.

### Staging — `worker/src/staging/store.ts`

Handles are 32 random bytes, non-enumerable, and carry no Google identifiers. Objects live in R2 with a
30-minute TTL and metadata in D1.

Ingest validates before it writes: the body is read to completion, length-checked and hashed before
anything reaches R2. Streaming straight through was tried first. A wrong declared length aborts the
in-flight upload, leaves a partial object behind, and surfaces as an unhandled rejection. Buffering is
bounded by the 25 MB cap against a 128 MB isolate, and in exchange no failure path can orphan an object.

Reservation, consumption and release are separate steps so a crash mid-send leaves handles reserved rather
than reusable, and the scheduled job releases them only when it can prove the operation never started.

### Schema — `worker/migrations/`

Two ideas do most of the work.

**Ownership is a foreign key.** Child tables carry `(user_id, account_id)` referencing
`accounts(user_id, id)`, and references to operations carry the full `(user_id, account_id, operation_id)`
triple. A coding mistake cannot reserve one account's attachment for another account's operation, because
the database refuses it.

**Nullable keys use partial unique indexes.** Owner-wide policy rows have `account_id IS NULL`, and SQLite
treats NULLs as distinct inside a composite primary key, so a plain `PRIMARY KEY` would have permitted
duplicate global policies. Two partial unique indexes express the real constraint.

### Audit — `worker/src/audit/log.ts`

Two rows per mutating call: intent before any side effect, outcome after. The module renders its own
summary from structured facts, so a caller cannot pass a subject line or message body into it even by
accident. Privacy is enforced where the writing happens rather than in every caller's good intentions.

The journal, not the audit log, is authoritative for delivery. If the outcome row fails to write after
Gmail succeeded, the call still reports success and the write failure goes to telemetry: the audit system
must never undermine idempotency.

### Scheduled recovery — `worker/src/cron.ts`

Every five minutes, bounded per run: expire stale approvals, promote operations stuck in `executing` to
`delivery_unknown`, and recover ones stuck in `claimed`, which by construction never opened a request.

Recovery is one transaction with an assertion, so an operation that progressed between the query and the
recovery is left alone. Without that, the job could release attachments out from under a send that was
still in flight.

## Technology choices

| Choice                | Why                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Cloudflare Workers    | Remote by requirement, so the server works from claude.ai and mobile, not only a laptop           |
| D1                    | Transactional batches and real constraints, which is what the ownership and claim invariants need |
| R2                    | Attachment bytes are large, short-lived and do not belong in a row                                |
| KV                    | Only OAuth and CSRF state, where the TTL semantics fit                                            |
| Stateless MCP handler | Matches the 2026-07-28 protocol revision and suits a Worker with no sticky sessions               |

The Workers Paid plan is assumed: the free plan's 10 ms CPU limit is not enough to hash a 25 MB
attachment.

## Where to read next

- [The design spec](superpowers/specs/2026-09-09-gmail-mcp-design.md) — every decision, the facts behind
  it, and the threat model.
- [Plan 1](superpowers/plans/2026-09-09-gmail-mcp-plan-1-worker-foundations.md) — the implemented
  foundations, task by task, with the tests.
- [SECURITY.md](../SECURITY.md) — the threat model in table form, and the limitations stated plainly.
