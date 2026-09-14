# Plan 5 revision 3 contracts

This appendix is normative for Phase A. SQL and pure fixtures below are executable planning artifacts, not installed migrations or production code. The implementation plan owns integration and runtime red/green tests. Phase B is outside these interfaces.

## Shared types

Place these types in `worker/src/operations/recovery-types.ts`; import the existing `Env` and `Deps` where an implementation signature uses them. Time values are integer epoch milliseconds. Validate all wire values at runtime; TypeScript alone is not validation.

```ts
export type UploadEndpoint = { kind: "send" } | { kind: "draft_create" } | { kind: "draft_update"; draftId: string };
export type RecoveryMode = "generated_search" | "send_session_status";
export type SendResult = {
  gmail_result_id: string;
  message: { id: string; thread_id: string; label_ids: string[] };
};
export type Binding = {
  operationId: string;
  userId: string;
  accountId: string;
  credentialVersion: number;
  executor: "send_message" | "reply" | "forward" | "send_draft";
  resultVersion: "send-v1";
  generatedMessageId: string | null;
  threadId: string | null;
  pendingId: string | null;
  startedAt: number;
  mimeLength: number | null;
  buildId: string;
  origin: string;
  audit: { action: string; modifiers: string[]; recipients: number; attachments: number };
};
export type Candidate = {
  id: string;
  threadId: string;
  labels: string[];
  messageIds: string[];
  internalDate: number;
};
export type Proof =
  | { kind: "generated_search"; operationId: string; candidate: Candidate }
  | { kind: "session_receipt"; operationId: string; sessionDigest: string; result: SendResult };
export type Observation =
  | { kind: "confirmed"; proof: Proof }
  | {
      kind: "deferred";
      retryAt: number;
      reason: "not_found" | "ambiguous" | "throttled" | "budget" | "transport" | "awaiting_final";
    }
  | { kind: "suspended"; reason: "account_changed" | "disabled" | "expired" | "manual_draft" | "invalid_evidence" };
export type SessionStatus =
  | { kind: "complete"; result: SendResult }
  | { kind: "incomplete"; nextOffset: number }
  | { kind: "awaiting_final" }
  | { kind: "unknown"; reason: "expired" | "invalid_response" };
export type Lease = {
  operationId: string;
  token: string;
  until: number;
  qualificationEpoch: string;
  mode: RecoveryMode;
};
export type Deadlines = { runUntil: number; attemptUntil: number; requestUntil: number };
export type HttpObservation =
  | { kind: "response"; status: number; bytes: Uint8Array; range: string | null; retryAfter: string | null }
  | { kind: "deferred"; retryAt: number; reason: "budget" | "transport" }
  | { kind: "suspended"; reason: "account_changed" | "disabled" | "expired" };
```

Executor literals above must match the actual registry before integration. The baseline registry names are checked by the plan validator; changing a tool name requires a versioned binding amendment, not casting an unknown string. Do not accept a draft binding for search or a draft-write response for `send-v1`.

Implementation signatures:

```ts
// Existing tokens.ts: pinned variant retains current unpinned API for unrelated callers.
getAccessTokenPinned(env: Env, deps: Deps, userId: string, accountId: string,
  options: { expectedVersion: number; forceRefresh: boolean }): Promise<string>;
// deps.googleFetch used for refresh must already be the bounded/admitted wrapper.
validateSessionUrl(raw: string, expectedEndpoint: UploadEndpoint): URL;
parseSessionStatus(status: number, range: string | null, total: number,
  previousOffset: number, body: Uint8Array, resultVersion: "send-v1"): SessionStatus;
beginRecoverableOperation(env: Env, binding: Binding, sessionUrl: string | null): Promise<void>;
claimRecovery(env: Env, operationId: string, windowId: number, now: number,
  runUntil: number): Promise<Lease | null>;
recoveryRequest(env: Env, deps: Deps, binding: Binding, lease: Lease, deadlines: Deadlines,
  request: { kind: "gmail" | "refresh"; url: string; init: RequestInit }): Promise<HttpObservation>;
observeDelivery(env: Env, deps: Deps, binding: Binding, lease: Lease,
  deadlines: Deadlines): Promise<Observation>;
settleRecovered(env: Env, binding: Binding, lease: Lease, proof: Proof): Promise<"settled" | "replayed" | "conflict" | "fenced">;
settleDirect(env: Env, operationId: string, result: SendResult): Promise<"settled" | "replayed" | "conflict">;
recordFailure(env: Env, operationId: string): Promise<"failed_safe" | "delivery_unknown" | "executed">;
recoverDeliveries(env: Env, deps: Deps, scheduledTime: number, now: number): Promise<{checked:number; confirmed:number; deferred:number; manual:number}>;
```

