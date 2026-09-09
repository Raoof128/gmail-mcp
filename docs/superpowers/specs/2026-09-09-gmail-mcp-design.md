# Gmail MCP for Claude: design

Date: 2026-09-09 (revision 2, after adversarial review)
Status: approved design, pre-implementation
Owner: Raouf

## 0. Problem and goal

The hosted Claude Gmail connector exposes 29 tools but none that returns attachment bytes. `get_message` returns attachment names and IDs only. Sending accepts attachments only as base64 inlined in the tool call, which is unusable beyond a few hundred kilobytes. Hosted connectors from any vendor change capability without notice, so this spec makes no product-versus-product claims.

Target: a remote Gmail MCP with attachment staging, local filesystem integration, multi-account operation, and server-enforced policy controls that do not depend on any capability of any hosted connector.

Goals:

1. Runs on Cloudflare so it works from claude.ai, Claude Desktop and Claude Code.
2. Downloads attachments to the owner's disk and attaches files from disk through a thin local companion.
3. Several Google accounts for one owner.
4. Tool parity with the hosted connector baseline captured in Appendix A, plus attachment and control tools.
5. Every Gmail mutation sits behind an editable, action-based `allow | ask | deny` policy that the server enforces. `ask` produces a human approval that no model can forge.

Non-goals for v1: multi-user tenancy, Google app verification and CASA, archive content scanning, Gmail permanent delete, downloading individual attachments larger than 25 MB, batch label or trash tools.

## 1. Architecture

### 1.1 Components

```
Claude (claude.ai / Desktop / Claude Code)
        │  MCP over Streamable HTTP, bearer token scope "mcp"
        ▼
┌──────────────────────────────────────────┐
│ Cloudflare Worker  (authority)           │
│  Gmail tools (38)                        │
│  Policy engine                           │
│  Confirmation engine                     │
│  Operation journal                       │
│  Google OAuth per account                │
│  Attachment staging                      │
│  Audit log                               │
│  Web pages: approve, policy, accounts,   │
│             audit, connect, logout       │
└──────┬─────────────┬──────────────┬──────┘
       │             │              │
       │             │              └── KV: workers-oauth-provider state,
       │             │                      OAuth state, OIDC nonce
       │             └── R2: temporary attachment bytes
       └── D1: users, accounts, policies, pending actions,
               operations, staging metadata, web sessions, audit
       ▼
   Gmail API (users.messages.*, users.drafts.*, users.labels.*, users.threads.*)

Claude Code / Desktop only
        │ stdio
        ▼
┌──────────────────────────────────────────┐
│ Local companion MCP (thin)               │
│  save_attachment  stage_file  list_roots │
│  bearer token scope "staging"            │
└──────────────┬───────────────────────────┘
               ▼
        Local filesystem, confined to configured roots
```

Rules:

- The Worker is the source of truth. Credentials, account selection, policy, approvals, operations, audit and attachment metadata live there.
- The companion knows nothing about Gmail. It moves bytes between staging handles and the filesystem and enforces the filesystem rules only it can enforce. Its uploads still pass through the Worker's policy engine (3.6).
- Gmail never talks to the companion. Attachments cross the boundary only through staging handles.
- Claude is not the authority. The MCP client is not the authority. Tool annotations are not the authority. The authenticated Worker policy engine is the authority.

### 1.2 Platform choices and pinned facts

| Choice | Fact it rests on | Source |
|---|---|---|
| MCP protocol 2026-07-28, stateless, with 2025 Streamable HTTP compatibility | Spec is stateless at the protocol layer; confirmations use `InputRequiredResult` multi-round-trip; URL-mode elicitation is the spec's mechanism for sensitive confirmations | modelcontextprotocol.io/specification/2026-07-28 |
| `createMcpHandler()` from Cloudflare's MCP package | Cloudflare marks `McpAgent` deprecated and feature-frozen | developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server |
| `@cloudflare/workers-oauth-provider` >= 0.10.2 | Supports CIMD (`clientIdMetadataDocumentEnabled: true`, requires `global_fetch_strictly_public` compatibility flag), always emits RFC 9207 `iss`, serves RFC 9728 metadata, accepts RFC 8707 `resource`, S256 PKCE by default. Does **not** enforce per-client scopes or operation-level scope policy | github.com/cloudflare/workers-oauth-provider |
| Workers Paid plan | Free plan allows 10 ms CPU per request. Request body limit 100 MB, isolate memory 128 MB | developers.cloudflare.com/workers/platform/limits |
| D1 for structured state | 2 MB row, string and BLOB limit; foreign keys enforced; `batch()` is a transaction that rolls back on any statement error, and there are no interactive transactions | developers.cloudflare.com/d1/platform/limits, developers.cloudflare.com/d1/sql-api/foreign-keys, developers.cloudflare.com/d1/worker-api/d1-database |
| SQLite partial unique indexes for nullable keys | Ordinary-table PRIMARY KEY columns may contain NULL; NULLs are distinct for uniqueness | sqlite.org/quirks.html, sqlite.org/partialindex.html |
| Attachments via `users.messages.attachments.get` | Returns JSON `MessagePartBody` with `data` as base64url, not raw bytes. Needs `gmail.readonly`, `gmail.modify` or `mail.google.com` | developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments |
| Sending via media or resumable upload of `message/rfc822` | `/upload/gmail/v1/users/me/messages/send`; resumable recommended for larger data | developers.google.com/workspace/gmail/api/guides/uploads |
| `gmail.modify` excludes permanent delete | `messages.delete` and `threads.delete` require `https://mail.google.com/` | developers.google.com/workspace/gmail/api/auth/scopes |
| 500 recipients per message | Gmail usage limits | developers.google.com/workspace/gmail/api/reference/quota |
| Claude Code supports elicitation (form and URL), speaks 2026-07-28 to HTTP servers on v2.1.232+, discovers CIMD automatically, uses RFC 8252 loopback with an ephemeral port | Claude Code MCP docs | code.claude.com/docs/en/mcp |
| claude.ai OAuth callback `https://claude.ai/api/mcp/auth_callback` | Anthropic connector docs | claude.com/docs/connectors/building/authentication |
| Google refresh tokens for an external app in Testing expire after 7 days unless only profile scopes are requested | Google OAuth docs | developers.google.com/identity/protocols/oauth2#expiration |
| Personal-use apps under 100 users need not complete OAuth verification; users still see the unverified flow and cap | Google Cloud Help | support.google.com/cloud/answer/13464323 |

