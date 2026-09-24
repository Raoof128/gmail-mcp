# Gmail MCP for Claude: design

Date: 2026-09-09. Current architecture revision: 2026-09-19.
Status: implemented and locally gauntlet-verified. The external qualification gates in 4.8 are
`not_run`, and release authority is unreachable until they are satisfied.
Owner: Raouf

This document describes the system as it is. How it got here lives in the plans under
`docs/superpowers/plans/`, the reviews under `docs/superpowers/reviews/` and the changelog; when a
decision was superseded, the current behaviour is written here and the history is left there.

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
│  Remote MCP tools (38 = 31 + 7)          │
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
       │             │              └── KV: workers-oauth-provider state
       │             └── R2: temporary attachment bytes
       └── D1: users, accounts, policies, pending actions, operations,
               staging metadata, web sessions, one-use oauth state, audit
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

| Choice                                                                                                                                                                       | Fact it rests on                                                                                                                                                                                                                                                                                                  | Source                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP protocol 2026-07-28, stateless, with 2025 Streamable HTTP compatibility                                                                                                  | Spec is stateless at the protocol layer; confirmations use `InputRequiredResult` multi-round-trip; URL-mode elicitation is the spec's mechanism for sensitive confirmations                                                                                                                                       | modelcontextprotocol.io/specification/2026-07-28                                                                                                     |
| `createMcpHandler()` from Cloudflare's MCP package                                                                                                                           | Cloudflare marks `McpAgent` deprecated and feature-frozen                                                                                                                                                                                                                                                         | developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server                                                                     |
| `@cloudflare/workers-oauth-provider` (tested at 0.10.3; the lockfile is normative)                                                                                           | Supports CIMD (`clientIdMetadataDocumentEnabled: true`, requires `global_fetch_strictly_public` compatibility flag), always emits RFC 9207 `iss`, serves RFC 9728 metadata, accepts RFC 8707 `resource`, S256 PKCE by default. Does **not** enforce per-client scopes or operation-level scope policy             | github.com/cloudflare/workers-oauth-provider                                                                                                         |
| Workers Paid plan                                                                                                                                                            | Free plan allows 10 ms CPU per request. Isolate memory is 128 MB, per isolate rather than per invocation, and an isolate is reused across concurrent requests. The request body limit follows the Cloudflare account plan, not the Workers plan: 100 MB on Free and Pro, 200 MB on Business, higher on Enterprise | developers.cloudflare.com/workers/platform/limits                                                                                                    |
| D1 for structured state                                                                                                                                                      | 2 MB row, string and BLOB limit; foreign keys enforced; `batch()` is a transaction that rolls back on any statement error, and there are no interactive transactions                                                                                                                                              | developers.cloudflare.com/d1/platform/limits, developers.cloudflare.com/d1/sql-api/foreign-keys, developers.cloudflare.com/d1/worker-api/d1-database |
| SQLite partial unique indexes for nullable keys                                                                                                                              | Ordinary-table PRIMARY KEY columns may contain NULL; NULLs are distinct for uniqueness                                                                                                                                                                                                                            | sqlite.org/quirks.html, sqlite.org/partialindex.html                                                                                                 |
| Attachments via `users.messages.attachments.get`                                                                                                                             | Returns JSON `MessagePartBody` with `data` as base64url, not raw bytes. Needs `gmail.readonly`, `gmail.modify` or `mail.google.com`                                                                                                                                                                               | developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments                                                               |
| Sending via media or resumable upload of `message/rfc822`                                                                                                                    | `/upload/gmail/v1/users/me/messages/send`; resumable recommended for larger data                                                                                                                                                                                                                                  | developers.google.com/workspace/gmail/api/guides/uploads                                                                                             |
| `gmail.modify` excludes permanent delete                                                                                                                                     | `messages.delete` and `threads.delete` require `https://mail.google.com/`                                                                                                                                                                                                                                         | developers.google.com/workspace/gmail/api/auth/scopes                                                                                                |
| 500 recipients per message                                                                                                                                                   | Gmail usage limits                                                                                                                                                                                                                                                                                                | developers.google.com/workspace/gmail/api/reference/quota                                                                                            |
| Claude Code supports elicitation (form and URL), speaks 2026-07-28 to HTTP servers on v2.1.232+, discovers CIMD automatically, uses RFC 8252 loopback with an ephemeral port | Claude Code MCP docs                                                                                                                                                                                                                                                                                              | code.claude.com/docs/en/mcp                                                                                                                          |
| claude.ai OAuth callback `https://claude.ai/api/mcp/auth_callback`                                                                                                           | Anthropic connector docs                                                                                                                                                                                                                                                                                          | claude.com/docs/connectors/building/authentication                                                                                                   |
| Google refresh tokens for an external app in Testing expire after 7 days unless only profile scopes are requested                                                            | Google OAuth docs                                                                                                                                                                                                                                                                                                 | developers.google.com/identity/protocols/oauth2#expiration                                                                                           |
| Personal-use apps under 100 users need not complete OAuth verification; users still see the unverified flow and cap                                                          | Google Cloud Help                                                                                                                                                                                                                                                                                                 | support.google.com/cloud/answer/13464323                                                                                                             |

Dated observation, not a design dependency: on 2026-09-09 the connector docs listed advanced capabilities as unsupported on claude.ai and Desktop. The design keys on advertised capabilities (1.4), never on product names.

### 1.3 Accounts

Each Google account gets an owner-chosen alias (`personal`, `university`, `work`), lower-case ASCII, unique per owner. Every write tool and `stage_file` require an explicit `account`. Read tools accept an optional `account` and fall back to the configured default. The model never guesses an account for a write.

### 1.4 Confirmation model

`ask` never means "do it and tell the user". It creates a pending action and returns without touching Gmail. Approval happens one of two ways:

1. **URL-mode elicitation** when the negotiated client capabilities include `elicitation.url` on protocol revision 2026-07-28. Amended 2026-09-10 (plan 3): the `agents` handler serves 2025-era clients through a stateless lane in which the server cannot send a request to the client, so those clients always receive path 2. The client opens the approval page and immediately retries the `tools/call` with an accept response. The protocol ends there: the client fulfils the embedded request out of band and retries the original call, and no server-originated completion signal exists. What follows is this Worker's own behaviour on that retry, not a protocol requirement. It may block until the out-of-band approval completes: the Worker polls the pending row every 2 seconds for up to 120 seconds. If the row becomes `approved`, the Worker claims and executes in that same request and returns the real result. If it is still `pending` at the deadline, the Worker returns the ordinary `pending_approval` result (2.6) so the owner can finish in the browser and Claude can call `execute_pending` later. Declined or expired rows return an error.
2. **Approval URL in the tool result** otherwise. The owner opens it, approves in the browser, then Claude calls `execute_pending(id)`.

Both paths land on the same Worker page, which requires a browser session whose identity matches the pending row's owner. A model-relayed confirmation code is not an accepted approval path for any write.

Plan 4 amendment (2026-09-12): V1 refuses overwrite under every client. Approval-based overwrite is deferred as P4-OVERWRITE.

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

