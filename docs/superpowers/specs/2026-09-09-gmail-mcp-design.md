# Gmail MCP for Claude: design

Date: 2026-09-09
Status: approved design, pre-implementation
Owner: Raouf (raoof.r12@gmail.com)

## 0. Problem and goal

The hosted Claude Gmail connector exposes about 30 tools but has no tool that returns attachment bytes. `get_message` returns attachment names and IDs only. Sending accepts attachments only as base64 inlined in the tool call, which is unusable beyond a few hundred kilobytes. ChatGPT's Gmail connector reads attachment text but cannot send attachments at all.

Goal: a Gmail MCP server for Claude that

1. runs remotely on Cloudflare so it works from claude.ai, Claude Desktop and Claude Code,
2. downloads attachments to the user's disk and attaches files from disk, the way a local Codex plugin does,
3. supports several Google accounts for one owner,
4. reaches full tool parity with the hosted connector,
5. puts every Gmail mutation behind an editable, action-based `allow | ask | deny` policy that the server enforces, where `ask` produces a human approval that no model can forge.

Non-goals for v1: multi-user tenancy, Google app verification and CASA, archive content scanning, Gmail permanent delete.

## 1. Architecture

### 1.1 Components

```
Claude (claude.ai / Desktop / Claude Code)
        │  MCP over Streamable HTTP, bearer token scope "mcp"
        ▼
┌──────────────────────────────────────────┐
│ Cloudflare Worker  (authority)           │
│  Gmail tools (37)                        │
│  Policy engine                           │
│  Confirmation engine                     │
│  Google OAuth per account                │
│  Attachment staging                      │
│  Audit log                               │
│  Web pages: approve, policy, accounts,   │
│             audit, connect               │
└──────┬─────────────┬──────────────┬──────┘
       │             │              │
       │             │              └── KV: workers-oauth-provider grants,
       │             │                      OAuth state, CSRF
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

- The Worker is the source of truth. Credentials, account selection, policy, approvals, audit and attachment metadata live there.
- The companion knows nothing about Gmail. It moves bytes between staging handles and the filesystem and enforces filesystem rules that only it can enforce.
- Gmail never talks to the companion. Attachments cross the boundary only through staging handles.
- Claude is not the authority. The MCP client is not the authority. Tool annotations are not the authority. The authenticated Worker policy engine is the authority.

### 1.2 Platform choices and pinned facts

| Choice | Fact it rests on | Source |
|---|---|---|
| MCP protocol 2026-07-28, stateless, with 2025 Streamable HTTP compatibility | Spec is stateless at the protocol layer; confirmations use `InputRequiredResult` multi-round-trip | modelcontextprotocol.io/specification/2026-07-28 |
| `createMcpHandler()` from Cloudflare's MCP package | Cloudflare marks `McpAgent` deprecated and feature-frozen | developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server |
| `workers-oauth-provider` as the Worker's authorization server | Cloudflare's documented pattern: OAuth server to MCP clients, OAuth client to Google | developers.cloudflare.com/agents/model-context-protocol/authorization |
| Workers Paid plan | Free plan allows 10 ms CPU per request; decoding a 25 MB base64url attachment exceeds it. Request body limit 100 MB, isolate memory 128 MB | developers.cloudflare.com/workers/platform/limits |
| D1 for structured state | 2 MB row limit, 10 GB database on Paid | developers.cloudflare.com/d1/platform/limits |
| Attachments via `users.messages.attachments.get` | Returns `MessagePartBody.data` as base64url; needs `gmail.readonly`, `gmail.modify` or `mail.google.com`. `gmail.compose` is insufficient | developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments |
| Claude Code supports elicitation (form and URL), speaks 2026-07-28 to HTTP servers on v2.1.232+, supports CIMD | Claude Code MCP docs | code.claude.com/docs/en/mcp |
| claude.ai and Desktop do not support elicitation | Connector docs list advanced capabilities as not supported; open issues confirm | claude.com/docs/connectors/building |
| claude.ai OAuth callback `https://claude.ai/api/mcp/auth_callback` | Anthropic connector docs | claude.com/docs/connectors/building |
| Google refresh tokens for an external app in Testing expire after 7 days unless only profile scopes are requested | Google OAuth docs | developers.google.com/identity/protocols/oauth2#expiration |