Dated observation, not a design dependency: on 2026-09-09 the connector docs listed advanced capabilities as unsupported on claude.ai and Desktop. The design keys on advertised capabilities (1.4), never on product names.

### 1.3 Accounts

Each Google account gets an owner-chosen alias (`personal`, `university`, `work`), lower-case ASCII, unique per owner. Every write tool and `stage_file` require an explicit `account`. Read tools accept an optional `account` and fall back to the configured default. The model never guesses an account for a write.

### 1.4 Confirmation model

`ask` never means "do it and tell the user". It creates a pending action and returns without touching Gmail. Approval happens one of two ways:

1. **URL-mode elicitation** when the negotiated client capabilities include `elicitation.url`. The client opens the approval page and immediately retries the `tools/call` with an accept response. Per the spec the server may then block until the out-of-band approval completes: the Worker polls the pending row every 2 seconds for up to 120 seconds. If the row becomes `approved`, the Worker claims and executes in that same request and returns the real result. If it is still `pending` at the deadline, the Worker returns the ordinary `pending_approval` result (2.6) so the owner can finish in the browser and Claude can call `execute_pending` later. Declined or expired rows return an error.
2. **Approval URL in the tool result** otherwise. The owner opens it, approves in the browser, then Claude calls `execute_pending(id)`.

Both paths land on the same Worker page, which requires a browser session whose identity matches the pending row's owner. A model-relayed confirmation code is not an accepted approval path for any write.

Form-mode elicitation is used only for the companion's local `+overwrite` question when the client advertises `elicitation.form`. Otherwise overwrite is refused.

### 1.5 Threat model

In scope: malicious email content and prompt injection, malicious model output, stolen approval URL, cross-account confused deputy, replayed MCP calls, malicious OAuth client registration, CSRF, OAuth mix-up, stolen `mcp` bearer, stolen `staging` bearer, path traversal, symlink escape, network interruption, Worker crash mid-operation, duplicate delivery, malicious filenames and MIME headers, bidi and control characters in displayed text.

Out of scope: compromised local OS, compromised browser session, compromised Google account, compromised Cloudflare account or root secrets, Google or Cloudflare infrastructure compromise.

### 1.6 Honest bounds

- The approval page defeats model-initiated and injection-initiated writes. It does not defend against a compromised browser session.
- The server policy engine is the only enforcement layer. Client-side annotations are hints.
- Google app verification is out of scope. 4.4 explains how the deployment avoids the 7-day treadmill and what the personal-use exemption covers.
- Blocked-type checking is by filename. Gmail's scanner is authoritative.

## 2. Tool surface and action taxonomy

### 2.1 Actions and default policy

Policy keys on actions, not tool names. Values are `allow | ask | deny`.

| Action | Meaning | Default |
|---|---|---|
| `read.search` | search threads | allow |
| `read.message` | get message, thread, drafts, labels, attachment metadata | allow |
| `read.attachment` | fetch attachment bytes into staging | allow |
| `draft.write` | create or update a draft | allow |
| `send.message` | send new mail or reply | ask |
| `send.draft` | send an existing draft | ask |
| `send.forward` | forward an existing message | ask |
| `label.manage` | create, update, delete label definitions | ask |
| `label.apply` | add or remove labels on a message or thread | allow |
| `spam.mark` | mark spam | ask |
| `spam.unmark` | unmark spam | allow |
| `trash.move` | trash | ask |
| `trash.restore` | untrash | allow |
| `attachment.stage_upload` | upload a local file into staging | ask |
| `fs.save` | write staged bytes to disk (companion-enforced) | allow |
| `account.read` | list accounts and their health | allow |
| `account.connect` | connect or reconnect a Google account | ask, completes in browser only |
| `policy.read` | read effective policy | allow |
| `policy.edit` | change policy | browser only, no MCP tool |

Effective level: account override, else owner global, else default above.

### 2.2 Modifiers

Each modifier raises the effective level one step: `allow` becomes `ask`; `ask` and `deny` are unchanged. Modifiers never lower a level.

| Modifier | Applies to | Trigger |
|---|---|---|
| `+attachment` | `send.*` | any attachment present, including a draft's existing attachments |
| `+external` | `send.*` | any recipient outside the trusted set (2.8) |
| `+bulk` | `send.*` | more than 10 distinct recipients across To, Cc and Bcc |
| `+sensitive` | `label.apply` | target is a sensitive or system label |
| `+overwrite` | `fs.save` | destination file exists |

Label, trash and spam tools act on one message or thread per call in v1, so `+bulk` does not apply to them. Batch tools are a deferred item (6).

There is no permanent delete tool, and the requested Google scope cannot perform one.

### 2.3 Remote tools (38)

Names mirror the hosted connector baseline (Appendix A) where one exists.