| Action                    | Meaning                                                  | Default                        |
| ------------------------- | -------------------------------------------------------- | ------------------------------ |
| `read.search`             | search threads                                           | allow                          |
| `read.message`            | get message, thread, drafts, labels, attachment metadata | allow                          |
| `read.attachment`         | fetch attachment bytes into staging                      | allow                          |
| `draft.write`             | create or update a draft                                 | allow                          |
| `send.message`            | send new mail or reply                                   | ask                            |
| `send.draft`              | send an existing draft                                   | ask                            |
| `send.forward`            | forward an existing message                              | ask                            |
| `label.manage`            | create, update, delete label definitions                 | ask                            |
| `label.apply`             | add or remove labels on a message or thread              | allow                          |
| `spam.mark`               | mark spam                                                | ask                            |
| `spam.unmark`             | unmark spam                                              | allow                          |
| `trash.move`              | trash                                                    | ask                            |
| `trash.restore`           | untrash                                                  | allow                          |
| `attachment.stage_upload` | upload a local file into staging                         | ask                            |
| `fs.save`                 | write staged bytes to disk (companion-enforced)          | allow                          |
| `account.read`            | list accounts and their health                           | allow                          |
| `account.connect`         | connect or reconnect a Google account                    | ask, completes in browser only |
| `policy.read`             | read effective policy                                    | allow                          |
| `policy.edit`             | change policy                                            | browser only, no MCP tool      |

Effective level: account override, else owner global, else default above.

### 2.2 Modifiers

Each modifier raises the effective level one step: `allow` becomes `ask`; `ask` and `deny` are unchanged. Modifiers never lower a level. Amended 2026-09-24: modifiers raise only a level that comes from the built-in defaults. A level the owner saved as a policy row is final, and the modifiers are still recorded in the audit row. The policy page offers "Allow everything" as one owner decision that replaces per-call approvals.

| Modifier      | Applies to    | Trigger                                                                                     |
| ------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `+attachment` | `send.*`      | any attachment present, including a draft's existing attachments                            |
| `+external`   | `send.*`      | any recipient outside the trusted set (2.8)                                                 |
| `+bulk`       | `send.*`      | more than 10 distinct recipients across To, Cc and Bcc                                      |
| `+sensitive`  | `label.apply` | target is a sensitive or system label                                                       |
| `+overwrite`  | `fs.save`     | reserved for the deferred overwrite design; no V1 emitter, since V1 refuses every overwrite |

Label, trash and spam tools act on one message or thread per call in v1, so `+bulk` does not apply to them. Batch tools are a deferred item (6).

There is no permanent delete tool, and the requested Google scope cannot perform one.

### 2.3 Remote tools (38)

Names mirror the hosted connector baseline (Appendix A) where one exists. Amended 2026-09-10 (plan 3): every tool argument is snake_case, matching `page_token` and `body_char_limit` in the rows below. The seven control tools (`list_accounts`, `get_policy`, `list_pending`, `execute_pending`, `cancel_pending`, `connect_account`, `open_policy_editor`) read the owner's own state or are the approval mechanism itself and do not pass through the policy engine; the 31 Gmail tools do.

| Tool                                                                                                                                                           | Action              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_threads`                                                                                                                                               | read.search         | Gmail query syntax; `limit` default 20 max 50 (hosted parity); `page_token`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `get_thread`                                                                                                                                                   | read.message        | `message_format` default `PLAIN_TEXT`; `max_messages`, `include_body`, `body_char_limit`, `total_body_char_limit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `get_message`                                                                                                                                                  | read.message        | attachments as metadata: `attachmentId`, filename, mime, size                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `list_drafts`, `get_draft`, `list_labels`                                                                                                                      | read.message        | paginated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `download_attachment`                                                                                                                                          | read.attachment     | takes `part_id`; amended 2026-09-19: `attachment_id` is accepted but is not treated as stable. Google documents `attachmentId` as the identifier for `messages.attachments.get` and gives no stability guarantee either way; in a live observation on 2026-09-19, two consecutive `get_message` calls on one message returned two different 404-character ids. This tool re-reads the message to check the size ceiling, so an id the caller read earlier may not match. The refusal names the parts the message has; parts whose bytes Gmail inlines in `body.data` are attachments too. Returns a staging handle with filename, mime, size, sha256, `expires_at`, `account`. Bytes never enter a tool result. 25 MB ceiling |
| `create_draft`, `update_draft`                                                                                                                                 | draft.write         | `attachments: [handle]`; `inline_attachments` converted to staging handles before any row is written, 1 MB decoded total                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `send_message`                                                                                                                                                 | send.message        | new mail only; optional `idempotency_key`. No `draftId`, no thread parameters: replies go through `reply`. Amended 2026-09-19: `attach_from_message: [{message_id, part_id}]` carries a file the mailbox already holds, Gmail to Gmail, the same mechanism `forward` uses for `include_original_attachments` but chosen per file. It exists because an agent had no usable route: `download_attachment` hands back a download-direction handle and the reservation in 3.7 takes only `direction='upload'`, so the bytes had to leave for the companion and come back. The reference is a part and not an attachment id for the reason in the row above, and it must survive an approval                                       |
| `reply`                                                                                                                                                        | send.message        | canonical reply: `account`, `message_id`, body, optional extra recipients, and `attach_from_message` as for `send_message`. The Worker derives `threadId`, `Subject`, `In-Reply-To`, `References` from the target message. Amended 2026-09-19: replying to a message this account sent addresses the original recipients, and a note sent only to itself replies to itself. Excluding the account's own addresses is right for `reply_all` and empties the list when we are the sender, which refused every follow-up on one's own last message                                                                                                                                                                               |
| `send_draft`                                                                                                                                                   | send.draft          | `account`, `draft_id`; see 3.5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `forward`                                                                                                                                                      | send.forward        | `include_original_attachments` defaults to `false`; approval summary lists filenames and sizes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `create_label`, `update_label`, `delete_label`                                                                                                                 | label.manage        | Amended 2026-09-10 (plan 3): colours are `text_color` and `background_color` hex values validated by Gmail, because the hosted `colorPreset` names have no published hex mapping; `create_label` sends the name as given and does not create missing parent labels, since a parent created before the operation is `executing` is a side effect a `claimed` row would deny                                                                                                                                                                                                                                                                                                                                                    |
| `label_message`, `unlabel_message`, `label_thread`, `unlabel_thread`, `update_message_labels`, `apply_sensitive_message_label`, `apply_sensitive_thread_label` | label.apply         | sensitive variants carry `+sensitive`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `mark_message_spam`, `mark_thread_spam`                                                                                                                        | spam.mark           |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `unmark_message_spam`, `unmark_thread_spam`                                                                                                                    | spam.unmark         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `trash_message`, `trash_thread`                                                                                                                                | trash.move          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `untrash_message`, `untrash_thread`                                                                                                                            | trash.restore       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `list_accounts`                                                                                                                                                | account.read        | alias, email, scopes, status, default flag. Never tokens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `connect_account`                                                                                                                                              | account.connect     | returns URL-mode elicitation or the URL as text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `get_policy`                                                                                                                                                   | policy.read         | effective policy for an account after overrides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `open_policy_editor`                                                                                                                                           | policy.read         | returns the policy page URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `list_pending`, `execute_pending`, `cancel_pending`                                                                                                            | confirmation engine | see 3.4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Every read result echoes `account`. Message, thread, draft and attachment identifiers are account-bound: a lookup includes `account_id` and `user_id` in the query, never as a post-check, and the schema enforces the pairing (3.2).

### 2.4 Companion tools (3)

Plan 4 amendment (2026-09-12): the reviewed [companion design](../plans/2026-09-11-gmail-mcp-plan-4-companion-and-staging.md) supersedes the original path and ticket model.

| Tool              | Action                  | Inputs and behavior                                                                                                                                                       |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `save_attachment` | fs.save                 | `handle`, `root`, `path`. Validate a relative destination, verify bytes, publish exclusively, journal the inode and ACK. V1 refuses overwrite.                            |
| `stage_file`      | attachment.stage_upload | `account`, `root`, `path`, `mime`, optional `idempotency_key`. Snapshot before approval, then create or recover the same owner-bound transfer. Maximum 25 MiB, inclusive. |
| `list_roots`      | read                    | Logical root IDs and read/write permissions; no absolute paths in results.                                                                                                |