These signature declarations describe module exports; imports/body implementations belong to the indicated task. `recoveryRequest` must whitelist request kind/endpoint internally; the generic `RequestInit` is not a model input or a bypass around URL/method validation. `refresh` permits exactly POST to the existing OAuth token endpoint, bounded form body from the token helper, and response under the same byte/deadline caps. For a Gmail request, obtain the pinned token through a token helper whose injected fetch invokes the refresh branch. The refresh branch performs admission and fetch directly; it does not acquire another access token, avoiding recursion. Gmail admission follows successful acquisition and rechecks account version/epoch. No direct call to `defaultDeps.googleFetch` may bypass its admission wrapper inside recovery.

## Migration SQL

Execute on the existing migrations 0001–0004. The account/operation composite unique key already exists. JSON schema beyond the checks below is validated before binding. The migration never backfills protocol 2.

```sql
ALTER TABLE operations ADD COLUMN settlement_protocol INTEGER NOT NULL DEFAULT 1 CHECK(settlement_protocol IN (1,2));
ALTER TABLE operations ADD COLUMN result_identity TEXT;
ALTER TABLE operations ADD COLUMN settlement_context_json TEXT CHECK(settlement_context_json IS NULL OR
 (json_valid(settlement_context_json) AND length(CAST(settlement_context_json AS BLOB))<=2048));
ALTER TABLE operations ADD COLUMN byte_admitted INTEGER NOT NULL DEFAULT 0 CHECK(byte_admitted IN (0,1));
CREATE TABLE recovery_installation (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema_version INTEGER NOT NULL CHECK(schema_version=5),
  restore_generation TEXT NOT NULL, mutation_state TEXT NOT NULL CHECK(mutation_state IN ('frozen','active'))
);
-- No default active row: trusted installation must bind the external generation first.
CREATE TABLE recovery_control (
  origin TEXT NOT NULL, build_id TEXT NOT NULL, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('generated_search','send_session_status')),
  state TEXT NOT NULL CHECK(state IN ('probe','enabled','disabled')), epoch TEXT NOT NULL CHECK(length(epoch)=46 AND epoch GLOB 'qe_*'),
  expires_at INTEGER NOT NULL, evidence_hash TEXT NOT NULL, probe_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(probe_ids)),
  PRIMARY KEY(origin,build_id,user_id,account_id,credential_version,mode),
  FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id)
);
CREATE TABLE operation_recovery (
  operation_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL, binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
  state TEXT NOT NULL CHECK(state IN ('active','manual','suspended','completed')),
  started_at INTEGER NOT NULL, deadline INTEGER NOT NULL CHECK(deadline=started_at+86400000),
  retain_until INTEGER NOT NULL CHECK(retain_until=started_at+604800000),
  next_attempt_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 288),
  last_window INTEGER, lease_token TEXT, lease_until INTEGER,
  session_enc BLOB, session_key_id TEXT, session_digest TEXT,
  mime_length INTEGER CHECK(mime_length BETWEEN 0 AND 36700160),
  confirmed_offset INTEGER NOT NULL DEFAULT 0 CHECK(confirmed_offset>=0),
  CHECK((session_enc IS NULL)=(session_key_id IS NULL)),
  CHECK((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK(mime_length IS NULL OR confirmed_offset<=mime_length),
  CHECK(COALESCE(length(session_enc),0)<=4124),
  CHECK(length(CAST(binding_json AS BLOB))+COALESCE(length(session_enc),0)<=8192),
  FOREIGN KEY(user_id,account_id,operation_id) REFERENCES operations(user_id,account_id,id)
);
CREATE INDEX recovery_due ON operation_recovery(state,next_attempt_at,started_at,operation_id);
CREATE TABLE recovery_attempts (
  window_id INTEGER NOT NULL, operation_id TEXT NOT NULL, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  admitted_at INTEGER NOT NULL, PRIMARY KEY(window_id,operation_id),
  FOREIGN KEY(user_id,account_id,operation_id) REFERENCES operations(user_id,account_id,id)
);
CREATE TABLE recovery_requests (
  id TEXT PRIMARY KEY, window_id INTEGER NOT NULL, operation_id TEXT NOT NULL,
  admitted_at INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('gmail','refresh')),
  FOREIGN KEY(operation_id) REFERENCES operations(id)
);
CREATE INDEX recovery_requests_time ON recovery_requests(admitted_at);
CREATE TABLE settlement_permits (
  operation_id TEXT PRIMARY KEY, token TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('begin','success','unknown','failed_safe','storage')),
  operation_writes INTEGER NOT NULL DEFAULT 0 CHECK(operation_writes BETWEEN 0 AND 1),
  audit_writes INTEGER NOT NULL DEFAULT 0 CHECK(audit_writes BETWEEN 0 AND 1),
  FOREIGN KEY(operation_id) REFERENCES operations(id)
);
CREATE TRIGGER protocol2_no_downgrade BEFORE UPDATE OF settlement_protocol ON operations
WHEN OLD.settlement_protocol=2 AND NEW.settlement_protocol!=2
BEGIN SELECT RAISE(ABORT,'protocol downgrade refused'); END;
CREATE TRIGGER protocol2_update_permit BEFORE UPDATE ON operations
WHEN (OLD.settlement_protocol=2 OR NEW.settlement_protocol=2) AND NOT EXISTS(
 SELECT 1 FROM settlement_permits p WHERE p.operation_id=OLD.id AND p.operation_writes=0
 AND OLD.id=NEW.id AND OLD.user_id=NEW.user_id AND OLD.account_id=NEW.account_id
 AND ((p.purpose='begin' AND OLD.settlement_protocol=1 AND OLD.state='claimed'
       AND NEW.settlement_protocol=2 AND NEW.state='executing' AND NEW.byte_admitted=1)
   OR (OLD.settlement_protocol=2 AND NEW.settlement_protocol=2
      AND NEW.settlement_context_json IS OLD.settlement_context_json
      AND NEW.rfc822_message_id IS OLD.rfc822_message_id
      AND NEW.idempotency_key IS OLD.idempotency_key AND
      ((p.purpose='success' AND OLD.state IN ('executing','delivery_unknown') AND NEW.state='executed')
       OR (p.purpose='unknown' AND OLD.state='executing' AND NEW.state='delivery_unknown')
       OR (p.purpose='failed_safe' AND OLD.state='claimed' AND OLD.byte_admitted=0 AND NEW.state='failed_safe')))))
BEGIN SELECT RAISE(ABORT,'settlement transition permit required'); END;
CREATE TRIGGER protocol2_count_update AFTER UPDATE ON operations
WHEN NEW.settlement_protocol=2
BEGIN UPDATE settlement_permits SET operation_writes=operation_writes+1 WHERE operation_id=NEW.id; END;
CREATE TRIGGER protocol2_delete_refused BEFORE DELETE ON operations WHEN OLD.settlement_protocol=2
BEGIN SELECT RAISE(ABORT,'retained operation required'); END;
CREATE TRIGGER protocol2_insert_refused BEFORE INSERT ON operations WHEN NEW.settlement_protocol=2
BEGIN SELECT RAISE(ABORT,'begin transaction required'); END;
CREATE TRIGGER protocol2_audit_permit BEFORE INSERT ON audit_log
WHEN NEW.phase='outcome' AND EXISTS(SELECT 1 FROM operations o WHERE (o.id=NEW.operation_id OR o.id IN (SELECT operation_id FROM pending_actions WHERE id=NEW.pending_id)) AND o.settlement_protocol=2)
 AND NOT EXISTS(SELECT 1 FROM settlement_permits p JOIN operations o ON o.id=p.operation_id
 WHERE p.operation_id=NEW.operation_id AND p.operation_writes=1 AND p.audit_writes=0
 AND NEW.user_id=o.user_id AND NEW.account_id=o.account_id
 AND ((p.purpose='success' AND NEW.decision='executed' AND o.state='executed')
   OR (p.purpose='unknown' AND NEW.decision='delivery_unknown' AND o.state='delivery_unknown')
   OR (p.purpose='failed_safe' AND NEW.decision='failed_safe' AND o.state='failed_safe')))
BEGIN SELECT RAISE(ABORT,'outcome transition permit required'); END;
CREATE TRIGGER protocol2_count_audit AFTER INSERT ON audit_log
WHEN NEW.phase='outcome' AND EXISTS(SELECT 1 FROM operations o WHERE (o.id=NEW.operation_id OR o.id IN (SELECT operation_id FROM pending_actions WHERE id=NEW.pending_id)) AND o.settlement_protocol=2)
BEGIN UPDATE settlement_permits SET audit_writes=audit_writes+1 WHERE operation_id=NEW.operation_id; END;
CREATE TRIGGER protocol2_pending_update BEFORE UPDATE ON pending_actions
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id IN (OLD.operation_id,NEW.operation_id) AND o.settlement_protocol=2
 AND NOT EXISTS(SELECT 1 FROM settlement_permits p WHERE p.operation_id=o.id AND p.purpose IN ('success','unknown','failed_safe')))
BEGIN SELECT RAISE(ABORT,'pending settlement permit required'); END;
CREATE TRIGGER protocol2_pending_binding BEFORE UPDATE ON pending_actions
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id=OLD.operation_id AND o.settlement_protocol=2)
 AND (NEW.operation_id IS NOT OLD.operation_id OR NEW.id!=OLD.id)
BEGIN SELECT RAISE(ABORT,'pending binding immutable'); END;
CREATE TRIGGER protocol2_pending_insert BEFORE INSERT ON pending_actions
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id=NEW.operation_id AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'pending must precede begin'); END;
CREATE TRIGGER protocol2_pending_delete BEFORE DELETE ON pending_actions
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id=OLD.operation_id AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'retained pending binding required'); END;
ALTER TABLE staging_objects ADD COLUMN settlement_operation_id TEXT REFERENCES operations(id);
CREATE TRIGGER protocol2_staging_update BEFORE UPDATE ON staging_objects
WHEN EXISTS(SELECT 1 FROM operations o
 WHERE o.id IN (OLD.reserved_by_operation_id,NEW.reserved_by_operation_id,OLD.settlement_operation_id,NEW.settlement_operation_id)
 AND o.settlement_protocol=2 AND NOT EXISTS(SELECT 1 FROM settlement_permits p
 WHERE p.operation_id=o.id AND p.purpose IN ('begin','success','failed_safe','storage')))
BEGIN SELECT RAISE(ABORT,'staging settlement permit required'); END;
CREATE TRIGGER protocol2_staging_owner BEFORE UPDATE ON staging_objects
WHEN NEW.settlement_operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operations o
 WHERE o.id=NEW.settlement_operation_id AND o.user_id=NEW.user_id AND o.account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'staging owner mismatch'); END;
CREATE TRIGGER protocol2_staging_insert BEFORE INSERT ON staging_objects
WHEN NEW.settlement_operation_id IS NOT NULL OR EXISTS(SELECT 1 FROM operations o
 WHERE o.id=NEW.reserved_by_operation_id AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'staging must precede begin'); END;
CREATE TRIGGER protocol2_staging_binding BEFORE UPDATE ON staging_objects
WHEN OLD.settlement_operation_id IS NOT NULL AND NEW.settlement_operation_id IS NOT OLD.settlement_operation_id
BEGIN SELECT RAISE(ABORT,'staging binding immutable'); END;
CREATE TRIGGER protocol2_staging_delete BEFORE DELETE ON staging_objects
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id IN (OLD.reserved_by_operation_id,OLD.settlement_operation_id)
 AND o.settlement_protocol=2 AND NOT EXISTS(SELECT 1 FROM settlement_permits p WHERE p.operation_id=o.id AND p.purpose='storage'))
BEGIN SELECT RAISE(ABORT,'storage cleanup permit required'); END;
CREATE TRIGGER protocol2_key_update BEFORE UPDATE ON idempotency_keys
WHEN EXISTS(SELECT 1 FROM operations o WHERE (o.id=OLD.operation_id OR o.id IN (SELECT operation_id FROM pending_actions WHERE id=OLD.pending_id)) AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'retained idempotency binding required'); END;
CREATE TRIGGER protocol2_key_delete BEFORE DELETE ON idempotency_keys
WHEN EXISTS(SELECT 1 FROM operations o WHERE (o.id=OLD.operation_id OR o.id IN (SELECT operation_id FROM pending_actions WHERE id=OLD.pending_id)) AND o.settlement_protocol=2)
BEGIN SELECT RAISE(ABORT,'retained idempotency binding required'); END;
```