Reported, not pinned from a primary page: an unverified app set to "In production" with the personal-use exemption keeps the unverified warning screen and user cap but is not subject to the 7-day expiry. The design does not depend on this; the reconnect flow in 3.3 covers refresh failure regardless.

### 1.3 Accounts

Each Google account gets an owner-chosen alias (`personal`, `university`, `work`). Every write tool requires an explicit `account`. Read tools accept an optional `account` and fall back to the configured default. The model never guesses an account for a write.

### 1.4 Confirmation model

`ask` never means "do it and tell the user". It creates a pending action and returns without touching Gmail. Approval happens one of two ways:

1. **URL-mode elicitation** when the client advertises `elicitation.url` in `_meta.io.modelcontextprotocol/clientCapabilities`. Claude Code opens the approval page; the retried `tools/call` resumes with the result.
2. **Approval URL in the tool result** for clients without elicitation (claude.ai, Desktop). The user opens it, approves in the browser, then Claude calls `execute_pending(id)`.

Both paths land on the same Worker page, which requires a browser session whose identity matches the pending row's owner. A model-relayed confirmation code is not an accepted approval path for any write.

Form-mode elicitation is used only for the companion's local `+overwrite` question in Claude Code. In Desktop, overwrite is refused.

### 1.5 Honest bounds

- The approval page defeats model-initiated and injection-initiated writes. It does not defend against a compromised browser session on the owner's own machine.
- The server policy engine is the only enforcement layer. Client-side annotations are hints and are not relied on.
- Google app verification is out of scope. See 4.4 for how the deployment avoids the 7-day treadmill and what the personal-use exemption does and does not cover.

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
| `send.forward` | forward an existing message | ask |
| `label.manage` | create, update, delete label definitions | ask |
| `label.apply` | add or remove labels on messages or threads | allow |
| `spam.mark` | mark spam | ask |
| `spam.unmark` | unmark spam | allow |
| `trash.move` | trash | ask |
| `trash.restore` | untrash | allow |
| `attachment.stage_upload` | upload a local file into staging | ask |
| `fs.save` | write staged bytes to disk (companion) | allow |
| `account.read` | list accounts and their health | allow |
| `account.connect` | connect or reconnect a Google account | ask, completes in browser only |
| `policy.read` | read effective policy | allow |
| `policy.edit` | change policy | browser only, no MCP tool |

Effective level: account override, else owner global, else default above.

### 2.2 Modifiers

Each modifier raises the effective level one step: `allow` becomes `ask`; `ask` and `deny` are unchanged. Modifiers never lower a level.

| Modifier | Applies to | Trigger |
|---|---|---|
| `+attachment` | `send.*` | any attachment present |
| `+external` | `send.*` | any recipient outside the trusted set. Workspace account: trusted = configured organisation domains plus allowlist. Consumer Gmail: trusted = the account's own address plus allowlist. Everything else is external |
| `+bulk` | `label.apply`, `trash.move`, `spam.mark` | more than 10 items in one call |
| `+sensitive` | `label.apply` | target is a sensitive or system label |
| `+overwrite` | `fs.save` | destination file exists |

There is no permanent delete tool. Nothing in the server calls `messages.delete` or `threads.delete`.

### 2.3 Remote tools (37)

Names mirror the hosted connector where one exists.

| Tool | Action | Notes |
|---|---|---|
| `search_threads` | read.search | Gmail query syntax; `limit` default 20 max 100; `page_token` |
| `get_thread` | read.message | `messageFormat` default `PLAIN_TEXT`; `max_messages`, `include_body`, `body_char_limit` |
| `get_message` | read.message | attachments returned as metadata: `attachmentId`, filename, mime, size |
| `list_drafts`, `get_draft`, `list_labels` | read.message | paginated |
| `download_attachment` | read.attachment | returns staging handle with filename, mime, size, sha256, `expires_at`, `account`. Bytes never enter a tool result |
| `create_draft`, `update_draft` | draft.write | `attachments: [handle]`; `inline_attachments` for Claude-generated files, 1 MB total cap |
| `send_message` | send.message | new, reply via `replyThreadId`, or `draftId`; optional `idempotency_key` |
| `reply` | send.message | convenience wrapper |
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