Configuration lives in owner-only `~/.config/gmail-mcp/config.json`. SQLite receipts and snapshots live under `~/Library/Application Support/gmail-mcp/`, outside granted roots. The native helper accesses Keychain through Security.framework and serializes cross-process work with a permanent lock file.

### 2.5 Annotations

Standard MCP hints, set truthfully and treated as hints only:

- `search_threads`, `get_*`, `list_*`, `get_policy`, `open_policy_editor`, `list_pending`, `list_roots`: `readOnlyHint: true`
- `download_attachment`: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false` (creates staging state)
- `send_message`, `reply`, `send_draft`, `forward`: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: true`
- `trash_message`, `trash_thread`, `mark_message_spam`, `mark_thread_spam`, `unlabel_message`, `unlabel_thread`, `update_message_labels`, `apply_sensitive_message_label`, `apply_sensitive_thread_label`, `delete_label`: `destructiveHint: true`. The trash and spam tools compute it from the direction, so the mutating half of each pair carries `true` and the reversing half carries `false`. `update_message_labels` is on this list because it can remove labels, and the two `apply_sensitive_*` tools because they apply TRASH or SPAM.
- `untrash_message`, `untrash_thread`, `unmark_message_spam`, `unmark_thread_spam`, `label_message`, `label_thread`, `create_label`, `update_label`, `create_draft`, `update_draft`: `destructiveHint: false`
- `stage_file`: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false`
- `save_attachment`: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false`

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

Amended 2026-09-19, result and argument shape for every tool:

- Tool inputs are strict. An argument the tool does not declare is refused by name rather than
  dropped. Zod strips unknown keys by default, which made a misspelled argument a silent nothing: a
  `send_message` carrying `text` instead of `body` was accepted, hashed and queued with no body at
  all, and the approval page truthfully showed an empty message. The advertised JSON schema carries
  `additionalProperties: false`, so a client can catch it before spending a call.
- Every handler-produced tool result carries `structuredContent` beside the readable `content` block, per MCP 2026-07-28.
  The block stays for clients that read only `content`. No `outputSchema` is advertised: a schema
  would bind the server to a result shape, and each tool's own row here describes its result.
- A refusal raised by a tool carries `isError`, the error code, the message and details, in both
  places. A refusal raised by schema validation carries `isError` and a message, but no
  `structuredContent`, because the SDK answers it before any tool body runs. The two shapes differ
  and a caller reading errors should not assume the structured one.

### 2.7 Argument limits

| Field                                            | Cap                                                     |
| ------------------------------------------------ | ------------------------------------------------------- |
| subject                                          | 998 bytes (RFC 5322 line limit)                         |
| body plus html body                              | 512 KB combined                                         |
| recipients                                       | 500 total, per Gmail                                    |
| inline attachments                               | 1 MB decoded total, converted to handles before storage |
| staged file                                      | 25 MB                                                   |
| aggregate attachments at send                    | account `send_limit_bytes`, default 25 MB               |
| canonical argument JSON stored in `payload_json` | 1 MB                                                    |

Blocked extensions: `GMAIL_BLOCKED_EXTENSION_SET`, configuration seeded from Google's published list (about 50 entries including `exe dll bat cmd js jse vbs msi jar apk appx iso ps1 mjs msix lnk vhd xll`). Checked by filename on uploads at stage time and again at send time. Downloads to disk are sanitised but not filtered by this list, since it describes what Gmail refuses to send, not what the owner may save. Archives are not inspected.

### 2.8 Recipient trust rules for `+external`

- Addresses are parsed by a deliberately restricted grammar, not a full RFC 5322 parser: no quoted local parts, no comments, no leading, trailing or consecutive dots, one address per string. This is a permission boundary, so it prefers false negatives. A malformed address fails the call before policy.
- Address comparison: the domain is lower-cased and converted to ASCII (Punycode), and compared that way always.
- The local part is normalised only when the domain is `gmail.com` or `googlemail.com`, where the provider is known to fold case and strip `+tag` suffixes. Everywhere else the local part is compared raw, so the comparison is case-sensitive and a `+tag` is significant: an allowlist holding `a@corp.test` does not trust `A@corp.test` or `a+x@corp.test`. SMTP treats local parts as potentially case-sensitive, so normalising only where the provider is known to fold is the conservative reading.
- Dots in the local part are never normalised, on any domain.
- Domain pattern `@example.com` matches `a@example.com` and nothing else. It does not match `a@evil-example.com` or `a@sub.example.com`.
- The trusted set is evaluated over the union of To, Cc and Bcc.
- Consumer Gmail account: trusted = the account's own address, its configured send-as aliases, and the allowlist.
- Workspace account: trusted = the above plus addresses whose domain is in `org_domains`.

## 3. Data model, confirmation engine, operations, tokens, staging

### 3.1 Identity root

`user_id` is the `sub` from the Worker's own OAuth token. It is never read from tool arguments.

### 3.2 D1 data model

**The migrations under `worker/migrations/` are normative.** They are append-only and there are 29
tables; what follows is a relationship map, not executable DDL. This section used to carry a copy of
the schema, which drifted: it showed 11 tables, omitted `accounts.credential_version` that the
paragraph below depends on, and still carried `operations.idempotency_key` after keys moved to their
own table. A copy of a schema is a staleness factory, so there is no copy here now.

Foreign keys are enforced. Every child table binds `(user_id, account_id)` to `accounts(user_id, id)`
so ownership is a database invariant, not a query habit.

| Group     | Tables                                                                                                                                                                                                                               | What they hold                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Identity  | `users`, `accounts`, `web_sessions`, `oauth_states`                                                                                                                                                                                  | the owner, their Google grants and `credential_version`, browser sessions, and one-use OAuth state      |
| Policy    | `policies`, `policy_revision`, `contact_allowlist`, `settings`                                                                                                                                                                       | levels per action and account, the allowlist, and deployment settings                                   |
| Authority | `pending_actions`, `operations`, `idempotency_keys`, `_assert`                                                                                                                                                                       | what awaits the owner, what has been claimed once, key to result binding, and the batch assertion table |
| Staging   | `staging_objects`, `staging_ingests`, `staging_materializations`, `staging_acknowledgements`, `staging_recovery_slots`, `upload_transfers`, `upload_generations`, `upload_retry_requests`, `download_admissions`, `download_streams` | bytes in flight in both directions, their leases, and their recovery state                              |
| Recovery  | `operation_recovery`, `recovery_attempts`, `recovery_control`, `recovery_requests`, `recovery_installation`, `settlement_permits`                                                                                                    | protocol-2 recovery, the installation marker, and permits that never span provider I/O                  |
| Record    | `audit_log`                                                                                                                                                                                                                          | metadata only, 90 days                                                                                  |

OAuth `state`, the OIDC `nonce` and pending consent requests live in D1:

```sql
oauth_states (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('login','reauth','connect','authreq')),
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);
```