Permits are inserted first and removed last within the SAME asserted `DB.batch`; no standalone insert/run is allowed. A failed batch rolls back its permit. The transaction tests assert `SELECT count(*) FROM settlement_permits = 0` after success and failure. A permit allows at most one operation transition and one matching owner/account outcome, enforced by counters and purpose predicates; it may authorize several linked pending/staging effects within that transaction. It cannot authorize a second operation update or audit. Insert permits with explicit `(operation_id,token,purpose)` columns. Storage permits authorize only storage effects and cannot settle an operation. The trigger is a compatibility guard against existing writers, not a sandbox against malicious SQL from a trusted deployment admin.

## State transactions

Use bound values, never interpolated SQL. `:name` below denotes a named fixture parameter; Worker code uses ordered `?` bindings. Do not silently ignore zero-row guards. Every mutation sequence below runs in one `DB.batch`.

Beginning: insert permit purpose begin; assert operation owner/account, state claimed, account active/version, and no existing recovery binding; assert owner recovery row count <1,000 and global <2,000; insert binding; update operation protocol=2, byte_admitted=1, state=executing and generated RFC822 id; persist immutable `settlement_context_json` (executor/resultVersion, pendingId and safe audit fields only, maximum 2,048 UTF-8 bytes) on the original operation; set `settlement_operation_id` on all held staging rows to the operation id; delete permit. Refuse cap/context failure before opening Gmail bytes. Audit sizes/counts and generated Message-ID equality are validated before the batch. The byte flag is conservative: it records request admission, not proof of byte receipt.