| Tool | Action | Notes |
|---|---|---|
| `search_threads` | read.search | Gmail query syntax; `limit` default 20 max 50 (hosted parity); `page_token` |
| `get_thread` | read.message | `messageFormat` default `PLAIN_TEXT`; `max_messages`, `include_body`, `body_char_limit` |
| `get_message` | read.message | attachments as metadata: `attachmentId`, filename, mime, size |
| `list_drafts`, `get_draft`, `list_labels` | read.message | paginated |
| `download_attachment` | read.attachment | returns staging handle with filename, mime, size, sha256, `expires_at`, `account`. Bytes never enter a tool result. 25 MB ceiling |
| `create_draft`, `update_draft` | draft.write | `attachments: [handle]`; `inline_attachments` converted to staging handles before any row is written, 1 MB decoded total |
| `send_message` | send.message | new mail only; optional `idempotency_key`. No `draftId`, no thread parameters: replies go through `reply` |
| `reply` | send.message | canonical reply: `account`, `message_id`, body, optional extra recipients. The Worker derives `threadId`, `Subject`, `In-Reply-To`, `References` from the target message |
| `send_draft` | send.draft | `account`, `draft_id`; see 3.5 |
| `forward` | send.forward | `include_original_attachments` defaults to `false`; approval summary lists filenames and sizes |
| `create_label`, `update_label`, `delete_label` | label.manage | |
| `label_message`, `unlabel_message`, `label_thread`, `unlabel_thread`, `update_message_labels`, `apply_sensitive_message_label`, `apply_sensitive_thread_label` | label.apply | sensitive variants carry `+sensitive` |
| `mark_message_spam`, `mark_thread_spam` | spam.mark | |
| `unmark_message_spam`, `unmark_thread_spam` | spam.unmark | |
| `trash_message`, `trash_thread` | trash.move | |
| `untrash_message`, `untrash_thread` | trash.restore | |
| `list_accounts` | account.read | alias, email, scopes, status, default flag. Never tokens |
| `connect_account` | account.connect | returns URL-mode elicitation or the URL as text |
| `get_policy` | policy.read | effective policy for an account after overrides |
| `open_policy_editor` | policy.read | returns the policy page URL |
| `list_pending`, `execute_pending`, `cancel_pending` | confirmation engine | see 3.4 |

Every read result echoes `account`. Message, thread, draft and attachment identifiers are account-bound: a lookup includes `account_id` and `user_id` in the query, never as a post-check, and the schema enforces the pairing (3.2).

### 2.4 Companion tools (3)

| Tool | Action | Notes |
|---|---|---|
| `save_attachment` | fs.save | `handle`, optional `subdir`, optional `filename`. Resolves under a configured root; rejects `..`, path separators, NUL and symlink escape; Unicode-normalises the name; writes to a temp file, verifies sha256, atomic rename, then ACKs. `+overwrite` asks via form elicitation when advertised, otherwise refuses |
| `stage_file` | attachment.stage_upload | `account`, `path` under a root. Sends metadata first for the policy check (3.6), uploads bytes only on `allow`. 25 MB ceiling |
| `list_roots` | read | configured roots and free space |

Config: `~/.config/gmail-mcp/companion.json` with `roots`, `default_subdir`, `overwrite` (`ask` or `deny`). Companion token in macOS Keychain.

### 2.5 Annotations

Standard MCP hints, set truthfully and treated as hints only:

- `search_threads`, `get_*`, `list_*`, `get_policy`, `open_policy_editor`, `list_pending`, `list_roots`: `readOnlyHint: true`
- `download_attachment`: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false` (creates staging state)
- `send_message`, `reply`, `send_draft`, `forward`: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: true`
- `trash_*`, `unlabel_*`, `mark_*_spam`, `delete_label`: `destructiveHint: true`
- `untrash_*`, `unmark_*_spam`, `label_*`, `create_label`, `update_label`, `create_draft`, `update_draft`: `destructiveHint: false`
- `stage_file`: `readOnlyHint: false`, `openWorldHint: false`
- `save_attachment`: `readOnlyHint: false`, `destructiveHint: true`, `openWorldHint: false`

Not used: `_meta.anthropic/requiresUserInteraction` (forces a client prompt on every call and would override `allow`), `_meta.anthropic/maxResultSizeChars` (raises the persistence threshold; pagination handles size).

### 2.6 The `ask` result

```json
{
  "status": "pending_approval",
  "action_id": "pa_7f3c…",
  "action": "send.message",
  "modifiers": ["+external", "+attachment"],
  "account": "university",
  "summary": "To: prof@uni.edu.au · Subject: Thesis draft · 1 attachment (thesis.pdf, 2.1 MB)",
  "approval": { "mode": "url", "url": "https://gmail-mcp.example.workers.dev/approve/pa_7f3c…" },
  "expires_at": "2026-09-09T10:15:00+10:00"
}
```

### 2.7 Argument limits

| Field | Cap |
|---|---|
| subject | 998 bytes (RFC 5322 line limit) |
| body plus html body | 512 KB combined |
| recipients | 500 total, per Gmail |
| inline attachments | 1 MB decoded total, converted to handles before storage |
| staged file | 25 MB |
| aggregate attachments at send | account `send_limit_bytes`, default 25 MB |
| canonical argument JSON stored in `payload_json` | 1 MB |

Blocked extensions: `GMAIL_BLOCKED_EXTENSION_SET`, configuration seeded from Google's published list (about 50 entries including `exe dll bat cmd js jse vbs msi jar apk appx iso ps1 mjs msix lnk vhd xll`). Checked by filename on uploads at stage time and again at send time. Downloads to disk are sanitised but not filtered by this list, since it describes what Gmail refuses to send, not what the owner may save. Archives are not inspected.

### 2.8 Recipient trust rules for `+external`

- Addresses are parsed with a real RFC 5322 address parser. A malformed address fails the call before policy.
- Address comparison: local part and domain compared after the domain is lower-cased and converted to ASCII (Punycode). Gmail `+tag` suffixes are stripped for comparison. Dots in the local part are not normalised.
- Domain pattern `@example.com` matches `a@example.com` and nothing else. It does not match `a@evil-example.com` or `a@sub.example.com`.
- The trusted set is evaluated over the union of To, Cc and Bcc.
- Consumer Gmail account: trusted = the account's own address, its configured send-as aliases, and the allowlist.
- Workspace account: trusted = the above plus addresses whose domain is in `org_domains`.