Every read result echoes `account`. Message, thread, draft and attachment identifiers are account-bound: a lookup includes `account_id` and `user_id` in the query, never as a post-check.

### 2.4 Companion tools (3)

| Tool | Action | Notes |
|---|---|---|
| `save_attachment` | fs.save | `handle`, optional `subdir`, optional `filename`. Resolves under a configured root; rejects `..` and symlink escape; writes to a temp file, verifies sha256, atomic rename, then ACKs the handle. `+overwrite` asks via form elicitation in Claude Code, refuses in Desktop |
| `stage_file` | attachment.stage_upload | `path` under a root; streams to Worker staging; 25 MB ceiling; returns handle |
| `list_roots` | read | configured roots and free space |

Config: `~/.config/gmail-mcp/companion.json` with `roots`, `default_subdir`, `overwrite` (`ask` or `deny`). Companion token in macOS Keychain.

### 2.5 Annotations

Standard MCP hints, set truthfully and treated as hints only:

- reads and `download_attachment`: `readOnlyHint: true`
- `send_message`, `reply`, `forward`: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: true`
- `trash_*`, `unlabel_*`, `mark_*_spam`, `delete_label`: `destructiveHint: true`
- `untrash_*`, `unmark_*_spam`, `label_*`, `create_label`: `destructiveHint: false`
- `stage_file`: `openWorldHint: false` (targets our own Worker)

Not used: `_meta.anthropic/requiresUserInteraction` (it forces a client prompt on every call and would override `allow`), `_meta.anthropic/maxResultSizeChars` (it raises the persistence threshold; pagination parameters handle size instead).

### 2.6 The `ask` result

```json
{
  "status": "pending_approval",
  "action_id": "pa_7f3c…",
  "action": "send.message",
  "modifiers": ["+external", "+attachment"],
  "account": "university",
  "summary": "To: prof@uni.edu.au · Subject: Thesis draft · 1 attachment (thesis.pdf, 2.1 MB)",
  "approval": { "mode": "url", "url": "https://gmail-mcp.<owner>.workers.dev/approve/pa_7f3c…" },
  "expires_at": "2026-09-09T10:15:00+10:00"
}
```

### 2.7 Attachment limits

- `stage_file` and `download_attachment`: 25 MB per file.
- Send time: aggregate attachment size must be under the account's `send_limit_bytes` (default 25 MB).
- Blocked extensions: `GMAIL_BLOCKED_EXTENSION_SET`, configuration seeded from Google's published list (about 50 entries including `exe dll bat cmd js jse vbs msi jar apk appx iso ps1 mjs msix lnk vhd xll`). Checked by filename at stage time and again at send time. Archives are not inspected. Gmail's scanner is authoritative and its rejection is surfaced as a tool error.

## 3. Data model, confirmation engine, tokens, staging

### 3.1 Identity root

`user_id` is the `sub` from the Worker's own OAuth token. It is never read from tool arguments.

### 3.2 D1 schema

```sql
users (
  id TEXT PRIMARY KEY,                -- Worker sub = owner Google sub
  email TEXT, created_at INTEGER
);

accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  alias TEXT NOT NULL,
  google_sub TEXT NOT NULL,
  google_email TEXT NOT NULL,
  scopes TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','needs_reconnect','revoked')),
  is_default INTEGER NOT NULL DEFAULT 0,
  send_limit_bytes INTEGER NOT NULL DEFAULT 26214400,
  org_domains TEXT,                   -- JSON array, Workspace accounts only
  refresh_token_enc BLOB, refresh_token_key_id TEXT,
  access_token_enc BLOB,  access_token_key_id TEXT, access_expires_at INTEGER,
  created_at INTEGER, last_refresh_at INTEGER,
  UNIQUE (user_id, alias),
  UNIQUE (user_id, google_sub)
);
CREATE UNIQUE INDEX accounts_one_default ON accounts(user_id) WHERE is_default = 1;

policies (
  user_id TEXT NOT NULL, account_id TEXT,      -- NULL = owner global
  action TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('allow','ask','deny')),
  updated_at INTEGER,
  PRIMARY KEY (user_id, account_id, action)
);