Recovery claim: assert active recovery row, deadline>now, attempts<288, next_attempt_at<=now, no live lease, last_window differs; assert qualified current origin/build/account/version/mode or scratch probe allowlist; assert fewer than ten attempt rows for the window and fewer than two for the account; insert attempt event; increment attempts and set last_window/token/until. A failed claim does not increment counters.

Both attempt and request admission assert physical ledger counts below 3,000 attempts and 9,000 requests respectively, including expired rows pending cleanup. Request admission additionally asserts rolling/global credits and qualification/lease/deadlines, then inserts one event:

```sql
INSERT INTO _assert(x) SELECT 1 WHERE NOT EXISTS (
 SELECT 1 FROM operation_recovery r JOIN accounts a ON a.id=r.account_id AND a.user_id=r.user_id
 WHERE r.operation_id=:op AND r.lease_token=:lease AND r.lease_until>:now
 AND r.deadline>:now AND a.status='active' AND a.credential_version=r.credential_version
);
INSERT INTO _assert(x) SELECT 1 WHERE :request_until<=:now OR :attempt_until<=:now OR :run_until<=:now;
INSERT INTO _assert(x) SELECT 1 WHERE (SELECT count(*) FROM recovery_requests)>=9000;
INSERT INTO _assert(x) SELECT 1 WHERE (SELECT count(*) FROM recovery_requests WHERE window_id=:window)>=30;
INSERT INTO _assert(x) SELECT 1 WHERE (SELECT count(*) FROM recovery_requests WHERE admitted_at>:now-300000)>=30;
INSERT INTO recovery_requests(id,window_id,operation_id,admitted_at,kind) VALUES(:id,:window,:op,:now,:kind);
```