## 3. Data model, confirmation engine, operations, tokens, staging

### 3.1 Identity root

`user_id` is the `sub` from the Worker's own OAuth token. It is never read from tool arguments.

### 3.2 D1 schema

Foreign keys are enforced. Every child table binds `(user_id, account_id)` to `accounts(user_id, id)` so ownership is a database invariant, not a query habit.

```sql
users (
  id TEXT PRIMARY KEY,                -- owner Google sub
  email TEXT NOT NULL, created_at INTEGER NOT NULL
);

accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  alias TEXT NOT NULL CHECK (length(alias) BETWEEN 1 AND 32 AND alias NOT GLOB '*[^a-z0-9_-]*'),
  google_sub TEXT NOT NULL,
  google_email TEXT NOT NULL,
  send_as TEXT NOT NULL DEFAULT '[]', -- JSON array of verified send-as addresses
  org_domains TEXT,                   -- JSON array, Workspace accounts only
  scopes TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','needs_reconnect','revoked')),
  is_default INTEGER NOT NULL DEFAULT 0,
  send_limit_bytes INTEGER NOT NULL DEFAULT 26214400,
  refresh_token_enc BLOB, refresh_token_key_id TEXT,
  access_token_enc BLOB,  access_token_key_id TEXT, access_expires_at INTEGER,
  created_at INTEGER NOT NULL, last_refresh_at INTEGER,
  UNIQUE (user_id, id),
  UNIQUE (user_id, alias),
  UNIQUE (user_id, google_sub)
);
CREATE UNIQUE INDEX accounts_one_default ON accounts(user_id) WHERE is_default = 1;

policies (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  account_id TEXT,                    -- NULL = owner global
  action TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('allow','ask','deny')),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);
CREATE UNIQUE INDEX policies_global_unique  ON policies(user_id, action) WHERE account_id IS NULL;
CREATE UNIQUE INDEX policies_account_unique ON policies(user_id, account_id, action) WHERE account_id IS NOT NULL;

contact_allowlist (
  user_id TEXT NOT NULL, account_id TEXT NOT NULL, pattern TEXT NOT NULL,  -- address or @domain
  PRIMARY KEY (account_id, pattern),
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);

operations (
  id TEXT PRIMARY KEY,                -- op_<random>
  user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  action TEXT NOT NULL,
  idempotency_key TEXT,
  state TEXT NOT NULL CHECK (state IN ('claimed','executing','delivery_unknown','executed','failed_safe')),
  payload_hash TEXT NOT NULL,
  rfc822_message_id TEXT,
  gmail_result_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);
CREATE UNIQUE INDEX operations_idempotency
  ON operations(user_id, account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

pending_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  action TEXT NOT NULL, modifiers TEXT NOT NULL,
  payload_json TEXT,                  -- nulled on terminal states
  payload_hash TEXT NOT NULL,
  summary TEXT NOT NULL,              -- redacted after terminal state
  state TEXT NOT NULL CHECK (state IN ('pending','approved','executing','executed','failed',
                                       'denied','cancelled','expired')),
  operation_id TEXT REFERENCES operations(id),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  approved_at INTEGER, approved_via TEXT,     -- 'elicitation' | 'browser'
  executed_at INTEGER, error TEXT,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);

staging_objects (
  handle TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('download','upload')),
  r2_key TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  source_message_id TEXT, source_attachment_id TEXT,
  reserved_by_operation_id TEXT REFERENCES operations(id),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);

_assert (x INTEGER NOT NULL CHECK (x = 0));   -- never holds rows; see 3.4

web_sessions (
  id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, authenticated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);

audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL, user_id TEXT, account_id TEXT,
  tool TEXT, action TEXT, modifiers TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('intent','outcome')),
  decision TEXT,                      -- allow | ask | deny | approved | denied | executed | failed | delivery_unknown
  pending_id TEXT, operation_id TEXT, gmail_result_id TEXT,
  summary TEXT,                       -- redacted: counts and ids, no bodies, no full subjects
  client_hint TEXT
);
```

KV holds only `workers-oauth-provider` state (client registrations, grants, its tokens) and OAuth `state` plus OIDC `nonce` entries with 600 s TTL. CSRF tokens are not stored anywhere (4.6).

### 3.3 Token encryption and refresh

- Keyring: Worker secret `TOKEN_KEKS` is a JSON object `{ "<key_id>": "<base64 32 bytes>", … }`; secret `TOKEN_KEK_CURRENT` names the key used for new writes. Old keys stay in the ring until every ciphertext using them has been re-encrypted, which happens lazily on next use, per ciphertext (`*_key_id` columns).
- AES-256-GCM via WebCrypto, fresh 12-byte IV, stored as `iv || ciphertext || tag`.
- AAD is canonically framed: `"gmail-mcp:v1" \0 user_id \0 account_id \0 field_name`.
- Access tokens are cached encrypted with expiry. On `invalid_grant`, the account flips to `needs_reconnect`; the next tool call on that account returns a URL-mode elicitation to `/connect?alias=…`.
- Tokens never appear in tool results, audit rows or logs.

### 3.4 Canonical arguments and the confirmation state machine

Canonicalisation: arguments are schema-validated, defaults applied, inline attachments converted to staging handles, then serialised with RFC 8785 JSON Canonicalization Scheme. `payload_hash = sha256(canonical bytes)`. The implementation ships test vectors.

```
pending ─approve(elicitation|browser)─▶ approved ─claim─▶ executing ─▶ executed
   │                                       │                   └─▶ failed
   ├─ decline ─▶ denied                    └─ ttl ─▶ expired
   ├─ cancel_pending ─▶ cancelled
   └─ ttl 15 min ─▶ expired
```