They are consumed by one atomic `UPDATE ... SET consumed_at = ? WHERE id = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ? RETURNING payload`; zero rows means unknown, expired or replayed. Workers KV is eventually consistent and a `get` followed by a `delete` is not a one-use consume, so KV holds only `workers-oauth-provider` state (client registrations, grants, its tokens). `accounts` carries `credential_version INTEGER NOT NULL DEFAULT 0`: every write that stores or refreshes Google credentials is conditional on it and on `status = 'active'`, and revocation is local-first, bumping the version before Google is told. CSRF tokens are not stored anywhere (4.6).

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
- **Approval binds identity.** Browser approval requires a `web_sessions` row whose `user_id` equals the pending row's. Elicitation approval carries an HMAC-signed `requestState` minted by the SDK's `createRequestStateCodec` with `STATE_HMAC_KEY`, bound to the owner and the request method, and verified by the SDK before the handler runs. The payload is `{ v, tool, pending_id, account_id, intent_hash }` and the expiry equals the pending TTL. No `nonce` is carried: the pending id is single-claim and the state is bound to one owner, so a replay has nothing to gain.
- **The payload names its executor.** Amended 2026-09-10 (plan 3): every stored payload carries `tool` and `v`, the executor version it was approved for. A pending row whose version no longer matches the registered executor is `payload_mismatch` and never runs.
- **Resume re-hashes.** The retried `tools/call` arguments are canonicalised and compared to `payload_hash`. Mismatch is denied and audited.
- **Claim is one atomic batch.** D1 `batch()` runs its statements as one transaction and rolls back the whole sequence if any statement errors, but it does not roll back on a zero-row update. The claim therefore uses an assertion table `_assert (x INTEGER NOT NULL CHECK (x = 0))` to convert a failed precondition into an error. Statement order, all in one batch: (1) `INSERT INTO operations (id, …, state='claimed', payload_hash)`; (2) `UPDATE pending_actions SET state='executing', operation_id=?, executed_at=? WHERE id=? AND user_id=? AND state='approved' AND expires_at > ?`; (3) `INSERT INTO _assert SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM pending_actions WHERE id=? AND operation_id=? AND state='executing')`; (4) reserve staging handles (3.7); (5) `INSERT INTO _assert SELECT 1 WHERE (SELECT count(*) FROM staging_objects WHERE reserved_by_operation_id=?) != ?`. Statements 3 and 5 insert a row only when the precondition failed, the CHECK rejects it, and the batch rolls back including the operation row. Zero rows in statement 2 means replayed, expired or never approved. Foreign keys are immediate, which is why the operation row is inserted before the pending row references it.
- **Policy is re-evaluated at claim.** A tighter policy saved between approval and execution wins.
- **One approval covers one action.**
- **Terminal purge.** On any terminal state `payload_json` is set to NULL and `summary` replaced by a redacted form. The linked operation, not the pending row, carries delivery state from here on. Amended 2026-09-10 (plan 3): a pending row whose operation ends `delivery_unknown` is finished as `failed` with `error = "delivery_unknown"`, and the operation is authoritative for delivery from then on.

### 3.5 Operation journal and once-only mutation execution

`operations` is the journal of non-idempotent external side effects. An operation exists whether or not the caller supplied an `idempotency_key`. The key is a secondary uniqueness constraint used only to short-circuit retries.

Journaled actions: `send.message`, `send.draft`, `send.forward`, `draft.write` (create and update), `label.manage` (create only). Label apply, trash, spam and updates are naturally reconcilable and are not journaled. Journaling is chosen per tool and not per action: `ToolSpec.journal` is the authority for the **direct** path, so `label.manage` journals `create_label` and not `update_label` or `delete_label`, and `draft.write` journals both of its tools because reserving an upload handle needs an operation row to reserve it for. The **approved** path differs, and the distinction matters: `claimPending` always opens an operation, because that is what makes the claim once-only, so a tool whose direct path sets `journal: false` still has an operation when it is reached through `execute_pending`, and its executor must call `beginOperation` on it. `JOURNALED_ACTIONS` is documentation; nothing reads it.

Execution of a journaled action:

1. **Acquire.** If an `idempotency_key` is present and a row already exists: `executed` returns the stored result without calling Gmail; `executing`, `claimed` or `delivery_unknown` returns `delivery_unknown` without calling Gmail; `failed_safe` allows a fresh operation. `ask` actions use the pending id as the key. Otherwise insert a new `claimed` row. Amended 2026-09-10 (plan 3): keys live in `idempotency_keys`, recorded against the hash of the client's intent (the arguments, with inline attachment bytes replaced by their digest) before staging and before the allow/ask fork. A key follows its pending action or operation; a `failed_safe` operation or a dead pending action releases it. `executed` replays the stored result (ids only); anything in flight answers `delivery_unknown`; a live pending action is returned again.
2. **Reserve** attachments (3.7) while the operation is still claimed; the begin transaction admits the external request.
3. **Send.** Generate `<operationId@WorkerHostname>` for new messages, replies and forwards. Build MIME under the existing limits. At or below 5 MiB use media/multipart; larger messages use resumable upload. Plan 5 amendment (2026-09-14): persist the owner/account/grant-bound protocol-2 recovery context and executing/byte-admitted marker atomically before the original byte request. Validate and encrypt a send session before its original PUT. Session initialization moves no MIME; reconnect during initialization prevents byte admission. Original draft upload endpoints remain typed and cannot enroll send recovery. `send_draft` preserves its original header but its ambiguous outcome remains manual.
4. **Record.** A valid direct receipt or qualified positive recovery proof uses one permit-guarded D1 batch for result, reservations, pending row and outcome audit. The first id/thread identity and label set win. Later matching replies replay; conflicting replies cannot replace the winner. The immutable operation context permits late direct settlement after recovery metadata or handles have expired.
5. **Crash or ambiguity.** Only claimed operations with no byte admission can be failed safe. After admission, errors remain unknown regardless of HTTP class; original mutation bodies never repeat after a 401. Unknown delivery holds its key and reservations. Protocol-1 maintenance remains separate, and compatibility triggers refuse old writers on protocol-2 operations and linked state.
6. **Reconciliation.** Qualified generated-message operations may search their exact internal Message-ID. One candidate with exact header, SENT label, expected thread and bounded provider timestamp is required; zero/multiple candidates never establish non-delivery. A bound resumable send session may issue a zero-body status request and accept a valid final receipt. An incomplete or expired session never authorizes another MIME request. `send_draft` is never automatically search-confirmed, including when an older sent copy has the same header and thread. Observation stops after 24 hours; recovery metadata expires after seven days without releasing the operation/key. Qualifying a mode requires private live evidence bound to deployment, account grant and fresh epoch; the current live/controller gates remain unmet. Until positive evidence exists, surface:

```json
{
  "status": "delivery_unknown",
  "operation_id": "op_…",
  "message": "The Gmail request may have succeeded. Do not retry automatically."
}
```

There is no content-based dedupe. Identical content sent twice on purpose is two operations.

### 3.6 Upload policy path (companion to Worker)

Plan 4 amendment (2026-09-12): authenticate to `/staging/identity`, persist a private snapshot and owner/origin/client-scoped request key, then call `POST /staging/intent` with `{mode, transfer_id, account, metadata}`. `ensure` creates or recovers authority; `status` reads it; `retry` additionally requires `expected_generation` and a durable `retry_request_id`.

`ask` creates one pending action without accepting bytes. Browser approval permits issuance under that same intent. Generic MCP `execute_pending` refuses staging actions before claim. The companion supports modern URL input requests, legacy URL elicitation, and a text-link fallback. A client response cannot substitute for Worker approval.

Ticket IDs are identifiers, not credentials. PUT requires the staging OAuth bearer and the current owner-bound generation. The Worker checks headers, length, SHA-256, account credential version and lease, then publishes one handle in the completion batch. Replays return the original result; they do not create new objects. Retrying an expired or interrupted generation requires a subsequent tool invocation and remains bound to the original snapshot and authority deadline.

The deadlines, quotas and recovery rules implemented in `worker/src/staging/` and `companion/src/` are normative; [Plan 4 sections 6-8](../plans/2026-09-11-gmail-mcp-plan-4-companion-and-staging.md) record how they were arrived at and are history, not the current contract. Expired leases fence publication; unknown writers keep their cleanup charge.