The qualification assertion precedes those statements in the same batch: exact control key from the binding, `epoch=:captured_epoch`, `expires_at>:now`; state enabled, or state probe AND deployed profile scratch AND op present in its explicit JSON array. The build is the embedded deployment build, never a request argument. All admission predicates are reused for 401/refresh, with no nested `gmailFetch` retry loop.

Success transaction: insert permit success; assert protocol=2 and operation state in executing/delivery_unknown; for recovery additionally assert live lease, same account version, qualification epoch/state, matching proof operation/session/generated id and supported result version; update state executed/result_json/result_identity; mark held staging rows consumed and unreserved if present; redact linked pending row in executing or failed with error delivery_unknown and clear error; insert one audit decision executed; mark recovery completed and erase session ciphertext/key; delete permit. `result_identity` is canonical JSON `[message.id,message.thread_id]`. The first state assertion makes concurrent success lose the batch before audit. Catch the assertion failure by reading the terminal row: same identity replays, different identity conflicts, otherwise fenced. Do not re-run the write batch merely because labels changed.

Each attempt chooses exactly one qualified mode, captured in its lease; Use the explicit mapping generated_search → generated_search and send_session_status → session_receipt. Both cross-mode pairings refuse; do not compare the two enum strings for literal equality. A session attempt never falls back to a differently qualified search under the same lease. On expired session erase its ciphertext and defer; a later window can choose generated search. When both modes are eligible, prefer session status; if only search remains, choose it. Direct response uses the same success transaction without qualification/lease checks. It requires original operation binding and protocol 2 but may record positive evidence after automatic recovery is disabled. It cannot overwrite a winner. For protocol 1 retain legacy handling and never let new recovery target it.

Failure transaction first returns an already executed row. Otherwise: claimed AND byte_admitted=0 may become failed_safe; executing/delivery_unknown/byte_admitted=1 becomes/remains delivery_unknown and keeps the key. Redact linked pending as failed/delivery_unknown. Unknown audit is inserted only on the first transition to unknown; further errors return the existing state. Use permits for protocol 2, including failed-safe/unknown paths. Never classify by status class alone.

Cleanup clears session at horizon/disable/revoke, marks active rows manual/suspended, then purges recovery rows after retain_until. Original operations retain protocol/result/key semantics and settlement_context_json; a post-begin operation write must not change that context. Store no session, address or MIME there. Qualification history prunes disabled/expired rows before admission and refuses above 32 owner/64 global. Request/attempt ledgers prune older than 24h without removing a currently retained window's counters; late invocations older than 24h are refused at handler entry. Storage abandonment is an admin-only separate transaction and never deletes the operation/key.

## Additional normative boundaries (B1–B6, M1–M12)