contact_allowlist (account_id TEXT NOT NULL, pattern TEXT NOT NULL,  -- address or @domain
                   PRIMARY KEY (account_id, pattern));

pending_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  action TEXT NOT NULL, modifiers TEXT NOT NULL,
  payload_json TEXT,                  -- nulled on terminal states
  payload_hash TEXT NOT NULL,
  summary TEXT NOT NULL,              -- redacted after terminal state
  state TEXT NOT NULL CHECK (state IN ('pending','approved','executing','delivery_unknown',
                                       'executed','failed','denied','cancelled','expired')),
  created_at INTEGER, expires_at INTEGER,
  approved_at INTEGER, approved_via TEXT,     -- 'elicitation' | 'browser'
  executed_at INTEGER, gmail_result_id TEXT, rfc822_message_id TEXT, error TEXT
);

operations (
  account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('executing','delivery_unknown','executed','failed')),
  gmail_result_id TEXT, rfc822_message_id TEXT, created_at INTEGER, updated_at INTEGER,
  PRIMARY KEY (account_id, idempotency_key)
);

staging_objects (
  handle TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('download','upload')),
  r2_key TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  source_message_id TEXT, source_attachment_id TEXT,
  created_at INTEGER, expires_at INTEGER, consumed_at INTEGER
);

web_sessions (
  id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  created_at INTEGER, last_seen_at INTEGER, expires_at INTEGER, revoked_at INTEGER
);

audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER, user_id TEXT, account_id TEXT,
  tool TEXT, action TEXT, modifiers TEXT,
  decision TEXT,                      -- allow | ask | deny | approved | denied | executed | failed
  pending_id TEXT, gmail_result_id TEXT,
  summary TEXT,                       -- redacted: counts and ids, no bodies, no full subjects
  client_hint TEXT
);
```

KV holds only `workers-oauth-provider` state (client registrations, grants, its tokens), OAuth `state` and `nonce` entries with 600 s TTL, and CSRF tokens.

### 3.3 Token encryption and refresh

- `TOKEN_KEK`: Worker secret, 32 random bytes base64. Each ciphertext carries its own `*_key_id`; rotation re-encrypts lazily on next use, per ciphertext.
- AES-256-GCM via WebCrypto, fresh 12-byte IV, stored as `iv || ciphertext || tag`.
- AAD is canonically framed: `"gmail-mcp:v1" \0 user_id \0 account_id \0 field_name`.
- Access tokens are cached encrypted with expiry. On refresh failure with `invalid_grant`, the account flips to `needs_reconnect`; the next tool call on that account returns a URL-mode elicitation to `/connect?alias=…`.
- Tokens never appear in tool results, audit rows or logs.

### 3.4 Confirmation state machine

```
pending ─approve(elicitation|browser)─▶ approved ─execute─▶ executing ─▶ executed
   │                                       │                    ├──▶ failed
   ├─ decline ─▶ denied                    └─ ttl ─▶ expired    └──▶ delivery_unknown
   ├─ cancel_pending ─▶ cancelled
   └─ ttl 15 min ─▶ expired