### 3.7 Staging handle lifecycle

Handle: `sh_` plus 32 random bytes base64url. Non-enumerable, carries no Google identifiers.

Ingest validates before it writes. The body is materialised and hashed first, bounded by the 25 MB cap, so a validation failure cannot leave an object in R2. That is narrower than it once claimed here: failures after publication, in the metadata write or an interruption, are handled by deterministic recovery and cleanup debt rather than prevented. Streaming straight into R2 was tried and rejected: a wrong declared length aborts the in-flight upload, leaves a partial object, and surfaces as an unhandled rejection.

Download, current semantics: a release recomputes `download_lease_until` from `MAX(lease_until)` over the streams that remain rather than clearing it, the per-owner slot is returned in a `finally` inside the stream's `cancel` so a client that vanishes mid-body does not hold it until expiry, an acknowledgement cannot consume an object whose `reserved_by_operation_id` is set, and a settlement permit never spans R2 I/O. `download_attachment` first reads the part's `size` from message metadata and refuses anything above 25 MB before any bytes move. It then calls `attachments.get`, which returns JSON with base64url `data`. V1 buffers the response, at most about 34 MB of text plus 25 MB decoded, decodes, hashes the decoded bytes and writes them to R2, then writes the row with `expires_at = now + 30 min`. The 25 MiB round trip in 4.7 exercises this functionally and nothing more. It does not establish peak deployed-isolate memory: Cloudflare's 128 MB limit is per isolate, and an isolate serves concurrent requests, so arithmetic over one request cannot bound it. Peak isolate memory is an external qualification gate (4.8) and is `not_run`; missing resource evidence blocks release. The companion GET requires a staging bearer and an atomic owner-bound download lease. After durable exclusive publication, ACK records consumption and an independent seven-day tombstone. Repeated ACK returns success without requiring the original staging row.

Hold at pending creation: when an `ask` action references upload handles, the same request extends each referenced handle's `expires_at` to the pending row's `expires_at` plus 5 minutes, so a handle staged 29 minutes earlier cannot expire between approval and execution.

Reservation at send: inside the claim batch, `UPDATE staging_objects SET reserved_by_operation_id=? WHERE handle IN (…) AND user_id=? AND account_id=? AND direction='upload' AND consumed_at IS NULL AND reserved_by_operation_id IS NULL AND expires_at > ?`; the batch fails unless the row count equals the handle count. `executed` consumes; `failed_safe` releases; `delivery_unknown` keeps the reservation until reconciliation resolves it. Storage expiry does not resolve it and never converts unknown delivery into a release: an expiring handle is storage debt, while the delivery truth of an unknown operation is preserved independently of any recovery metadata.

Purge: cron every 5 minutes expires stale pending rows, promotes stuck `executing` operations, deletes expired unreserved staging objects from R2 and D1, and deletes audit rows older than 90 days. An R2 lifecycle rule on `stg/` deleting objects one day after creation is the eventual backstop.

### 3.8 MIME and header safety