Invariants:

- **Payload is server-held.** The `ask`-hit call stores canonical arguments as `payload_json`. The approval page renders from the row. Later model output cannot change what executes.
- **Approval binds identity.** Browser approval requires a `web_sessions` row whose `user_id` equals the pending row's. Elicitation approval carries an HMAC-signed `requestState` (secret `STATE_HMAC_KEY`) with `version="gmail-mcp:approval:v1"`, `pending_id`, `user_id`, `account_id`, `payload_hash`, `expires_at`, `nonce`, verified against the bearer token on the retried call.
- **Resume re-hashes.** The retried `tools/call` arguments are canonicalised and compared to `payload_hash`. Mismatch is denied and audited.
- **Claim is one atomic batch.** D1 `batch()` runs its statements as one transaction and rolls back the whole sequence if any statement errors, but it does not roll back on a zero-row update. The claim therefore uses an assertion table `_assert (x INTEGER NOT NULL CHECK (x = 0))` to convert a failed precondition into an error. Statement order, all in one batch: (1) `INSERT INTO operations (id, …, state='claimed', payload_hash)`; (2) `UPDATE pending_actions SET state='executing', operation_id=?, executed_at=? WHERE id=? AND user_id=? AND state='approved' AND expires_at > ?`; (3) `INSERT INTO _assert SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM pending_actions WHERE id=? AND operation_id=? AND state='executing')`; (4) reserve staging handles (3.7); (5) `INSERT INTO _assert SELECT 1 WHERE (SELECT count(*) FROM staging_objects WHERE reserved_by_operation_id=?) != ?`. Statements 3 and 5 insert a row only when the precondition failed, the CHECK rejects it, and the batch rolls back including the operation row. Zero rows in statement 2 means replayed, expired or never approved. Foreign keys are immediate, which is why the operation row is inserted before the pending row references it.
- **Policy is re-evaluated at claim.** A tighter policy saved between approval and execution wins.
- **One approval covers one action.**
- **Terminal purge.** On any terminal state `payload_json` is set to NULL and `summary` replaced by a redacted form. The linked operation, not the pending row, carries delivery state from here on.

### 3.5 Operations: every external mutation gets a journal row

`operations` is the journal of non-idempotent external side effects. An operation exists whether or not the caller supplied an `idempotency_key`. The key is a secondary uniqueness constraint used only to short-circuit retries.

Journaled actions: `send.message`, `send.draft`, `send.forward`, `draft.write` (create only), `label.manage` (create only). Label apply, trash, spam and updates are naturally reconcilable and are not journaled.

Execution of a journaled action:

1. **Acquire.** If an `idempotency_key` is present and a row already exists: `executed` returns the stored result without calling Gmail; `executing`, `claimed` or `delivery_unknown` returns `delivery_unknown` without calling Gmail; `failed_safe` allows a fresh operation. `ask` actions use the pending id as the key. Otherwise insert a new `claimed` row.
2. **Reserve** attachments (3.7), move to `executing`.
3. **Send.** For new messages and replies: generate `rfc822_message_id` (`<op_…@<worker hostname>>`), set `Message-ID`, build MIME as a stream (3.8). Set the operation to `executing` immediately before the request to Google is opened, not earlier, so a stale `claimed` row is provably free of side effects. Upload via media upload when the MIME is 5 MB or smaller, resumable upload otherwise. For `send_draft`: read the draft's message id and thread id, then call `drafts.send`.
4. **Record.** On success write `gmail_result_id`, state `executed`, consume reserved handles.
5. **Crash or ambiguity.** If Gmail may have received the request body and no definitive response was recorded, the row stays `executing`. The cron promotes `executing` rows older than 2 minutes to `delivery_unknown` and `claimed` rows older than 2 minutes to `failed_safe` (no request was ever opened). Reserved handles stay reserved on `delivery_unknown` and are released on `failed_safe`.
6. **Reconciliation.** For messages sent with our `Message-ID`, search `rfc822msgid:<id>`; if found, mark `executed`. For `send_draft`, list `SENT` messages in the recorded thread newer than the operation start. Gmail search indexing can lag, so the cron retries reconciliation on each run for up to 24 hours before leaving the row `delivery_unknown` for the owner. Automatic reconciliation is enabled only after the Message-ID preservation test (4.7) passes. Until then `delivery_unknown` is surfaced to the owner and never auto-retried:

```json
{ "status": "delivery_unknown", "operation_id": "op_…",
  "message": "The Gmail request may have succeeded. Do not retry automatically." }
```

There is no content-based dedupe. Identical content sent twice on purpose is two operations.

### 3.6 Upload policy path (companion to Worker)

`stage_file(account, path)` does not upload first. The companion reads filename, size and mime, then:

1. `POST /staging/intent` with `{account, filename, size, mime, sha256}`. The Worker runs the policy engine for `attachment.stage_upload`.
2. `allow`: response carries a one-time upload ticket (60 s TTL, bound to the metadata hash). `deny`: 403 with the audited reason. `ask`: response is the standard pending action; the companion surfaces it as a URL-mode elicitation when advertised, else returns the approval URL as text. After approval the companion calls `POST /staging/intent` again with the pending id; ticket issuance is the same atomic `approved → executing` claim as 3.4, so a pending stage action yields exactly one ticket. A `PUT` whose computed sha256 differs from the ticket's declared hash is rejected and the ticket is void.

The companion must speak both elicitation wire forms: the 2026-07-28 `InputRequiredResult` and the 2025 server-initiated `elicitation/create`, because Claude Code negotiates the new revision with stdio servers only when `MCP_PROTOCOL_NEGOTIATION=auto`.
3. `PUT /staging/<ticket>` streams the bytes. The Worker enforces the 25 MB ceiling by `Content-Length` and by counting, rejects blocked extensions, computes sha256 with `tee()` into `R2.put` and `crypto.DigestStream("SHA-256")`, verifies it matches the declared hash, writes the account-bound row.