```

Invariants:

- **Payload is server-held.** The `ask`-hit call stores canonical arguments as `payload_json` and `payload_hash = sha256(canonical JSON)`. The approval page renders from the row. Later model output cannot change what executes.
- **Approval binds identity.** Browser approval requires a `web_sessions` row whose `user_id` equals the pending row's `user_id`. Elicitation approval carries an HMAC-signed `requestState` (Worker secret `STATE_HMAC_KEY`) with fields `version="gmail-mcp:approval:v1"`, `pending_id`, `user_id`, `account_id`, `payload_hash`, `expires_at`, `nonce`, verified against the bearer token on the retried call.
- **Resume re-hashes.** The retried `tools/call` arguments are canonicalised and compared to `payload_hash`. Mismatch is denied and audited.
- **Execution is one atomic transition.** `UPDATE pending_actions SET state='executing', executed_at=? WHERE id=? AND user_id=? AND state='approved' AND expires_at > ? RETURNING *`. Zero rows means replayed, expired or never approved.
- **Policy is re-evaluated at execution.** A tighter policy saved between approval and execution wins.
- **One approval covers one action.** Bulk operations are one row whose summary lists the count and up to 10 subjects.
- **Terminal purge.** On reaching any terminal state, `payload_json` is set to NULL and `summary` is replaced by a redacted form (counts, ids, recipient count). `delivery_unknown` keeps the payload until reconciled or expired, then purges.

### 3.5 Send execution, idempotency, crash recovery

Before any Gmail send:

1. Resolve `idempotency_key`: the pending id for `ask` sends; the client-supplied key for `allow` sends; none otherwise.
2. If a key exists, `INSERT INTO operations … ON CONFLICT DO NOTHING` then `SELECT`. An existing row in `executed` returns the stored result without calling Gmail. An existing `executing` or `delivery_unknown` row returns `delivery_unknown` without calling Gmail.
3. Generate `rfc822_message_id` (`<op_…@gmail-mcp>`) and set it as the `Message-ID` header of the outgoing MIME.
4. Call `messages.send`. On success, record `gmail_result_id` and mark `executed`.
5. If the Worker cannot record the result (crash, D1 error, timeout after Gmail was called), the row is left in `executing`. The purge cron moves rows older than 2 minutes in `executing` to `delivery_unknown`.
6. **Reconciliation** searches the account for `rfc822msgid:<id>`. If found, mark `executed` with the found id. This is enabled only after the integration test in 4.7 proves Gmail preserves a supplied `Message-ID`. Until proven, `delivery_unknown` is terminal and the tool returns:

```json
{ "status": "delivery_unknown", "operation_id": "op_…",
  "message": "The Gmail request may have succeeded. Do not retry automatically." }