- MIME is built by `worker/src/mime/`, the one module that serialises headers, with RFC 2047 and RFC 2231 encoders that ship test vectors, every header folded under 78 characters and asserted under 998. Amended 2026-09-10 (plan 3): `mimetext` 3.0.28 was measured to emit attachment filenames raw inside quotes and was rejected. The message is a pull-based stream with an exact length: attachments are read from R2 one chunk at a time, so the isolate never holds a 25 MB attachment, its base64 and the message at once.
- Subject, recipient display names, attachment filenames and aliases are rejected if they contain CR, LF or NUL. Non-ASCII header values use RFC 2047 encoding; filenames use RFC 2231.
- Local filenames written by the companion: basename only, no `/`, `\`, `..` or NUL, NFC-normalised, Unicode control and bidi characters replaced with `_`.
- Anywhere the approval page shows attacker-influenced text, bidi and control characters are rendered as visible escapes.

### 3.9 Error handling

| Condition                                                 | Behaviour                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google 401                                                | refresh once, retry once; `invalid_grant` flips the account to `needs_reconnect`                                                                                                                                                |
| Google 429 or 403 rate limit                              | exponential backoff with jitter, honour `Retry-After`, at most 3 tries, and never retry a send after the request body has started                                                                                               |
| Google 5xx before the send body is sent                   | retry as above                                                                                                                                                                                                                  |
| Timeout or 5xx after the send body may have reached Gmail | operation stays `executing`, becomes `delivery_unknown`                                                                                                                                                                         |
| D1 error before any Gmail side effect                     | bounded retry, then `failed_safe`                                                                                                                                                                                               |
| D1 error after a Gmail side effect                        | the caller sees `executed` with `local_settlement_failed`; the operation may remain `executing`, the write failure goes to Workers observability, and reconciliation from the journal owns durable convergence on the next cron |
| Gmail rejects an attachment                               | surface the Gmail error verbatim as the tool error                                                                                                                                                                              |

### 3.10 Audit semantics

Two rows per mutating call: an `intent` row before any external side effect (tool, action, modifiers, decision), and an `outcome` row after. Read calls and denials write one `intent` row only. The operation journal, not the audit log, is authoritative for delivery. If the outcome write fails after Gmail succeeded, the tool still returns `executed` and the failure is reported to telemetry. Metadata only: no bodies, no full subjects, no tokens. Readable through `/audit`, never through an MCP tool.

## 4. OAuth flows, web UI, session security, testing

### 4.1 Tokens and audiences

| Holder          | Scope          | May call                                                            | Obtained via      |
| --------------- | -------------- | ------------------------------------------------------------------- | ----------------- |
| Claude clients  | `mcp`          | `/mcp` only                                                         | Flow A            |
| Companion       | `staging`      | `/staging/*` only                                                   | Flow C            |
| Owner's browser | session cookie | `/approve`, `/policy`, `/accounts`, `/audit`, `/connect`, `/logout` | Google OIDC login |

Per-client allowed scopes are enforced by our authorization handler, since the library does not: the pre-registered `companion` client may receive only `staging`; CIMD and DCR clients may receive only `mcp`; a request for any other combination is rejected before consent. Every API route also checks the token's scope and RFC 8707 audience. Google Gmail refresh tokens are held only by the Worker (Flow B).

### 4.2 Flow A: Claude to Worker

- `OAuthProvider` with `clientIdMetadataDocumentEnabled: true`, `allowPlainPKCE: false`, `resourceMetadata.resource` set to the canonical `/mcp` URL, and the `global_fetch_strictly_public` compatibility flag. It mounts `/authorize`, `/token`, `/register` and serves both well-known documents.
- Registration: Claude clients use CIMD when they offer it, DCR as deprecated compatibility. The companion is pre-registered. This matches the library's stated preference order.
- Redirect URIs: exact scheme, host and path match against the client's own registration. Loopback clients vary the port per RFC 8252 §7.3. The claude.ai client's registered URI is `https://claude.ai/api/mcp/auth_callback`. Claude Code registers `http://localhost:PORT/callback` (and used `127.0.0.1` in one release), so both loopback hosts are accepted for its registration. No wildcard allowlist exists.
- Consent page per Cloudflare guidance: sanitised client name and redirect URI, CSRF token, approved-clients cookie. Then Google OIDC with `openid email profile` only, `state` and one-use `nonce` in the `oauth_states` table in D1, consumed by the single atomic `UPDATE ... RETURNING` of 3.2. On return verify `id_token` signature, `iss`, `aud`, `exp`, `nonce`, `email_verified == true`, and `iat` within the last 10 minutes with 60 s of clock tolerance. The remembered-consent cookie is bound to the owner's `sub`, so a different owner in the same browser always sees the consent page. Require `sub ∈ OWNER_GOOGLE_SUBS`. Complete the grant with `props = { sub, email }`.
- Bootstrap: when `OWNER_GOOGLE_SUBS` is empty and `email ∈ OWNER_EMAILS`, the setup page displays the `sub` to paste into the secret and asks the owner to confirm the identity first, because for a non-Gmail, non-Workspace address `email_verified` means Google confirmed the address once, not that it remains authoritative. `OWNER_EMAILS` is consulted only while `OWNER_GOOGLE_SUBS` is empty, and it never grants a session.
- Profile-only scopes exempt this identity login from the 7-day Testing expiry.

### 4.3 Flow B: Worker to Google per account

- Entry: `connect_account(alias)` returns URL-mode elicitation to `/connect?alias=…&e=<signed elicitation id>`, or the Accounts page. `/connect` requires a session whose `user_id` matches.
- Scopes: `https://www.googleapis.com/auth/gmail.modify` plus `openid email`. `mail.google.com` is never requested, so permanent deletion is impossible at the scope level as well as the tool level.
- `access_type=offline`, `prompt=consent`, `state` and `nonce` in the `oauth_states` table in D1 bound to a hash of the session id, 600 s TTL, consumed once by the atomic update of 3.2. KV holds only `workers-oauth-provider` state, because a KV `get` followed by a `delete` is not a one-use consume.
- Callback: verify `state`, exchange code, verify `id_token`, upsert `accounts` on `(user_id, google_sub)`, fetch verified send-as addresses into `send_as`, encrypt tokens, audit `account.connect`. Revoke calls Google's revocation endpoint, wipes ciphertexts, marks `revoked`.

### 4.4 Google Cloud projects

| Project              | Publishing status                                 | Used by                                                                                                                                   |
| -------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `gmail-mcp-dev`      | Testing                                           | scratch Gmail account, integration tests. 7-day refresh expiry accepted, so the protected suite is manual only, run after a fresh consent |
| `gmail-mcp-personal` | In production, unverified, personal-use exemption | the owner's real accounts                                                                                                                 |

The verification and CASA exclusion holds only while this remains a personal-use system under 100 users known to the owner. General distribution changes the requirement: server-side storage of restricted-scope data then requires a third-party security assessment.

### 4.5 Flow C: Companion to Worker

`gmail-mcp-companion login` runs PKCE against the Worker's AS as the pre-registered public client `companion`, redirect `http://127.0.0.1:<ephemeral>/callback`, same Google OIDC identity step, token scope `staging` only. The native helper stores access and refresh tokens in macOS Keychain through Security.framework, with no secrets in argv or environment. A persisted epoch fences logout against older login commits. Staging routes check the bearer's `sub` against `staging_objects.user_id` inside the query.

### 4.6 Web pages and session security

Server-rendered HTML forms, no client JavaScript, no third-party assets.

| Page            | Purpose                                                                                                                                                                                                   | Guards                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/approve/<id>` | structured block (action, account, recipients, attachments with sizes) then a visibly delimited "untrusted email content" block with a plain-text body preview capped at 2 KB, no links; Approve and Deny | session match, CSRF, `Origin` check, POST is the atomic `pending → approved` transition (`WHERE state='pending' AND expires_at > now`); execution happens only through the claim in 3.4 |
| `/reauth`       | re-run Google OIDC and update `authenticated_at` on the current session                                                                                                                                   | session, CSRF                                                                                                                                                                           |
| `/accounts`     | list, connect, reconnect, revoke, set default, allowlist, send limit, org domains                                                                                                                         | session, CSRF, recent-auth for revoke                                                                                                                                                   |
| `/policy`       | action × level matrix, per-account overrides, blocked-extension set                                                                                                                                       | session, CSRF, recent-auth, audited as `policy.edit`                                                                                                                                    |
| `/audit`        | 90-day metadata log with filters                                                                                                                                                                          | session                                                                                                                                                                                 |
| `/logout`       | revoke current session                                                                                                                                                                                    | CSRF                                                                                                                                                                                    |

`form-action` names Google because browsers apply the directive to the redirect that follows a form post, and `/reauth` and `/connect` answer a post with a redirect to Google. The consent page adds the client's own redirect origin the same way. `/reauth` is a POST so it sits behind CSRF like every other state change.

The approval page renders a typed view per action family: recipients kept apart as To, Cc and Bcc for sends, target ids and counts for trash, spam and label actions, the label operation for label management, and the file for an upload. A payload whose shape has no view is printed in full, so nothing is ever approved blind. Trust-boundary settings on `/accounts` (recipient allowlist, organisation domains, raising the send limit, companion registration, revocation) require recent authentication and are audited as `policy.edit`. A policy edit and its audit row and the revocation of other sessions are one transaction, as are an approval decision and its audit row.

Session: `__Host-session` = 256-bit random opaque value; `web_sessions.id_hash` stores its sha256. HttpOnly, Secure, SameSite=Lax. Rotated after login. Absolute lifetime 12 h, idle timeout 2 h. Logout revokes immediately. Recent authentication means `authenticated_at` within the last 15 minutes; `last_seen_at` never counts. Policy edits and account revocations require recent authentication and revoke all other sessions.

CSRF: stateless per-form token = HMAC (secret `CSRF_HMAC_KEY`) over `session_id || method || route || object_id || expiry`, delivered in the form and recomputed on POST. A token for `/approve/A` cannot approve `/approve/B`.

Response headers on every page:

```
Cache-Control: no-store
Pragma: no-cache
Referrer-Policy: same-origin
Content-Security-Policy: default-src 'none'; style-src 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'
X-Content-Type-Options: nosniff
```

Amended 2026-09-19: the referrer policy was `no-referrer`, and this section asked for two things a
browser cannot both honour. Under `no-referrer` a browser serialises the Origin of its own
same-origin, non-CORS POST as the string `null` (Fetch, appending the Origin header), and the Origin
check above refuses `null` as it should. Every form on every page refused itself: approve, deny,
revoke, policy edits, logout and the client consent form. A `wrangler tail` against the deployment printed
`"origin": "null"` beside `"sec-fetch-site": "same-origin"`, and a local control serving both
policies confirmed the cause. `same-origin` still sends no referrer off this
origin, which is the property `no-referrer` was chosen for, and keeps the Origin header the CSRF
defence reads. The suite could not have caught this and still cannot without a browser: a test
builds its own Request and sets a correct Origin, so no test wears the header the page serves.

### 4.7 How the system is verified

**Four suites, and one gate is not the other.** The Worker suite runs inside the real workerd
runtime through `@cloudflare/vitest-plugin`, against D1, R2 and KV emulation with the migrations
applied as a binding; nothing in the storage layer is mocked, so a passing test means the SQL, the
transactions and the constraints work. Storage there is isolated per file rather than per test, so
a query filtered on `user_id` alone counts a neighbouring test's rows. The shared package runs as
plain TypeScript under Node with its own config. The companion suite runs under Node and drives the
CLI over stdio where it needs the real thing. The native suite is `swift test` against the Swift
helper, and it is the authority for the save receipt state machine, the exclusive rename and crash
recovery.

`npm run verify` is the gate CI runs: format, lint, typecheck and the TypeScript suites across the
workspaces. It does not compile or test Swift. `npm run verify:native` is the other half,
`swift test --package-path companion/native` followed by a release build. A change to the helper
owes both.

**Three rules the gauntlet converged on**, in order of how easily each is missed. An assertion must
not be vacuous: a loop over an empty array of observations passes without running one assertion.
The named guard must actually be reached, because a case can be sound and still never execute the
clause it was written around. And a mutation must have changed the region intended, because a
first-occurrence replace lands elsewhere and reports a false survival.

**What the unit layer covers**, table-driven where the input space allows it: the policy engine over
every action, level and modifier, including consumer against Workspace `+external`, `+tag`
stripping, Punycode domains and `@domain` boundaries; the state machine and operations, where no
sequence reaches `executed` twice, two concurrent claims yield one success, and a reused
idempotency key returns the first result without calling Gmail again; the crypto layer, where
decryption fails on AAD mismatch, an unknown key id and a truncated ciphertext, and keyring rotation
re-encrypts lazily; handles, where cross-account, cross-user, expired, reserved and post-TTL
acknowledgement are all refused and one handle in two sends yields one reservation; the argument
limits and blocked extensions, all refused before a row is written; the MIME encoders, including
RFC 2047 word length, RFC 2231 continuations and header injection; and the companion's path safety,
where traversal, symlink escape, every overwrite, and bidi or control components are refused.

**What the integration layer exercises** against a fake Gmail HTTP adapter: the full tool round
trips, the `ask` result shape, the approval page POST, elicitation resume, `send_draft`, and the
media-to-resumable selection at the 5 MB boundary in both directions.

**Fault injection** runs at each checkpoint, killing or throwing deliberately: operation inserted;
pending action claimed; attachments reserved; MIME construction begun; Google request headers sent;
Google request body partially sent; Google response received; before the D1 success write; after it;
before the audit outcome write. For each, assert either no duplicate external side effect or
`delivery_unknown` with no automatic retry.

**OAuth and web adversarial coverage**: redirect_uri substitution, authorization-code replay,
`state` replay, `nonce` replay, issuer mix-up, wrong audience, an expired `id_token`, session
fixation, a CSRF token from another pending action, open-redirect attempts, CIMD metadata tampering,
a DCR client requesting `staging`, an `mcp` token at `/staging` and a `staging` token at `/mcp`,
`execute_pending` replay, `requestState` tampered one field at a time, a retried elicitation call
with changed recipients, an approval URL opened under a different session, and `last_seen_at` alone
attempting a recent-auth action.

**Protected Gmail integration**, manual and pre-release only, never on forks. A dedicated scratch
account in `gmail-mcp-dev` whose mailbox holds no real mail, with the secret only in the protected
environment.

- **Message-ID preservation gate.** Send with a supplied `Message-ID` and find it by
  `rfc822msgid:`. Reconciliation in 3.5 is enabled only if this passes.
- Send with a staged attachment, fetch it back, sha256 matches.
- `send_draft` round trip, and the negative guarantee that reused headers or threads never
  automatically confirm an ambiguous draft send.
- Revoke the token in Google; the next call flips to `needs_reconnect` and returns a URL
  elicitation.
- Reply threading: `reply` produces a message Gmail shows in the original thread.
- **25 MiB download and 25 MiB send round trips.** A functional exercise of the buffering decision
  in 3.7, and not a memory qualification: see 4.8.

**End to end**, per client. MCP Inspector against `/mcp` for auth and schemas. Claude Code for `ask`
through native URL-mode elicitation, plus companion save and stage under both `allow` and `ask`.
Claude Desktop for `ask` through the approval link then `execute_pending`, companion save, and
overwrite refused. claude.ai for `ask` through the approval link then `execute_pending`, with no
companion.

Every adversarial test records both outcomes. A caught abuse is evidence the gate works.

No test count appears in this section, and none did before the rewrite either. Keeping it that way
is the point: a number here goes stale the next time anyone adds a test. Current counts live in one
published place, the Unreleased section of `CHANGELOG.md`, where they read as a snapshot rather than
as a requirement. They are deliberately not repeated elsewhere, and they are not in the working notes,
which are not part of the repository.

`docs/INVARIANTS.md` is canonical for the invariant set itself and names the implementation site
behind each one. `docs/superpowers/reviews/2026-09-17-full-project-gauntlet.md` is canonical for the
proof type behind each invariant as of 2026-09-18, the load-bearing predicate table, the
source-derived tool matrix and the findings; its matrix covers twenty-one invariants, which is what
existed when it was written. It is appended to, never rewritten.

### 4.8 Qualification, restore and the external gates

Release authority is not reachable today, and that is a property of the system rather than an
oversight. What follows is the machinery that would grant it, read out of `scripts/qualification/`,
and then why it cannot conclude.

**Build identity.** `computeBuildId` in `scripts/qualification/build-id.ts` hashes the production
inputs and nothing else. Its `production()` predicate selects everything under `worker/src/`,
`shared/src/` and `worker/migrations/`, plus eight named manifests and configs. `hashInputs` sorts
on path and length-prefixes both the path and the bytes, so the result does not depend on
enumeration order and no two input sets collide by concatenation. Two substitutions make the hash
mean something. `worker/src/build-identity.ts` is normalised back to its `unqualified` template
before hashing, so an identity never hashes itself, and the file is refused outright if the template
has been edited. `worker/wrangler.jsonc` is replaced by `canonicalConfig`, which is the private
effective configuration in canonical key order with `vars.BUILD_ID` removed; it throws on any
variable whose name matches `/SECRET|TOKEN|PASSWORD|KEKS|HMAC/i`, so a secret cannot enter a build
identity even by accident. A dirty or untracked production input is refused before any of it runs.
The served value today is `BUILD_ID = "unqualified"` in `worker/src/build-identity.ts`, which is
what a build with no qualified identity must say.

**What a run is.** `RunIdentity` in `contracts.ts` is version 2 and carries `runId`, a `purpose` of
either `recovery-mode` or `release-component`, the `target`, `preparationCommitment`,
`preparationRoot`, `manifestSha256`, `mode`, `qualificationEpoch` and `probeExpiresAt`. Its
refinement is the load-bearing part: a `recovery-mode` run must have a preparation root, a mode, an
epoch and an expiry, with `startedAt` before `probeExpiresAt`, and a `release-component` run must
have all four null. One shape cannot pose as the other.

The `target` is a `Snapshot` plus `userId`, `accountId` and `credentialVersion`. The snapshot pins
origin, platform account, worker name, database, deployment and deployment version, four build ids
for the worker, the qualification harness, the companion and the native helper, the config and
schema digests, the restore generation, the profile, and a `compatibilityVersion` fixed at 3.
`snapshotOf` drops the three account fields, which is how component evidence gathered under one
account is compared against a run's snapshot without the accounts having to match.

**What an observation binds.** `Observation` carries `identitySha256` and `sourceSha256`.
`identityHash(domain, value, canonicalize)` is a SHA-256 over `gmail-mcp/plan6/v2/<domain>`, a
newline, and the RFC 8785 canonicalisation the Worker itself uses, so every hash is
domain-separated and reproducible by anyone holding the inputs. The verifier refuses a row whose
`identitySha256` is not `identityHash("run", identity)`, and refuses a source whose
`identitySha256` differs from the row it supports, so an observation cannot be moved between runs
and a chain of derivations cannot cross one. `deriveCaseVerdict` fails a case unless every sample
id is distinct and every `safety` counter is zero.

**How the graph is checked.** `EvidenceVerifier.validateCase` recomputes `preparationRoot` from the
preparation identity, the closure's outcomes and the authorization, and refuses unless it matches
the report, and for a recovery-mode run the identity as well. `preparationRoot` refuses in turn
unless the authorization's `targetHash` is `identityHash("target", target)`, the preparation's
`authorizationSha256` is `identityHash("authorization", authorization)`, and the preparation expires
no later than the authorization. `assertModeReports` then requires the mode's proof case to be the
one `requiredProof` names for that mode, to pass, and to carry exactly three attempts and three
observations; and requires each of the nine `CommonCases` to appear exactly once, to pass, to be a
`release-component` run, and to share one snapshot hash.

**What release requires.** `assessRelease` is read-only and returns a verdict rather than granting
anything. It demands both modes and all nine common cases, refuses a run id or a qualification epoch
reused across the two modes, and refuses a null epoch. `qualification` reads `pass` only when both
modes and all nine components verify. `implementation` is hard-coded to `not_run` and
`implementation_incomplete` is always the first blocker, because implementation readiness is
code-owned and no manifest may assert it. Version-1 evidence stays readable as history and can grant
nothing: `loadEnableEvidence` rejects with "version-1 evidence cannot enable recovery; v2 admission
required".

**What an epoch changes.** The epoch is the qualification generation a lease was admitted under.
Replacing it stops work already in flight rather than only the next request, and it takes three
steps to do so. `qualificationFence` in `worker/src/operations/recovery-admission.ts` is a D1
assertion evaluated on every admission, matching `recovery_control` on origin, build id, account,
credential version, mode and `c.epoch=?` bound from the lease, so an epoch that has moved fails the
assertion rather than being read once at the start. The pass then reports `suspended`, and
`recoverDeliveries` computes `manual = suspended || next >= deadline` and writes `state='manual'`
while nulling the session key. `dueRecoveries` selects `r.state='active'` only, so nothing picks
that row up again. Re-arming it is an operator act.

Resource evidence is one of the nine mandatory components and it is missing, so qualification cannot
pass.

Restore has no controller. `prepareRestore` ends in refusal, and the six refusal predicates around
it are tested. No restore request can be issued today, so "no blind retry" currently holds **by
construction** and must be re-qualified the moment a restore controller exists. The same applies to
reconciliation of an uncertain restore response, which no code can reach.

| External guarantee                   | Status                                       | Why it cannot be closed from here                                                                                                                                                           |
| ------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Peak isolate memory                  | `not_run / measurement_unavailable`          | 128 MB is per isolate, shared with `waitUntil`, and isolates are reused across requests; invocation metrics are reservoir-sampled, so one successful request establishes nothing about peak |
| Restore execution and reconciliation | `not_run`                                    | no restore request can be issued                                                                                                                                                            |
| Authoritative writer quiescence      | `not_run / quiescence_unavailable`           | Time Travel cancels in-flight queries; it does not establish that a delayed or cross-host writer cannot write afterwards                                                                    |
| Cross-host deployment exclusion      | `not_run / deployment_exclusion_unavailable` | a local lock does not exclude another laptop, CI runner or operator                                                                                                                         |
| Provider commit barrier              | open refusal path                            | the provider does not expose whether a lost response committed                                                                                                                              |

A tested refusal path is not a satisfied external gate.

None of these may be closed with an operator boolean, an elapsed timeout, a successful request, Node
RSS or a mocked receipt. The gauntlet record in
`docs/superpowers/reviews/2026-09-17-full-project-gauntlet.md` is canonical for their classification
and for the evidence behind it.

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
    native/          Swift helper: Darwin filesystem calls, SQLite, Security.framework
    test/
  scripts/qualification/   build identity, evidence graph, controllers, release assessment
    test/
  docs/ARCHITECTURE.md                                     orientation and trust boundaries
  docs/INVARIANTS.md                                       the canonical invariant index
  docs/runbooks/                                           Google Cloud, companion, release, qualification
  docs/superpowers/specs/2026-09-09-gmail-mcp-design.md   (this file)
  docs/parity/hosted-2026-09-09.json                       (Appendix A schemas, captured in plan task 0)
```

`shared`, `worker`, `companion` and `scripts/qualification` are the four npm workspaces the root gate
runs across. Section 1.1 names neither the native helper nor the qualification harness, because both
arrived after it was written and both are now load-bearing: the helper is the authority for the save
receipt state machine, and the harness is where build identity and the evidence graph live.

TypeScript for the Worker and companion protocol; Swift, Darwin C wrappers and SQLite for native authority. Every dependency is pinned exactly and the committed lockfile is normative for versions; this document names none, because a version written in prose goes stale the first time the lockfile moves. The Worker uses Cloudflare's MCP package and `@cloudflare/workers-oauth-provider` (tested at 0.10.3). Companion uses the MCP TypeScript SDK 2.x over stdio.

## 6. Deferred (signed IOUs)

- Batch label, trash and spam tools, with `+bulk` applied to them.
- `search_threads(account="all")` fan-out across accounts.
- Companion as a full local proxy re-exposing every tool with path parameters (Approach B).
- Multi-user signup replacing `OWNER_GOOGLE_SUBS`.
- Gmail app verification and CASA.
- Streaming base64url extraction for downloads above 25 MB.
- Phase B byte continuation.
- `P4-OVERWRITE`: the overwrite design the `+overwrite` modifier is reserved for. V1 refuses every
  overwrite and nothing emits the modifier.

The complete register of deferred and retired items is
`docs/superpowers/plans/2026-09-15-gmail-mcp-deferred-feature-register.md`, which is canonical and
carries its own reconciliation against source dated 2026-09-19. The list above is a summary and the
register wins where they differ; the register also holds one entry this summary omits, `P7-STUCK-DEBT`,
a charged save receipt whose temporary exists but no longer matches its recorded device and inode.
`docs/superpowers/reviews/2026-09-17-full-project-gauntlet.md` holds a separate reconciliation of the
same register as of 2026-09-18, which is evidence about the register rather than the register itself.

Retired: the `X-Claude-Audit-Id` header on sent mail. An internal audit id has no business travelling to recipients' mail servers.

## Appendix A: hosted connector baseline (captured 2026-09-09)

Tool names observed on the hosted Claude Gmail connector this date. Input and output schemas are captured verbatim into `docs/parity/hosted-2026-09-09.json` as the first implementation task; parity below is at the level of name and purpose, and the schema file is the contract the tests check.

| Hosted tool                                                                                   | Ours                                                                   | Status                                                                                                  |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `search_threads`, `get_thread`, `get_message`, `list_drafts`, `get_draft`, `list_labels`      | same                                                                   | parity, plus pagination and size parameters                                                             |
| `create_draft`, `update_draft`                                                                | same                                                                   | parity; attachments become handles, inline capped                                                       |
| `send_message`                                                                                | same                                                                   | new mail only: `draftId` moved to `send_draft`, `replyThreadId` and `replyToMessageId` moved to `reply` |
| `reply`                                                                                       | same                                                                   | parity; Worker derives threading headers from the target message                                        |
| `forward`                                                                                     | same                                                                   | parity except original attachments excluded by default                                                  |
| `create_label`, `update_label`, `delete_label`                                                | same                                                                   | parity                                                                                                  |
| `label_message`, `unlabel_message`, `label_thread`, `unlabel_thread`, `update_message_labels` | same                                                                   | parity                                                                                                  |
| `apply_sensitive_message_label`, `apply_sensitive_thread_label`                               | same                                                                   | parity, carries `+sensitive`                                                                            |
| `mark_message_spam`, `mark_thread_spam`, `unmark_message_spam`, `unmark_thread_spam`          | same                                                                   | parity                                                                                                  |
| `trash_message`, `trash_thread`, `untrash_message`, `untrash_thread`                          | same                                                                   | parity                                                                                                  |
| (none)                                                                                        | `download_attachment`                                                  | extension                                                                                               |
| (none)                                                                                        | `send_draft`                                                           | extension (replaces hosted `send_message(draftId)`)                                                     |
| (none)                                                                                        | `list_accounts`, `connect_account`, `get_policy`, `open_policy_editor` | extension                                                                                               |
| (none)                                                                                        | `list_pending`, `execute_pending`, `cancel_pending`                    | extension                                                                                               |

Hosted count 29. Ours 38. Intentional omissions: none.