### 3.7 Staging handle lifecycle

Handle: `sh_` plus 32 random bytes base64url. Non-enumerable, carries no Google identifiers.

Download: `download_attachment` first reads the part's `size` from message metadata and refuses anything above 25 MB before any bytes move. It then calls `attachments.get`, which returns JSON with base64url `data`. V1 buffers the response (at most about 34 MB of text plus 25 MB decoded, within the 128 MB isolate), decodes, streams the bytes with `tee()` into R2 and the digest, writes the row with `expires_at = now + 30 min`. The 25 MB Worker round-trip test in 4.7 is an implementation gate for this choice. The companion fetches `GET /staging/<handle>` with its `staging` bearer; the Worker checks `user_id` in the query and expiry, streams from R2. Re-fetch before ACK is allowed. After temp write, sha256 verify and atomic rename, the companion `POST /staging/<handle>/ack` sets `consumed_at`.

Hold at pending creation: when an `ask` action references upload handles, the same request extends each referenced handle's `expires_at` to the pending row's `expires_at` plus 5 minutes, so a handle staged 29 minutes earlier cannot expire between approval and execution.

Reservation at send: inside the claim batch, `UPDATE staging_objects SET reserved_by_operation_id=? WHERE handle IN (…) AND user_id=? AND account_id=? AND direction='upload' AND consumed_at IS NULL AND reserved_by_operation_id IS NULL AND expires_at > ?`; the batch fails unless the row count equals the handle count. `executed` consumes; `failed_safe` releases; `delivery_unknown` keeps the reservation until reconciled or expired.

Purge: cron every 5 minutes expires stale pending rows, promotes stuck `executing` operations, deletes expired unreserved staging objects from R2 and D1, and deletes audit rows older than 90 days. An R2 lifecycle rule on `stg/` deleting objects one day after creation is the eventual backstop.

### 3.8 MIME and header safety