```

There is no content-based dedupe. Identical content sent twice on purpose is two operations.

### 3.6 Staging handle lifecycle

Handle: `sh_` plus 32 random bytes base64url. Non-enumerable, carries no Google identifiers.

Download: `download_attachment` calls `attachments.get`, decodes base64url, `tee()`s the stream into `R2.put` and a `crypto.DigestStream("SHA-256")`, writes the row with `expires_at = now + 30 min`. Companion fetches `GET /staging/<handle>` with its `staging` bearer; the Worker checks `user_id` in the query and expiry, streams from R2. Re-fetch before ACK is allowed. The companion writes to a temp file, verifies sha256, renames atomically, then `POST /staging/<handle>/ack`, which sets `consumed_at`. A sha mismatch deletes the temp file and leaves the handle usable until TTL.

Upload: `stage_file` streams `PUT /staging` with filename and mime. The Worker enforces 25 MB by `Content-Length` and by counting, rejects blocked extensions, computes sha256 with the same `tee()` pattern, writes R2 and the row. At send time every handle is re-checked: owner, account, not consumed, not expired, aggregate under `send_limit_bytes`. Upload handles are consumed only after Gmail returns a message id.

Purge: cron every 5 minutes expires stale pending rows, promotes stuck `executing` rows, deletes expired staging objects from R2 and D1, and deletes audit rows older than 90 days. An R2 lifecycle rule on `stg/` deleting objects one day after creation is the eventual backstop.

### 3.7 Audit

One row per tool call, including reads and denials, written before returning. Metadata only: no bodies, no full subjects, no tokens. Readable through the `/audit` page only, never through an MCP tool.

## 4. OAuth flows, web UI, session security, testing

### 4.1 Tokens and audiences

| Holder | Scope | May call | Obtained via |
|---|---|---|---|
| Claude clients | `mcp` | `/mcp` only | Flow A |
| Companion | `staging` | `/staging/*` only | Flow C |
| Owner's browser | session cookie | `/approve`, `/policy`, `/accounts`, `/audit`, `/connect` | Google OIDC login |

Google Gmail refresh tokens are held only by the Worker (Flow B). A token presented to a route outside its lane gets 403.

### 4.2 Flow A: Claude to Worker

- `OAuthProvider` mounts `/authorize`, `/token`, `/register`, and serves `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`.
- Client registration priority per MCP 2026-07-28: **CIMD** first (URL-formatted `client_id`, metadata fetched and `redirect_uris` validated), **DCR** via `/register` as deprecated compatibility, pre-registered credentials when explicitly configured.
- PKCE S256 required. `resource` parameter (RFC 8707) required and validated as the audience of every issued token. `iss` emitted in authorization responses and `authorization_response_iss_parameter_supported: true` advertised.
- Redirect URIs: exact scheme, host and path match against the client's own registration. Loopback clients may vary the port per RFC 8252 §7.3. The claude.ai client's registered URI is `https://claude.ai/api/mcp/auth_callback`. Claude Code registers `http://localhost:PORT/callback`. No wildcard allowlist exists.
- Consent page per Cloudflare guidance: sanitised client name and redirect URI, CSRF token, approved-clients cookie. Then Google OIDC with `openid email profile` only, `state` and one-use `nonce` in KV. On return verify `id_token` signature, `iss`, `aud`, `exp`, `iat`, `nonce`, `email_verified == true`. Require `sub ∈ OWNER_GOOGLE_SUBS`. Complete the grant with `props = { sub, email }`.
- Bootstrap: when `OWNER_GOOGLE_SUBS` is empty and `email ∈ OWNER_EMAILS`, the setup page displays the `sub` to paste into the secret. `OWNER_EMAILS` is display and bootstrap only.
- Profile-only scopes exempt this identity login from the 7-day Testing expiry.

Open risk: whether `workers-oauth-provider` implements CIMD and emits `iss`. The implementation plan opens with a spike; if unsupported, the Worker adds those two behaviours in front of the library or pins DCR with `iss` added manually.

### 4.3 Flow B: Worker to Google per account

- Entry: `connect_account(alias)` returns URL-mode elicitation to `/connect?alias=…&e=<signed elicitation id>`, or the Accounts page. `/connect` requires a session whose `user_id` matches.
- Scopes: `https://www.googleapis.com/auth/gmail.modify` plus `openid email`. `mail.google.com` is never requested.
- `access_type=offline`, `prompt=consent`, `state` and `nonce` in KV bound to a hash of the session id, 600 s TTL.
- Callback: verify `state`, exchange code, verify `id_token` (signature, `iss`, `aud`, `exp`, `iat`, `nonce`, `email_verified`), upsert `accounts` on `(user_id, google_sub)`, encrypt tokens, audit `account.connect`. Revoke calls Google's revocation endpoint then wipes ciphertexts and marks `revoked`.

### 4.4 Google Cloud projects

Two projects:

| Project | Publishing status | Used by |
|---|---|---|
| `gmail-mcp-dev` | Testing | scratch Gmail account, integration tests. 7-day refresh expiry accepted |
| `gmail-mcp-personal` | In production, unverified, personal-use exemption | the owner's real accounts |

The verification and CASA exclusion holds only while this remains a personal-use system for the owner and people personally known to them. Distributing it generally changes the requirement: server-side storage of restricted-scope data then requires a third-party security assessment.

### 4.5 Flow C: Companion to Worker

`gmail-mcp-companion login` runs PKCE against the Worker's AS as the pre-registered public client `companion` with loopback redirect `http://localhost:PORT/callback`, same Google OIDC identity step, token scope `staging`. Access and refresh tokens in macOS Keychain via the `security` CLI. Staging routes check the bearer's `sub` against `staging_objects.user_id` inside the query.

### 4.6 Web pages and session security

Server-rendered HTML forms, no client JavaScript, no third-party assets.

| Page | Purpose | Guards |
|---|---|---|
| `/approve/<id>` | account, action, modifiers, recipients, subject, attachment names and sizes, body preview; Approve and Deny | session match, CSRF, `Origin` check, POST is the atomic transition |
| `/accounts` | list, connect, reconnect, revoke, set default, allowlist, send limit, org domains | session, CSRF, recent-auth for revoke |
| `/policy` | action × level matrix, per-account overrides, blocked-extension set | session, CSRF, recent-auth, audited as `policy.edit` |
| `/audit` | 90-day metadata log with filters | session |
| `/logout` | revoke current session | CSRF |

Session: `__Host-session` = 256-bit random opaque value; `web_sessions` stores its sha256. HttpOnly, Secure, SameSite=Lax. Rotated after login. Absolute lifetime 12 h, idle timeout 2 h. Logout revokes immediately. Policy edits and account revocations require authentication within the last 15 minutes and revoke all other sessions.

CSRF: per-form token = HMAC over `session_id || method || route || object_id || expiry`, delivered in the form and compared on POST. A token for `/approve/A` cannot approve `/approve/B`.

Response headers on every page:

```
Cache-Control: no-store
Pragma: no-cache
Referrer-Policy: no-referrer
Content-Security-Policy: default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'
X-Content-Type-Options: nosniff
```

All user-influenced text is escaped and never rendered as a link.

### 4.7 Testing matrix

**Normal CI (no real Gmail credentials)**

- Unit, Vitest in the Workers runtime via the Cloudflare vitest pool:
  - policy engine, table-driven over every action × level × modifier, including consumer vs Workspace `+external`
  - state machine: no sequence reaches `executed` twice; concurrent `execute_pending` yields one success
  - operations table: same key returns the first result and never calls the fake Gmail twice
  - crypto: decrypt fails on AAD mismatch, wrong key id, truncated ciphertext
  - handles: cross-account, cross-user, expired, ACK after TTL all rejected
  - blocked extensions: every seeded entry rejected at stage and at send
  - companion: traversal, symlink escape, overwrite without approval refused; sha mismatch deletes the temp file
- Workers integration against a fake Gmail HTTP adapter: full tool round-trips, `ask` result shape, approval page POST, elicitation resume.
- OAuth and web adversarial: redirect_uri substitution, authorization-code replay, `state` replay, `nonce` replay, issuer mix-up, wrong audience, expired `id_token`, session fixation, CSRF token from another pending action, open-redirect attempts, CIMD metadata tampering, `mcp` token to `/staging`, `staging` token to `/mcp`, `execute_pending` replay, `requestState` field tampering one field at a time, retried elicitation call with changed recipients, approval URL opened under a different session.

**Protected Gmail integration (manual or scheduled, never on forks)**

- Dedicated scratch Gmail account in `gmail-mcp-dev`, secret only in the protected environment, mailbox holds no real mail.
- Send with a staged attachment, fetch it back, sha256 matches.
- **Message-ID preservation gate**: send with a supplied `Message-ID`, search `rfc822msgid:`, must match. Reconciliation in 3.5 is enabled only if this passes.
- Revoke the token in Google; next call flips to `needs_reconnect` and returns a URL elicitation.
- 25 MB attachment round-trip within Workers Paid CPU limits.

**End to end**

- MCP Inspector against `/mcp` for auth and schemas.
- Claude Code: `ask` via native URL-mode elicitation; companion save and stage.
- Claude Desktop: `ask` via approval link then `execute_pending`; companion save; overwrite refused.
- claude.ai: `ask` via approval link then `execute_pending`; no companion.

Every adversarial test records both outcomes. A caught abuse is evidence the gate works.

## 5. Repository layout

```
gmail/
  worker/            Cloudflare Worker: MCP handler, OAuth, policy, pages, cron
    src/tools/       one module per Gmail tool family
    src/policy/      engine, modifiers, defaults
    src/approval/    state machine, requestState, pages
    src/staging/     R2 ingest, handles, ACK
    src/crypto/      AES-GCM, key ids, AAD framing
    migrations/      D1
    test/
  companion/         stdio MCP: save_attachment, stage_file, list_roots, login CLI
    test/
  docs/superpowers/specs/2026-09-09-gmail-mcp-design.md   (this file)
```

TypeScript throughout. Worker uses Cloudflare's MCP package and `workers-oauth-provider`. Companion uses the MCP TypeScript SDK 2.x over stdio.

## 6. Deferred (signed IOUs)

- `X-Claude-Audit-Id` header on sent mail linking to the audit row.
- `search_threads(account="all")` fan-out across accounts.
- Companion as a full local proxy re-exposing every tool with path parameters (Approach B).
- Multi-user signup replacing `OWNER_GOOGLE_SUBS`.
- Gmail app verification and CASA.

## 7. Scorecard (design stage)

| Axis | Score | What moves it higher |
|---|---|---|
| Authority boundary clarity | 9 | nothing designed; proven by the adversarial suite passing |
| Attachment UX from Claude Code | 7 | Approach B proxy would make download and attach one step |
| Google token lifecycle robustness | 6 | reconciliation gate passing; confirmation that unverified Production avoids the 7-day expiry |
| Dependence on unverified library behaviour | 5 | the CIMD and `iss` spike in the plan |
| Reproducibility of security claims | 8 | every invariant has a named test; sealed results |