- Review this appendix, the design, main plan and revision-3 resolution together. The review bundle includes their full content and a SHA-256 manifest; a main-plan-only review cannot certify the SQL.
- `credential_version` already means Google grant identity: reconnect/revoke advance it; ordinary cached-access-token refresh does not. Retain that field name. Test normal refresh at N succeeds at N, and reconnect/revoke N+1 fences every pinned admission.
- `windowId=floor(controller.scheduledTime/300000)` is used only for window identity and deduplication. `now` is freshly sampled trusted server admission time, never scheduledTime or client time; it drives event admitted_at, rolling budget, lease, horizon and all deadlines. Sample again for each admission. Invocation start fixes runUntil. Three delayed windows (12:00, 12:05, 12:10) arriving at 12:14 share thirty actual-time requests, including refresh. Refuse future scheduled timestamps and events older than 24h. A wall-clock regression aborts the invocation; monotonic elapsed time also enforces local duration ceilings.
- The 8,192-byte bound is **UTF-8 binding_json bytes plus raw session_enc BLOB bytes**, not SQLite row size or base64 size. Ciphertext alone is at most 4,124 bytes (4,096-byte URI plus 12-byte IV and 16-byte GCM tag); This framing matches the existing crypto/keyring.ts AES-GCM IV/ciphertext layout. Other columns/indexes are excluded from this named payload budget. Test exact 8,192 acceptance, 8,193 rejection, multibyte JSON and ciphertext-only overflow.
- Session URI is credential-equivalent: store only encrypted, never verbatim in logs, audit, exceptions, model/client output, or private/public reports. Disable URL-bearing fetch error serialization. Reports may record only an approved path-variant enum and a digest, never upload_id or full URL. Original upload retains the URI only in necessary transient transport memory.
- A 308 plus valid Range without Location is valid incomplete status. The transport returns 308 to the parser while refusing redirect following; other redirect statuses are invalid evidence. Location is required only when establishing the original session. Separate 404 and 410 fixtures must retain delivery_unknown and the key after ambiguous bytes.
- Retry-After accepts a finite nonnegative integer delay or a valid HTTP date, using response admission time for delay seconds. Reject negative/overflow/malformed values to local backoff. Set retryAt=max(localBackoffAt, providerAt); a past date cannot shorten local backoff. At or beyond the horizon, mark manual/unknown with no next admission. Cover `Sun, 13 Sep 2026 09:30:00 GMT`, past date, malformed, negative, numeric overflow, 1200 and 3600 seconds.
- Search uses `q=rfc822msgid:<internally-generated-id>`, SENT restriction and maxResults=2, then metadata fetch of ids/thread/labels/internalDate/all Message-ID headers through the pinned account. Require exactly one candidate, no next page, exactly one equal Message-ID header, SENT, expected thread when bound, and start−120000 <= internalDate <= horizon. Zero or ambiguous results defer until horizon then manual_unknown; neither becomes failed_safe. This deliberately rejects multiple search hits instead of choosing a convenient one.
- Cleanup must preserve the original operation, result identity, key and pending id after recovery metadata expires. Direct success after seven days reads its immutable operation/context, tolerates deleted handles and still settles once. Never make direct success depend on the purged recovery row. A storage permit plus known-stopped/published producer proof gates cleanup; no active/unknown R2 writer may be released even if DELETE already completed. Test late PUT completion after DELETE with a barrier: administration must refuse before that DELETE is admitted.

## Restore floor and quarantine

Add `worker/src/operations/installation.ts`, `worker/test/restore-floor.test.ts`, and `scripts/qualification/restore.ts`. `assertInstallation(env)` fails closed on missing schema/table/guard, absent installation row, schema_version!=5, external `RESTORE_GENERATION` mismatch or mutation_state!=active. Apply before **every mutation ingress**, including all MCP mutation tools, approval execution, staging upload/download acknowledgement, account changes, scheduled maintenance and qualification changes; repeat before network admission and settlement. Read-only health may expose only `ready`/`maintenance`. Authoritative schema/trigger verification belongs to the deployment/restore CLI; admission reads the verified installation marker. This is an operational restore protocol against trusted-operator mistakes, not detection of arbitrary unsupervised SQL/schema tampering.

`restore.ts --manifest <private-path>` is maintenance-only in Phase A: validate the exact database/bookmark/deployment target and record an external private restore receipt; deploy a restoration-compatible maintenance build that denies all mutation ingress and scheduled writes, rotate `RESTORE_GENERATION` in deployment configuration outside D1, and verify every routed version is frozen. Drain prior database writers before invoking restore; absent verifiable quiescence, refuse the restore. A timer or Gmail promise is not proof of remote non-delivery. Capture/export surviving journal and idempotency records privately before restoration. Keep maintenance routing and the external generation unchanged during restore, so a restored active flag or old qualification cannot reactivate service. A pre-0005 snapshot may be restored only under this frozen maintenance build; reapply the schema/guards and install a **frozen** marker with the new generation. No recovery enable or normal writer rollback is permitted during quarantine.

D1 restore may erase records of mail already sent, including operations/keys absent from the restored snapshot. Therefore merely disabling restored qualification rows is insufficient. **Phase A does not resume mutations after Time Travel.** All restored qualification is invalidated; old operations/keys are quarantined, and absent keys must not become fresh attempts. Resume requires a separately reviewed incident reconciliation plan for the entire lost interval, preserved external evidence and fresh qualification; if evidence is incomplete, keep affected mutation access frozen. The runbook must explicitly show this limit. Read-only health remains available; no endpoint claims that a missing restored operation proves no send. Test missing 0005, restored active marker/old epoch, absent lost-interval operation, deployment rollback attempting to reactivate old generation, and zero external sends while frozen.