- MIME is built with a maintained library that streams. Headers are never concatenated by hand.
- Subject, recipient display names, attachment filenames and aliases are rejected if they contain CR, LF or NUL. Non-ASCII header values use RFC 2047 encoding; filenames use RFC 2231.
- Local filenames written by the companion: basename only, no `/`, `\`, `..` or NUL, NFC-normalised, Unicode control and bidi characters replaced with `_`.
- Anywhere the approval page shows attacker-influenced text, bidi and control characters are rendered as visible escapes.

### 3.9 Error handling

| Condition | Behaviour |
|---|---|
| Google 401 | refresh once, retry once; `invalid_grant` flips the account to `needs_reconnect` |
| Google 429 or 403 rate limit | exponential backoff with jitter, honour `Retry-After`, at most 3 tries, and never retry a send after the request body has started |
| Google 5xx before the send body is sent | retry as above |
| Timeout or 5xx after the send body may have reached Gmail | operation stays `executing`, becomes `delivery_unknown` |
| D1 error before any Gmail side effect | bounded retry, then `failed_safe` |
| D1 error after a Gmail side effect | return the Gmail result as `executed`, log the write failure to Workers observability, reconcile from the journal on next cron |
| Gmail rejects an attachment | surface the Gmail error verbatim as the tool error |

### 3.10 Audit semantics

Two rows per mutating call: an `intent` row before any external side effect (tool, action, modifiers, decision), and an `outcome` row after. Read calls and denials write one `intent` row only. The operation journal, not the audit log, is authoritative for delivery. If the outcome write fails after Gmail succeeded, the tool still returns `executed` and the failure is reported to telemetry. Metadata only: no bodies, no full subjects, no tokens. Readable through `/audit`, never through an MCP tool.

## 4. OAuth flows, web UI, session security, testing

### 4.1 Tokens and audiences

| Holder | Scope | May call | Obtained via |
|---|---|---|---|
| Claude clients | `mcp` | `/mcp` only | Flow A |
| Companion | `staging` | `/staging/*` only | Flow C |
| Owner's browser | session cookie | `/approve`, `/policy`, `/accounts`, `/audit`, `/connect`, `/logout` | Google OIDC login |

Per-client allowed scopes are enforced by our authorization handler, since the library does not: the pre-registered `companion` client may receive only `staging`; CIMD and DCR clients may receive only `mcp`; a request for any other combination is rejected before consent. Every API route additionally checks the token's scope and RFC 8707 audience. Google Gmail refresh tokens are held only by the Worker (Flow B).

### 4.2 Flow A: Claude to Worker

- `OAuthProvider` with `clientIdMetadataDocumentEnabled: true`, `allowPlainPKCE: false`, `resourceMetadata.resource` set to the canonical `/mcp` URL, and the `global_fetch_strictly_public` compatibility flag. It mounts `/authorize`, `/token`, `/register` and serves both well-known documents.
- Registration: Claude clients use CIMD when they offer it, DCR as deprecated compatibility. The companion is pre-registered. This matches the library's stated preference order.
- Redirect URIs: exact scheme, host and path match against the client's own registration. Loopback clients vary the port per RFC 8252 §7.3. The claude.ai client's registered URI is `https://claude.ai/api/mcp/auth_callback`. Claude Code registers `http://localhost:PORT/callback` (and used `127.0.0.1` in one release), so both loopback hosts are accepted for its registration. No wildcard allowlist exists.
- Consent page per Cloudflare guidance: sanitised client name and redirect URI, CSRF token, approved-clients cookie. Then Google OIDC with `openid email profile` only, `state` and one-use `nonce` in KV. On return verify `id_token` signature, `iss`, `aud`, `exp`, `iat`, `nonce`, `email_verified == true`. Require `sub ∈ OWNER_GOOGLE_SUBS`. Complete the grant with `props = { sub, email }`.
- Bootstrap: when `OWNER_GOOGLE_SUBS` is empty and `email ∈ OWNER_EMAILS`, the setup page displays the `sub` to paste into the secret. `OWNER_EMAILS` is display and bootstrap only.
- Profile-only scopes exempt this identity login from the 7-day Testing expiry.

### 4.3 Flow B: Worker to Google per account

- Entry: `connect_account(alias)` returns URL-mode elicitation to `/connect?alias=…&e=<signed elicitation id>`, or the Accounts page. `/connect` requires a session whose `user_id` matches.
- Scopes: `https://www.googleapis.com/auth/gmail.modify` plus `openid email`. `mail.google.com` is never requested, so permanent deletion is impossible at the scope level as well as the tool level.
- `access_type=offline`, `prompt=consent`, `state` and `nonce` in KV bound to a hash of the session id, 600 s TTL.
- Callback: verify `state`, exchange code, verify `id_token`, upsert `accounts` on `(user_id, google_sub)`, fetch verified send-as addresses into `send_as`, encrypt tokens, audit `account.connect`. Revoke calls Google's revocation endpoint, wipes ciphertexts, marks `revoked`.

### 4.4 Google Cloud projects

| Project | Publishing status | Used by |
|---|---|---|
| `gmail-mcp-dev` | Testing | scratch Gmail account, integration tests. 7-day refresh expiry accepted, so the protected suite is manual only, run after a fresh consent |
| `gmail-mcp-personal` | In production, unverified, personal-use exemption | the owner's real accounts |

The verification and CASA exclusion holds only while this remains a personal-use system under 100 users known to the owner. General distribution changes the requirement: server-side storage of restricted-scope data then requires a third-party security assessment.

### 4.5 Flow C: Companion to Worker

`gmail-mcp-companion login` runs PKCE against the Worker's AS as the pre-registered public client `companion`, redirect `http://127.0.0.1:<ephemeral>/callback`, same Google OIDC identity step, token scope `staging` only. Access and refresh tokens in macOS Keychain via the `security` CLI. Staging routes check the bearer's `sub` against `staging_objects.user_id` inside the query.

### 4.6 Web pages and session security

Server-rendered HTML forms, no client JavaScript, no third-party assets.

| Page | Purpose | Guards |
|---|---|---|
| `/approve/<id>` | structured block (action, account, recipients, attachments with sizes) then a visibly delimited "untrusted email content" block with a plain-text body preview capped at 2 KB, no links; Approve and Deny | session match, CSRF, `Origin` check, POST is the atomic `pending → approved` transition (`WHERE state='pending' AND expires_at > now`); execution happens only through the claim in 3.4 |
| `/reauth` | re-run Google OIDC and update `authenticated_at` on the current session | session, CSRF |
| `/accounts` | list, connect, reconnect, revoke, set default, allowlist, send limit, org domains | session, CSRF, recent-auth for revoke |
| `/policy` | action × level matrix, per-account overrides, blocked-extension set | session, CSRF, recent-auth, audited as `policy.edit` |
| `/audit` | 90-day metadata log with filters | session |
| `/logout` | revoke current session | CSRF |

Session: `__Host-session` = 256-bit random opaque value; `web_sessions.id_hash` stores its sha256. HttpOnly, Secure, SameSite=Lax. Rotated after login. Absolute lifetime 12 h, idle timeout 2 h. Logout revokes immediately. Recent authentication means `authenticated_at` within the last 15 minutes; `last_seen_at` never counts. Policy edits and account revocations require recent authentication and revoke all other sessions.

CSRF: stateless per-form token = HMAC (secret `CSRF_HMAC_KEY`) over `session_id || method || route || object_id || expiry`, delivered in the form and recomputed on POST. A token for `/approve/A` cannot approve `/approve/B`.

Response headers on every page:

```
Cache-Control: no-store
Pragma: no-cache
Referrer-Policy: no-referrer
Content-Security-Policy: default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'
X-Content-Type-Options: nosniff
```

### 4.7 Testing matrix

**Normal CI (no real Gmail credentials)**

- Unit, Vitest in the Workers runtime via the Cloudflare vitest pool:
  - policy engine, table-driven over every action × level × modifier, including consumer vs Workspace `+external`, `+tag` stripping, Punycode domains, `@domain` boundary cases
  - state machine and operations: no sequence reaches `executed` twice; two concurrent claims yield one success; same idempotency key returns the first result and never calls the fake Gmail twice; global policy duplicate insert rejected; account and user FK mismatch rejected
  - crypto: decrypt fails on AAD mismatch, unknown key id, truncated ciphertext; keyring rotation re-encrypts lazily
  - handles: cross-account, cross-user, expired, reserved, ACK after TTL all rejected; same handle in two sends yields one reservation
  - argument limits: over-cap body, 501 recipients, 1 MB-plus inline attachments, 1 MB-plus canonical payload all rejected before any row is written
  - blocked extensions: every seeded entry rejected at intent and at send
  - companion: traversal, symlink escape, overwrite without approval refused; sha mismatch deletes the temp file; bidi and control filenames sanitised; upload proceeds only with a valid ticket
- Workers integration against a fake Gmail HTTP adapter: full tool round-trips, `ask` result shape, approval page POST, elicitation resume, `send_draft` path, media vs resumable upload selection at the 5 MB boundary, 25 MB MIME streamed without exceeding memory.
- **Fault injection** at each checkpoint, killing or throwing deliberately: operation inserted; pending action claimed; attachments reserved; MIME construction begins; Google request headers sent; Google request body partially sent; Google response received; before D1 success write; after D1 success write; before audit outcome write. For each, assert either no duplicate external side effect or `delivery_unknown` with no automatic retry.
- OAuth and web adversarial: redirect_uri substitution, authorization-code replay, `state` replay, `nonce` replay, issuer mix-up, wrong audience, expired `id_token`, session fixation, CSRF token from another pending action, open-redirect attempts, CIMD metadata tampering, a DCR client requesting `staging`, `mcp` token to `/staging`, `staging` token to `/mcp`, `execute_pending` replay, `requestState` field tampering one field at a time, retried elicitation call with changed recipients, approval URL opened under a different session, `last_seen_at` alone attempting a recent-auth action.

**Protected Gmail integration (manual pre-release only; never on forks)**

- Dedicated scratch Gmail account in `gmail-mcp-dev`, secret only in the protected environment, mailbox holds no real mail.
- Send with a staged attachment, fetch it back, sha256 matches.
- **Message-ID preservation gate**: send with a supplied `Message-ID`, search `rfc822msgid:`, must match. Reconciliation in 3.5 is enabled only if this passes.
- `send_draft` round-trip and its thread-based reconciliation.
- Revoke the token in Google; next call flips to `needs_reconnect` and returns a URL elicitation.
- **25 MB download and 25 MB send round-trips** within Workers Paid CPU and memory limits. This is the implementation gate for the buffering decision in 3.7.
- Reply threading: `reply` produces a message Gmail shows in the original thread.

**End to end**

- MCP Inspector against `/mcp` for auth and schemas.
- Claude Code: `ask` via native URL-mode elicitation; companion save, stage with `allow` and with `ask`.
- Claude Desktop: `ask` via approval link then `execute_pending`; companion save; overwrite refused.
- claude.ai: `ask` via approval link then `execute_pending`; no companion.

Every adversarial test records both outcomes. A caught abuse is evidence the gate works.

## 5. Repository layout

```
gmail/
  shared/            contracts used by both halves
    src/schemas/     zod schemas for tool inputs, staging responses, upload metadata
    src/actions.ts   action and modifier names
    src/errors.ts    error codes
  worker/            Cloudflare Worker
    src/tools/       one module per Gmail tool family
    src/policy/      engine, modifiers, defaults, recipient trust
    src/approval/    state machine, requestState, pages
    src/operations/  journal, send pipeline, reconciliation
    src/staging/     intent, tickets, R2 ingest, handles, ACK, reservation
    src/crypto/      AES-GCM keyring, AAD framing, JCS
    migrations/      D1
    test/
  companion/         stdio MCP: save_attachment, stage_file, list_roots, login CLI
    test/
  docs/superpowers/specs/2026-09-09-gmail-mcp-design.md   (this file)
  docs/parity/hosted-2026-09-09.json                       (Appendix A schemas, captured in plan task 0)
```

TypeScript throughout. MCP and OAuth dependencies pinned to exact versions. Worker uses Cloudflare's MCP package and `@cloudflare/workers-oauth-provider` >= 0.10.2. Companion uses the MCP TypeScript SDK 2.x over stdio.

## 6. Deferred (signed IOUs)

- Batch label, trash and spam tools, with `+bulk` applied to them.
- `search_threads(account="all")` fan-out across accounts.
- Companion as a full local proxy re-exposing every tool with path parameters (Approach B).
- Multi-user signup replacing `OWNER_GOOGLE_SUBS`.
- Gmail app verification and CASA.
- Streaming base64url extraction for downloads above 25 MB.

Retired: the `X-Claude-Audit-Id` header on sent mail. An internal audit id has no business travelling to recipients' mail servers.

## 7. Scorecard (design stage, revision 2)

| Axis | Score | What moves it higher |
|---|---|---|
| Authority boundary clarity | 9 | proven by the adversarial and fault-injection suites passing |
| Delivery correctness under failure | 8 | Message-ID preservation gate passing enables reconciliation |
| Attachment UX from Claude Code | 7 | Approach B proxy would make download and attach one step |
| Google token lifecycle robustness | 7 | personal Production project confirmed in practice to avoid the 7-day expiry |
| Reproducibility of security claims | 9 | every invariant has a named test; sealed results |

## Appendix A: hosted connector baseline (captured 2026-09-09)

Tool names observed on the hosted Claude Gmail connector this date. Input and output schemas are captured verbatim into `docs/parity/hosted-2026-09-09.json` as the first implementation task; parity below is at the level of name and purpose, and the schema file is the contract the tests check.

| Hosted tool | Ours | Status |
|---|---|---|
| `search_threads`, `get_thread`, `get_message`, `list_drafts`, `get_draft`, `list_labels` | same | parity, plus pagination and size parameters |
| `create_draft`, `update_draft` | same | parity; attachments become handles, inline capped |
| `send_message` | same | new mail only: `draftId` moved to `send_draft`, `replyThreadId` and `replyToMessageId` moved to `reply` |
| `reply` | same | parity; Worker derives threading headers from the target message |
| `forward` | same | parity except original attachments excluded by default |
| `create_label`, `update_label`, `delete_label` | same | parity |
| `label_message`, `unlabel_message`, `label_thread`, `unlabel_thread`, `update_message_labels` | same | parity |
| `apply_sensitive_message_label`, `apply_sensitive_thread_label` | same | parity, carries `+sensitive` |
| `mark_message_spam`, `mark_thread_spam`, `unmark_message_spam`, `unmark_thread_spam` | same | parity |
| `trash_message`, `trash_thread`, `untrash_message`, `untrash_thread` | same | parity |
| — | `download_attachment` | extension |
| — | `send_draft` | extension (replaces hosted `send_message(draftId)`) |
| — | `list_accounts`, `connect_account`, `get_policy`, `open_policy_editor` | extension |
| — | `list_pending`, `execute_pending`, `cancel_pending` | extension |

Hosted count 29. Ours 38. Intentional omissions: none.