Cloudflare documents transactional batch rollback, scheduled-time semantics and Time Travel retention of 7 days on Workers Free and 30 days on Workers Paid; these are platform inputs, not proof of this proposed implementation. Sources: [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/), [scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/), [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/). Restore authorization remains a separate explicit operator action.

## Pure fixture contract

Use these vectors in `worker/test/recovery-contracts.test.ts`. The plan conformance script executes equivalent pure rules and migration constraints; production tests must import the actual implementation, not copy the rule under test.

| Case                         | Input                                                               | Required result                               |
| ---------------------------- | ------------------------------------------------------------------- | --------------------------------------------- |
| reused draft header          | executor send_draft, same Message-ID/thread and earlier SENT result | suspended/manual_draft                        |
| qualified session/search lag | valid bound final send-v1 receipt, zero search results              | confirmed/session_receipt                     |
| range prefixed               | status 308, Range bytes=0-42, total 100, previous 0                 | incomplete/43                                 |
| range bare                   | status 308, Range 0-42, total 100, previous 0                       | incomplete/43                                 |
| all bytes not final          | status 308, Range 0-99, total 100                                   | awaiting_final                                |
| missing range regresses      | status 308, Range null, previous 43                                 | unknown/invalid_response                      |
| range at overflow            | status 308, Range 0-9007199254740992                                | unknown/invalid_response                      |
| expired session              | status 404 or 410 after possible bytes                              | unknown/expired; key held                     |
| encoded traversal            | /users/me/extra/%2e%2e/messages/send                                | reject before URL normalization/token lookup  |
| Retry-After hour             | 429 and Retry-After 3600                                            | one request; next attempt >= now+3600000      |
| body stalls                  | headers arrive then body stalls                                     | abort at request deadline, no settlement      |
| body over cap                | 65,537 bytes                                                        | bounded refusal, no JSON parse/settlement     |
| reconnect barrier            | account N+1 before token/401 refresh                                | no request with N+1 token                     |
| label drift                  | same ids, changed labels on loser                                   | exact first result replay, one executed audit |
| disable/re-enable            | lease captured epoch A, current epoch C                             | recovery fenced                               |
| old writer                   | protocol2 op, baseline settlement without permit                    | transaction refuses, no outcome append        |

## Build identity and qualification entry points

`scripts/qualification/build-id.ts` hashes production inputs by sorted POSIX relative path. For each file update SHA-256 with UTF-8 path length in ASCII decimal, `:`, path bytes, body length in ASCII decimal, `:`, body bytes. Include all tracked files under `worker/src`, `shared/src`, `worker/migrations`, plus root/shared/worker package.json, package-lock.json, tsconfig.base.json, shared/worker tsconfig.json, and canonical effective deployment config with BUILD_ID omitted. Include compatibility_date/flags, D1/R2 binding identities and schema, cron expressions, routes/domains affecting Message-ID, feature/profile flags, and non-secret recovery limits. Exclude secret values and their hashes; bind grant/key identities through verified epochs or configuration identifiers. Refuse dirty production inputs. Exclude docs/tests/evidence/native because their changes do not alter the Worker recovery implementation. Embed this computed build id during bundling and store bundle SHA-256/deployment id in the private deployment receipt. The private receipt also certifies `RECOVERY_COMPAT_VERSION=3`, covering the permit-aware writer, linked-write guards, protocol-separated cron AND installation/restore admission checks on every mutation ingress; admin deployment/rollback refuses lower versions. Separate Worker, companion, native-helper digests and installed client versions accompany the cases that use them.

`admin.ts` commands: `probe --manifest <private-path>`, `enable --manifest <private-path>`, `disable --manifest <private-path>`, `abandon-storage --manifest <private-path>`. CLI args contain only the private manifest path; never tokens/session URIs/mail content. Check file regular/owner-only/no symlink, maximum 64 KiB. Validate platform deployment receipt, embedded build, origin, owner/account/version, profile and mode. Use the platform credential to read authoritative D1/deployment state. Enable accepts only a private manifest with passing case ids and existing artifact hashes; deployment admin remains the trust authority. Every create/edit generates a fresh, internally generated 256-bit random epoch (`qe_` plus 43 base64url characters); a manifest cannot choose it. Pruning then recreating a control key cannot reuse an old epoch. Every edit replaces epoch in a guarded batch; changing a stale expected epoch refuses. No SQL comes from a manifest.

Freeze a `RunIdentity` before any live case: `{runId, deploymentVersionId, workerBuildId, companionBuildId?, nativeBuildId?, qualificationEpoch, restoreGeneration, manifestSha256, startedAt}`. Verify authoritative platform deployment/config identity and served embedded identity before AND after each live case, and immediately before enable. Capture the serving Worker deployment identity on each credentialed Worker request's response/evidence envelope, including errors; unexpected/missing identity fails the case. Google responses are not expected to supply a Worker build header. Stop the entire run on drift, seal completed results, mark remaining cases not_run, and never merge runs across identities. Deployments and enable commands share an operator-held exclusive deployment lock; no concurrent rollout/traffic split is allowed during qualification. If exclusive control or authoritative per-request identity cannot be established, mark qualification not_run. Enabling atomically asserts the frozen qualification epoch; successful enable creates a fresh epoch and records its parent run/epoch. Recheck the external deployment under the same lock before releasing it. A case cannot silently update the frozen tuple.

Private artifact writer: dedicated owner-only directory (0700), outside every repo/worktree and model attachment root; files 0600, regular/no symlink, atomic temp-write/fsync/rename under that directory. Refuse unsafe existing parents/paths. Manifests/case results carry hashes; record only synthetic fixture digests and necessary preflight addresses. No raw OAuth token, session URI or raw MIME in any report; public projection contains no addresses. Redaction tests cover both private and public results and exceptions. No artifact is eligible for git add.

`run.ts --manifest <private-path>` validates preflight before accessing Gmail credentials, then runs a selected immutable list of cases against exact scratch sender/recipient. It refuses extra addresses including CC/BCC and preserves both failed and passing results. The `TestCase` interface is `{id, requiresLive, run(context): Promise<CaseResult>}`; context supplies the frozen RunIdentity, origin, build, exact scratch identities, verified MCP/native ports, monotonic timer and private artifact writer. `CaseResult` is `{case_id, run_id, deployment_version_id, manifest_sha256, worker_build, companion_build, native_build, client_version, result:'pass'|'fail'|'not_run', started_at, finished_at, attempts, artifact_sha256, limitation}`; no body/address/id is public. `run` returns nonzero if any selected mandatory case fails or is not-run. There is no retry-until-green loop.

Local `preflight.test.ts` injects credential/network spies and tests missing manifest fields, foreign profile/recipient/build, symlink/permissions/size, and verifies zero credential/network calls on refusal. Provider cases run through actual MCP/Gmail transport adapters; fake credentials cannot satisfy live evidence. `--synthetic` writes result mode synthetic and cannot enable recovery on any live origin. The package gate explicitly includes this directory's tests.

## Qualification cases and stop rules

| Case                | Procedure/sample                                                                                                                           | Pass condition                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| generated-id        | 3 approved fixture sends per target mode, capture ids before simulated response loss; poll every 5 min for up to 24h                       | 3 exact generated-id matches, zero unrelated confirmation, same-result replay once each                                                                                      |
| session status      | 3 bound >5 MiB sends, lose response after provider commit; status before search                                                            | 3 final receipts accepted, one executed audit each; logged path/range variant within grammar                                                                                 |
| draft negative      | 3 synthetic reused-id/thread fixtures plus 1 authorized old-draft live observation                                                         | zero automatic draft search confirmations; live timestamp observation recorded without enabling search                                                                       |
| byte round trip     | 3 sends/downloads at 0 and 26,214,400 attachment bytes; encoded total recorded                                                             | digest/size exact, encoded bytes <=36,700,160, no runtime resource error                                                                                                     |
| media boundary      | synthetic exact 5 MiB and 5 MiB+1 encoded MIME, 3 each                                                                                     | expected transport, one external mutation each                                                                                                                               |
| reply/revoke        | 3 replies in fixture thread; revoke scratch Google credential once                                                                         | correct thread ids; subsequent use refused and reconnect required                                                                                                            |
| installed clients   | one allow + ask + timeout continuation per applicable Code/Desktop/claude.ai flow, record exact version                                    | correct tool/result, single send; companion only Code/Desktop; no credential or byte content in model trace                                                                  |
| native              | 3 login/logout cycles, 10 process-kill points around receipt publication on scratch volume                                                 | no stale-epoch use, no overwrite, local recovery matches receipt state                                                                                                       |
| physical durability | 3 operator-supervised power-loss trials on dedicated disposable test machine/volume at publication window                                  | each acknowledged save survives with exact digest; each uncertain state stays unacknowledged; no personal data involved                                                      |
| resources           | 10 maximum-payload serial round trips and 2 concurrent allowed download streams on exact deployed tier                                     | zero resource-limit errors; measured peak isolate memory <128,000,000 bytes and CPU below configured route limit; if peak measurement unavailable record memory case not-run |
| rollback            | mixed old/new settlement fixture; paused recovery across disable/prune/recreate; rollback-floor cron with stale protocol1 and staging rows | old permitless writer refuses, recreated epoch differs and old lease refuses, rollback-floor cron maintains unrelated rows, compatible direct response settles once          |

Stop on first unexpected external recipient, credential leak, duplicate send, false confirmation, overwrite, or resource-limit error. Preserve private failure evidence and do not continue that live case automatically. These sample counts are acceptance tests, not statistical reliability claims. Physical power loss requires its own concrete operator authorization; a process kill cannot substitute. Release remains pre-release if any mandatory live/device/resource case is not-run.
