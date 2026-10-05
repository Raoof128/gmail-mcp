# Outlook provider design (spec v2)

Status: design draft. Nothing here has implementation acceptance, and nothing here changes a current
guarantee. [INVARIANTS.md](../../INVARIANTS.md), [SECURITY.md](../../../SECURITY.md) and the README describe
the system as it is, so they are amended in the same change that ships the code each amendment describes,
and not before.

Revision history:

- v0, 2026-10-05, stated in chat and never committed.
- v1, 2026-10-05, the Gmail-parity subset: 27 of 38 tools, 11 refused.
- v2, 2026-10-05, this document. The owner asked for coverage of everything the Microsoft Graph mail API
  exposes, not a parity subset. v2 inventories the whole v1.0 mail surface, gives every endpoint a
  disposition, supports all 38 existing tools on Outlook, and adds 25 Outlook tools.

Every change traces to a finding in [the Outlook spec gauntlet](../reviews/2026-10-05-outlook-spec-gauntlet.md)
(G1 to G46) and to an amendment (A1 to A24). Claims about Microsoft behaviour carry the gauntlet's grades:
V (verbatim on a primary Microsoft Learn page, October 2026), S (secondary), U (the documentation is
silent) and P (needs a live probe). Nothing in this spec is live evidence. No request was made to Graph or
Entra while writing it.

## 1. Goal and non-goals

Goal: connect an owner's Outlook mailbox through Microsoft Graph v1.0 behind the same policy, approval,
audit, journal, staging and companion machinery, and expose every part of the Graph mail API that can be
offered without breaking an invariant. Where a guarantee is weaker for Outlook, this spec says so and
names the proof type that replaces it. Where an endpoint is not offered, section 4 says why.

Not in scope:

- Multi-tenant distribution and other owners (`P6-MULTI-USER`).
- Shared mailboxes, delegation, send-as aliases, send-on-behalf and every `*.Shared` scope.
- Administrator APIs under `/admin/exchange`: mailbox export and import, `mailboxItem` delete, message
  trace. They need administrator-consented scopes, do not work for personal accounts, and one of them
  hard-deletes (V).
- Beta endpoints. Section 4 lists the ones that matter and why each stays out.
- Calendar, contacts and tasks, though they share the Outlook mailbox.
- EWS, IMAP and SMTP. EWS in Exchange Online is disabled from October 2026 and fully off in April 2027 (V).
- Any `Mail-Advanced.*` permission. From 31 December 2026 it gates changes to sensitive properties of
  non-draft messages; drafts are unaffected (V). Nothing here edits a sent or received message's
  sensitive properties.
- Changing the Google owner login. Microsoft identity is only ever an account being connected.

## 2. Pinned facts

The Gmail design pins every platform choice to a fact and a source (its 1.2). This table does the same for
Graph. The full citations are in the gauntlet's references.

| Choice                                              | Fact it rests on                                                                                                                                                      | Grade          | Source                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| Graph v1.0 only                                     | Beta APIs "are subject to change" and are not supported for production use                                                                                            | V              | each beta page's banner                                             |
| `Prefer: IdType="ImmutableId"` on every request     | "This header only applies to the request it is included with"                                                                                                         | V              | graph/outlook-immutable-id                                          |
| Folder ids are stable without the header            | "Container types (mailFolder, calendar, etc.) don't support immutable ID, but their regular IDs were already constant"                                                | V              | graph/outlook-immutable-id                                          |
| The draft id may or may not survive send            | The immutable-id page tells you to fetch the Sent copy with the draft's id. The mail overview says immutable ids hold "with the exception of sending a draft message" | V, conflicting | graph/outlook-immutable-id, resources/mail-api-overview             |
| `internetMessageId` can be stamped on a draft       | "Updatable only if isDraft = true"                                                                                                                                    | V              | api/message-update                                                  |
| No scope separates drafting from deleting           | `Mail.ReadWrite` is the only permission for message and folder `permanentDelete`; nothing narrower exists                                                             | V              | api/message-permanentdelete, api/mailfolder-permanentdelete         |
| DELETE on a message or folder is not offered        | Neither page says whether the item goes to Deleted Items                                                                                                              | U              | api/message-delete, api/mailfolder-delete                           |
| Trash is a move                                     | The move page's own example moves to `deleteditems`                                                                                                                   | V              | api/message-move                                                    |
| Every send is draft-first                           | `sendMail`, `send`, `reply`, `replyAll` and `forward` all return 202 with no body and no id                                                                           | V              | api/user-sendmail, api/message-send, api/message-reply              |
| Draft creation returns the id                       | `POST messages`, `createReply`, `createReplyAll`, `createForward` return 201 with the message                                                                         | V              | api/user-post-messages, api/message-createreply                     |
| Attachments: under 3 MB direct, 3 to 150 MB session | A session for a file under 3 MB fails with `ErrorAttachmentSizeShouldNotBeLessThanMinimumSize`; bytes go in order, chunks under 4 MB recommended                      | V              | graph/outlook-large-attachments                                     |
| Upload chunks carry no bearer token                 | "Do not specify an Authorization request header. The PUT query uses a pre-authenticated URL"                                                                          | V              | graph/outlook-large-attachments                                     |
| Mailbox concurrency                                 | Per app per mailbox: 10,000 requests per 10 minutes, four concurrent, 150 MB uploaded per 5 minutes                                                                   | V              | graph/throttling-limits                                             |
| `$batch` is no escape from the limits               | At most 20 requests; Outlook runs at most four of them at a time; each is throttled individually                                                                      | V              | graph/json-batching                                                 |
| Search                                              | `$search` is KQL, returns at most 1,000 results ordered by sent date                                                                                                  | V              | graph/search-query-parameter                                        |
| `$search` with `$filter`                            | Rejected on `/messages` with `SearchWithFilter`                                                                                                                       | S              | Microsoft Q&A                                                       |
| `$filter` with `$orderby`                           | Order properties must appear in the filter, first and in the same order, or `InefficientFilter`                                                                       | V              | api/user-list-messages                                              |
| Delta is per folder                                 | Supports `@removed`; filter only `receivedDateTime ge/gt`, capped at 5,000 messages; token lifetime "isn't fixed"                                                     | V              | graph/delta-query-messages, graph/delta-query-overview              |
| Plain-text bodies                                   | `Prefer: outlook.body-content-type="text"`, confirmed by `Preference-Applied`                                                                                         | V              | api/message-get                                                     |
| Never request unsafe HTML                           | `Prefer: outlook.allow-unsafe-html` returns unsanitised HTML                                                                                                          | V              | graph/outlook-create-send-messages                                  |
| Category names are immutable                        | "You can't modify the displayName property once you have created the category"; names are unique per mailbox                                                          | V              | api/outlookcategory-update                                          |
| Inbox rules can forward and destroy                 | Rule actions include `forwardTo`, `redirectTo`, `forwardAsAttachmentTo`, `delete` and `permanentDelete`                                                               | V              | resources/messageruleactions                                        |
| Change notifications                                | Message subscriptions last at most 10,080 minutes, or 1,440 with resource data; 1,000 per mailbox; validation reply within 10 seconds; folders are not subscribable   | V              | resources/subscription, graph/outlook-change-notifications-overview |
| Limits                                              | 500 recipients; 30 messages a minute; 10,000 recipients a day; 35 MB default message size, configurable to 150 MB; 250 attachments; 256 KB of headers                 | V              | resources/message, Exchange Online limits                           |
| Consent                                             | The default tenant policy blocks user consent to `Mail.*` and `MailboxSettings.*`. Personal accounts can consent to both                                              | V              | manage-app-consent-policies, permissions-reference                  |
| Identity                                            | Key on `tid` and `oid`; `oid` needs the `profile` scope; `email` is mutable; personal `tid` is `9188040d-6c67-4c5b-b112-36a304b66dad`                                 | V              | claims-validation, id-token-claims-reference                        |
| Refresh tokens rotate                               | A new one on every use, the old one not revoked, 90 days by default                                                                                                   | V              | refresh-tokens                                                      |
| Client credential                                   | Secrets capped at 24 months; certificates or federated credentials recommended for production                                                                         | V              | how-to-add-credentials                                              |

## 3. What is reused and what gets a provider seam

The policy engine, approval, audit, idempotency, staging and the companion are reused. These are not, and
each gets a seam in Phase 1:

| Area                   | Gmail today                                                    | Why it cannot be shared                                                |
| ---------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Identity verification  | `verifyIdToken` in `worker/src/google/oidc.ts`                 | Requires `email_verified` and a Google issuer (G2)                     |
| Token refresh          | `RefreshResponse` drops `refresh_token`                        | Entra rotates refresh tokens on every use (G3)                         |
| Recovery egress        | `allowed()` in `recovery-http.ts` hard-codes `GOOGLE.tokenUrl` | Needs the Entra token URL and the Graph send route (G3)                |
| Id schema              | `GmailId`, `[A-Za-z0-9_-]`                                     | Graph ids carry `=` padding (G21)                                      |
| Sensitivity classifier | `isSystemLabel`, `/^[A-Z][A-Z0-9_]*$/`                         | Folders and categories never match, so `+sensitive` would be lost (G8) |
| Send pipeline          | MIME build, resumable upload, `GMAIL_SEND_MAX`                 | Graph sends JSON drafts with attachment sessions (G10)                 |
| Concurrency            | none                                                           | Graph allows four concurrent requests per mailbox (G6)                 |

## 4. The Graph mail surface and its disposition

Every v1.0 mail endpoint, grouped. "Offered" means a tool reaches it. "Internal" means the Worker calls it
and no tool exposes it directly. "Refused" means `graphFetch` has no route for it, so no code path can
reach it, and the mutation test in 6.2 proves that for the destructive ones.

### 4.1 Messages and drafts

| Endpoint                                              | Disposition    | Through                                        | Why                                                                                 |
| ----------------------------------------------------- | -------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET messages`, `mailFolders/{id}/messages`           | Offered        | `search_threads`, `list_folder_messages`       |                                                                                     |
| `GET messages/{id}`                                   | Offered        | `get_message`, `get_thread`, `get_draft`       |                                                                                     |
| `GET messages/{id}/$value` (MIME)                     | Offered        | `export_message`                               | The bytes go to staging as `.eml`, never into a tool result                         |
| `POST messages` (JSON)                                | Offered        | `create_draft`, every send                     |                                                                                     |
| `POST messages` (MIME)                                | Refused        |                                                | Recipients sit inside base64, out of sight of the policy engine (G34)               |
| `PATCH messages/{id}`                                 | Offered        | drafts, `update_message_state`, category tools | Only the properties in 7.4 are ever sent                                            |
| `DELETE messages/{id}`                                | Refused        |                                                | Undocumented destination (U), invariant 7b                                          |
| `POST …/permanentDelete`                              | Refused        |                                                | Invariant 7b, under every path prefix including `/users/{id}` (G31)                 |
| `POST messages/{id}/move`                             | Offered        | trash, spam, archive, `move_message`           | Every move is classified (7.2)                                                      |
| `POST messages/{id}/copy`                             | Offered        | `copy_message`                                 |                                                                                     |
| `POST createReply`, `createReplyAll`, `createForward` | Offered        | `reply`, `forward`                             | They return the draft and its id                                                    |
| `POST messages/{id}/send`                             | Offered        | every send                                     | The only route that sends                                                           |
| `POST reply`, `replyAll`, `forward`, `sendMail`       | Refused        |                                                | 202 with no id, so no settlement key; MIME variants hide recipients (G33)           |
| `GET mailFolders/{id}/messages/delta`                 | Offered        | `sync_folder`                                  |                                                                                     |
| Single- and multi-value extended properties           | Internal, read | the Worker reads `PR_` properties it needs     | Writing raw MAPI properties can change anything a client shows. No tool writes them |
| Open extensions                                       | Refused        |                                                | Application-private data with no owner value; their DELETE is one more delete route |
| `internetMessageHeaders` on create                    | Refused        |                                                | The retired `P6-AUDIT-HEADER` rule: no `x-` header leaves the service               |

### 4.2 Attachments

| Endpoint                                            | Disposition | Through                                                              | Why                                                                                  |
| --------------------------------------------------- | ----------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET messages/{id}/attachments`, `…/{id}`           | Offered     | `get_message`, `download_attachment`                                 |                                                                                      |
| `GET …/attachments/{id}/$value`                     | Offered     | `download_attachment`                                                | File attachments stream as bytes; item attachments arrive as MIME and save as `.eml` |
| `POST messages/{id}/attachments` (file, under 3 MB) | Offered     | drafts and sends                                                     | Only on a draft this service created                                                 |
| `POST …` item attachment                            | Offered     | `forward` with `as_attachment`, `attach_from_message` with `as_item` | Capped at 3 MB (V)                                                                   |
| `createUploadSession`, `PUT`/`DELETE {uploadUrl}`   | Offered     | drafts and sends                                                     | `uploadFetch` only (6.1)                                                             |
| Reference attachments                               | Read only   | listed as not downloadable                                           | `$value` returns 405 (V); creating one needs beta properties                         |
| `DELETE messages/{id}/attachments/{id}`             | Refused     |                                                                      | `update_draft` replaces the draft instead (8.3)                                      |

### 4.3 Folders and search folders

| Endpoint                                  | Disposition | Through                                 | Why                                                              |
| ----------------------------------------- | ----------- | --------------------------------------- | ---------------------------------------------------------------- |
| `GET mailFolders`, `childFolders`, `{id}` | Offered     | `list_folders`, `list_labels`           | Always with `includeHiddenFolders=true` (G42)                    |
| `GET mailFolders/delta`                   | Internal    | folder cache                            | Folders are not subscribable (V), so delta keeps the cache fresh |
| `POST mailFolders`, `childFolders`        | Offered     | `create_folder`                         |                                                                  |
| `PATCH mailFolders/{id}`                  | Offered     | `rename_folder`, `update_search_folder` |                                                                  |
| `POST mailFolders/{id}/move`              | Offered     | `move_folder`, `trash_folder`           | `trash_folder` is a move to `deleteditems`                       |
| `POST mailFolders/{id}/copy`              | Offered     | `copy_folder`                           | Copies the contents too (V)                                      |
| `DELETE mailFolders/{id}`                 | Refused     |                                         | Undocumented destination (U), invariant 7b                       |
| `POST mailFolders/{id}/permanentDelete`   | Refused     |                                         | "Permanently deleted folders are removed from the mailbox" (V)   |
| `POST childFolders` as `mailSearchFolder` | Offered     | `create_search_folder`                  | They expire after 45 days unused (V); the result says so         |
| `POST mailFolders/{id}/messages`          | Refused     |                                         | Plants an item in any folder. Drafts are created in Drafts only  |

### 4.4 Categories

| Endpoint                               | Disposition | Through        | Why                                                                                                            |
| -------------------------------------- | ----------- | -------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET outlook/masterCategories`         | Offered     | `list_labels`  |                                                                                                                |
| `POST outlook/masterCategories`        | Offered     | `create_label` | `color` is one of `none` and `preset0` to `preset24` (V)                                                       |
| `PATCH outlook/masterCategories/{id}`  | Offered     | `update_label` | Colour only. A rename is refused with `immutable_on_provider` (V)                                              |
| `DELETE outlook/masterCategories/{id}` | Offered     | `delete_label` | Deletes a definition, not mail, like Gmail's `delete_label`. What happens to tagged items is U; P13 records it |

### 4.5 Inbox rules

| Endpoint                                       | Disposition | Through       | Why                                                                                  |
| ---------------------------------------------- | ----------- | ------------- | ------------------------------------------------------------------------------------ |
| `GET mailFolders/inbox/messageRules`, `…/{id}` | Offered     | `list_rules`  | Flags every rule that forwards, redirects or deletes, including rules made elsewhere |
| `POST mailFolders/inbox/messageRules`          | Offered     | `create_rule` | Policy in 7.5. A `permanentDelete` action is refused outright                        |
| `PATCH …/messageRules/{id}`                    | Offered     | `update_rule` | Same policy as create, evaluated on the merged rule                                  |
| `DELETE …/messageRules/{id}`                   | Offered     | `delete_rule` | Deletes a rule, not mail                                                             |

### 4.6 Mailbox settings, Focused Inbox and MailTips

| Endpoint                                                                                | Disposition | Through                                       | Why                                                            |
| --------------------------------------------------------------------------------------- | ----------- | --------------------------------------------- | -------------------------------------------------------------- |
| `GET mailboxSettings`                                                                   | Offered     | `get_mailbox_settings`                        |                                                                |
| `PATCH mailboxSettings` (`automaticRepliesSetting`)                                     | Offered     | `set_auto_reply`                              | `+external` unless `externalAudience` is `none` (7.6)          |
| `PATCH mailboxSettings` (time zone, language, formats, working hours, meeting delivery) | Offered     | `update_mailbox_settings`                     | Changing delegate meeting delivery is `+sensitive`             |
| `GET outlook/supportedLanguages`, `supportedTimeZones`                                  | Internal    | validates `update_mailbox_settings` arguments |                                                                |
| `GET`, `POST`, `PATCH inferenceClassification/overrides`                                | Offered     | `list_focus_overrides`, `set_focus_override`  | Moving a sender to Other is `+sensitive`: it buries their mail |
| `DELETE inferenceClassification/overrides/{id}`                                         | Offered     | `remove_focus_override`                       | Deletes a preference, not mail                                 |
| `POST getMailTips`                                                                      | Offered     | `get_mail_tips`, and before every send        | Can only raise a modifier, never lower one (8.5)               |

### 4.7 Change notifications and batching

| Endpoint                                               | Disposition | Through                                             | Why                                                                                   |
| ------------------------------------------------------ | ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `POST`, `PATCH`, `DELETE subscriptions`, `reauthorize` | Internal    | send observation and folder-cache refresh (Phase 6) | Basic notifications only, no resource data, `notificationUrl` pinned to this Worker   |
| `$batch`                                               | Internal    | thread tools                                        | Built by the Worker from allowlisted routes only. A caller can never supply one (G30) |

### 4.8 Excluded by version or audience

| Endpoint                                                     | Why                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `reportMessage`, `markAsJunk`, `markAsNotJunk`               | Beta. `markAsJunk` also edits the blocked-senders list and was deprecated on 30 December 2025 (V) |
| `unsubscribe`                                                | Beta, and it sends an email and moves the message to Deleted Items (V)                            |
| `recall`                                                     | Beta                                                                                              |
| `mentions`                                                   | Beta                                                                                              |
| `updateAllMessagesReadState` on a folder                     | Beta                                                                                              |
| `/admin/exchange/mailboxes/…` export, import, items, folders | Administrator consent, no personal accounts, and `disposalType=hardDelete` (V)                    |
| `/admin/exchange/tracing/messageTraces`                      | Administrator scope                                                                               |

## 5. Identity and connect (A4, A5, A16)

### 5.1 Registrations and endpoints

| Registration       | Supported account types | Authorize and token endpoints                                 | Expected `tid`                             |
| ------------------ | ----------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| `outlook-personal` | Personal accounts only  | `https://login.microsoftonline.com/consumers/oauth2/v2.0/…`   | `9188040d-6c67-4c5b-b112-36a304b66dad` (V) |
| `outlook-tenant`   | This directory only     | `https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/…` | the configured tenant id                   |

The owner picks the registration on the connect page; it is never inferred from an address. Work and
school tenants need their administrator to consent, because the default policy blocks user consent to
every `Mail.*` and `MailboxSettings.*` scope this design needs (V, G20, G38). That is decision D1.

### 5.2 Scopes

`openid profile offline_access User.Read Mail.ReadWrite Mail.Send MailboxSettings.ReadWrite`.

- `profile` is required for `oid` (V).
- `MailboxSettings.ReadWrite` covers categories, rules, settings and is consentable by personal accounts
  (V). In a work tenant it adds no consent cost, since `Mail.ReadWrite` already needs the administrator.
- `connect` refuses a grant carrying any `Mail-Advanced.*`, `*.Shared`, `MailboxItem.*`, `MailboxFolder.*`
  or `*.All` scope, mirroring the Gmail check that refuses a grant without `gmail.modify` and never asks for
  `https://mail.google.com/`. A negative test covers each family.

### 5.3 Authorization code flow

Confidential client with PKCE (S256), which Microsoft recommends "for all application types, both public
and confidential clients" (V). The client authenticates with a certificate: the Worker signs a
`private_key_jwt` assertion with WebCrypto, using a private key held in a Worker secret (D4). The Google flow
has no PKCE today; the deferred register records that.

### 5.4 Identity verifier

`verifyMicrosoftIdToken` is separate from the Google verifier, so neither can be loosened by editing the
other.

1. Signature against `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`, fetched per
   verification as the Google verifier already does. Keys "could be rolled over immediately" (V).
2. `aud` equals the registration's client id.
3. `tid` is a GUID and equals the registration's expected `tid`.
4. `iss` equals exactly `https://login.microsoftonline.com/{tid}/v2.0` (V).
5. `oid` is present and a GUID.
6. `nonce` matches the consumed state row.

The account subject is `ms:{tid}:{oid}` (V: "use the immutable claim values tid and oid as a combined
key"). `email` and `preferred_username` never identify anyone (V: mutable). The display address comes from
`GET /me` (`mail`, else `userPrincipalName`) and is a label.

Tests: an issuer whose tenant differs from `tid`; a personal token at the tenant registration and the
reverse; no `email`; no `oid`; the same `oid` returning with a new address, which must update one account
and never create a second.

### 5.5 Token lifecycle and error taxonomy

Each refresh returns a new refresh token and does not revoke the old one (V). The refresh schema gains an
optional `refresh_token`, written through the existing `guardedWrite` fenced on `credential_version`. Losing
that race discards the newer token, which is safe: the old one stays valid for its lifetime.

No page maps an AADSTS code to an OAuth `error` value, so the classifier keys on `error` and uses the code
only for the message shown to the owner.

| OAuth `error`          | Codes (texts V)                                  | Result                                                                                                                                          |
| ---------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_grant`        | 70000, 700082 (inactivity), 50173 (revoked)      | `needs_reconnect`                                                                                                                               |
| `interaction_required` | 50076, 50079 (MFA)                               | `needs_reconnect`, "sign in again"                                                                                                              |
| `consent_required`     | 65001                                            | `needs_reconnect`, "consent"                                                                                                                    |
| `invalid_client`       | 7000215, 7000222 (credential invalid or expired) | Operator fault. Every account on that registration is held and the owner is told to rotate the certificate. Never `internal`, never per account |
| other, or 5xx          |                                                  | `internal`, transient                                                                                                                           |

## 6. Graph transport (A6, A7, A10, A14, A15, A17)

### 6.1 Two transports

| Transport     | Host                                                  | `Authorization` | `Prefer: IdType="ImmutableId"` | Used for                        |
| ------------- | ----------------------------------------------------- | --------------- | ------------------------------ | ------------------------------- |
| `graphFetch`  | `graph.microsoft.com`, path prefix `/v1.0/me/`        | yes             | every request                  | everything but upload chunks    |
| `uploadFetch` | learned in P8; documented as `outlook.office.com` (V) | never (V)       | no                             | upload-session `PUT` and cancel |

`graphFetch` refuses every other host, every `/beta/` path and every `/users/` path. `uploadFetch` checks
the session URL with a validator written from the P8 capture, as `validateSessionUrl` was for Gmail. The
upload URL is a bearer credential (V), so it is never logged and never enters a tool result. One test drives
every Outlook tool through the fake and fails if a Graph request lacks the immutable-id header, if an
upload request carries `Authorization`, or if any request sends `Prefer: outlook.allow-unsafe-html`.

### 6.2 Route allowlist and invariant 7b

`graphFetch` accepts only enumerated method and path shapes: the "Offered" and "Internal" rows of section 4.
The only DELETE routes are on `masterCategories/{id}`, `messageRules/{id}`,
`inferenceClassification/overrides/{id}` and `subscriptions/{id}`. None of them holds mail. No route
matches `DELETE` on a message, folder or attachment, and no route matches `permanentDelete` under any
prefix. `$batch` bodies are assembled by the Worker, and every sub-request passes the same allowlist before
the batch is sent.

`Mail.ReadWrite` cannot be narrowed (V), so invariant 7 splits:

- **7a, Gmail.** Scope-enforced, unchanged.
- **7b, Outlook.** Code-enforced at `graphFetch`. Proof type: a mutation test that adds each refused route
  in turn (message DELETE, folder DELETE, attachment DELETE, `permanentDelete` under `/me` and `/users`, a
  rule with a `permanentDelete` action, a caller-supplied `$batch`) and must turn the suite red each time.
- SECURITY.md gains the residual row: a leaked Outlook access token can permanently delete, and a leaked
  Gmail token cannot.

### 6.3 Ids (A14)

`ProviderId` per provider. Outlook ids are URL-safe base64 with optional padding,
`^[A-Za-z0-9_-]+={0,2}$`, up to 512 characters. The examples show `-`, `_` and a trailing `=`, never `+` or
`/`; the REST id character set is undocumented (U), so P12 records it. An id outside the schema is refused,
never widened silently. Ids are case-sensitive (V) and always path-encoded. Every tool that moves an item
returns the post-move id.

### 6.4 Concurrency and throttling (A10)

The limiter is a Durable Object keyed on the account id, because an isolate-local semaphore does not span
isolates. That is new infrastructure and its design is a Phase 1 deliverable. It holds at most three
concurrent requests, keeping one of the mailbox's four for the cron and recovery, and an upload budget
against 150 MB per 5 minutes. A `$batch` counts as one slot, because Outlook runs at most four of its
requests at a time (V). It serialises category writes per message (G23), and send admissions per account
against 30 messages a minute (V). A `429` honours `Retry-After`.

## 7. Policy: actions, modifiers and classification (A18 to A21)

### 7.1 New actions

Four actions join `ACTIONS` in `shared/src/actions.ts`. The `action` columns carry no CHECK constraint, so
this is additive, and the policy and audit pages read the list.

| Action             | Meaning                                                                 | Default |
| ------------------ | ----------------------------------------------------------------------- | ------- |
| `folder.manage`    | create, rename, move, copy or trash a folder or search folder           | ask     |
| `message.organize` | move or copy a message, or change read state, flag, importance or focus | allow   |
| `rule.manage`      | create, update or delete an inbox rule                                  | ask     |
| `settings.edit`    | change mailbox settings, automatic replies or Focused Inbox overrides   | ask     |

Reads of folders, rules, settings, overrides and MailTips use the existing `read.message`. No new
modifier is needed: `+external`, `+bulk` and `+sensitive` already say what is wrong.

### 7.2 Folder classification (A9, A19)

The classifier is `classifyTarget`, supplied by the provider, never the shape of a string.

| Target                                                                                                                                                                                                      | Gmail analogue       | Modifier                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------ |
| `deleteditems`                                                                                                                                                                                              | `TRASH`              | `+sensitive`             |
| `junkemail`                                                                                                                                                                                                 | `SPAM`               | `+sensitive`             |
| `archive`, or any move out of `inbox`                                                                                                                                                                       | removing `INBOX`     | `+sensitive`             |
| a hidden folder (`isHidden`), or creating one                                                                                                                                                               | none                 | `+sensitive`             |
| `inbox`, user folders, as a restore target                                                                                                                                                                  | `INBOX`, user labels | `+sensitive`             |
| a category                                                                                                                                                                                                  | a user label         | none                     |
| `recoverableitemsdeletions`, `outbox`, `drafts`, `sentitems`, `scheduled`, `conflicts`, `syncissues`, `localfailures`, `serverfailures`, `conversationhistory`, `clutter`, `msgfolderroot`, `searchfolders` | system labels        | refused as a move target |

`recoverableitemsdeletions` holds soft-deleted items that the retention policy purges (V), so a move there
is a delayed permanent delete and is refused under invariant 7b (G45). A move into Deleted Items is how
Outlook trashes and a move into a hidden folder is how mail hides, so every move is `+sensitive`, as
removing `INBOX` already is for Gmail. A matrix test covers every well-known
name, and the mutation that neutralises the predicate must turn it red.

### 7.3 Category writes (G23)

A message's `categories` is a collection of display names (V), so a label edit is read, modify and write of
the whole collection. Writes to one message are serialised by the limiter, and P13 tests whether `If-Match`
on `@odata.etag` is honoured.

### 7.4 Message state

`update_message_state` sends only `isRead`, `flag` (status, start, due, completed), `importance` and
`inferenceClassification`. A due date needs a start date or Graph returns 400 (V), so the tool requires both.
Setting `inferenceClassification` to `other` is `+sensitive`. Nothing else on a received message is
patched, which keeps every change clear of the `Mail-Advanced` boundary.

### 7.5 Rules (A20, G32)

Rules run on the server after this service is gone, so they get the strictest policy here.

- A `permanentDelete` action is refused with `forbidden`, whatever the policy (invariant 7b).
- `forwardTo`, `redirectTo` and `forwardAsAttachmentTo` targets are recipients, checked against the trusted
  set exactly as a send is: any outside target is `+external`, more than ten is `+bulk`.
- A `delete` action, a `moveToFolder` into any target that 7.2 marks `+sensitive`, or `markAsRead` together
  with a move is `+sensitive`. That combination is the classic way to hide forwarded mail.
- The approval summary renders the rule in plain words, conditions and actions both.
- `list_rules` marks each rule that forwards, redirects or deletes, so an owner can find one an attacker
  left. Tenants may already block external forwarding with an NDR (V), and P15 records what a personal
  account does.

### 7.6 Settings (A21)

- `set_auto_reply` with `externalAudience` other than `none` is `+external`: it sends owner text to
  strangers. A schedule must be in the future (V).
- `update_mailbox_settings` changing `delegateMeetingMessageDeliveryOptions` is `+sensitive`.
- `set_focus_override` with `classifyAs: other` is `+sensitive`. Creating an override for an address that
  already has one overwrites it (V), so the summary shows the old value.

## 8. Tool semantics on Outlook

### 8.1 Search and read (G14, G25)

- `search_threads` takes KQL on Outlook. Results are at most 1,000 and ordered by sent date (V), grouped by
  `conversationId` in the Worker, with a `truncated` flag at the cap. `$search` is never combined with
  `$filter`.
- `get_thread` filters on `conversationId` alone, caps the page count and sorts in the Worker, because a
  `$orderby` would need the same property in the filter (V).
- Reads send `Prefer: outlook.body-content-type="text"` and check `Preference-Applied`.
- `list_accounts` reports `provider`, `capabilities` and `query_dialect` (`gmail` or `kql`) per account,
  and tool descriptions become provider-neutral.

### 8.2 Thread mutations (A22)

The seven thread tools are supported. Graph has no thread resource, so each is a bounded loop over the
conversation's messages, designed as convergent rather than as a batch:

1. Resolve the member set once, before approval: at most 100 messages, else `limit_exceeded`. The intent
   hash freezes the account, the conversation and the member ids, so an approval covers exactly those.
2. Each step states a target ("message M is in folder F", "message M carries category C"), not a delta.
   Already in the target state counts as done.
3. Execution runs in `$batch` groups of up to 20, every sub-request allowlisted.
4. One parent operation records a per-item outcome: `done`, `already`, `failed` with the Graph code, or
   `gone`. A retry re-reads each item and acts only where the target does not hold, so a repeat cannot
   double-apply or silently shrink the approved set.
5. Messages that joined the conversation after approval are reported and left alone.

This is the Outlook instance of `P6-BATCH` and owes its acceptance tests: duplicates, partial failure, a
retry with changed order, response loss and cross-account ids.

### 8.3 Drafts (A23)

- `update_draft` patches body, subject and recipients in place, and the id stays the same.
- If attachments change, Graph would need an attachment DELETE, which is refused. Instead the tool builds a
  new draft with the requested content, moves the old draft to Deleted Items, and returns the new
  `draft_id`. The result says the id changed. Gmail's `drafts.update` also replaces the whole draft, so the
  owner-visible effect matches.
- Drafts are always created in Drafts. `POST mailFolders/{id}/messages` is refused.

### 8.4 Trash, spam and restore (G26)

- `trash_*` moves to `deleteditems`, and `mark_*_spam` moves to `junkemail`. v1.0 has no junk report
  (`reportMessage` is beta), so no sender is added to a block list.
- Graph has no `untrash`. When this service moves an item, the operation keeps the source folder id.
  `untrash_*` and `unmark_*_spam` move back there if the operation is ours and the folder still exists, and
  to Inbox otherwise. The result reports which.

### 8.5 Send (A1 to A3, A24)

Direct `sendMail`, `reply`, `replyAll` and `forward` are refused: each returns 202 with no id (V). Every send
is draft-first.

| Step | Graph call                                                             | Operation state                             | Persisted before the call       |
| ---- | ---------------------------------------------------------------------- | ------------------------------------------- | ------------------------------- |
| 1    | `POST messages`, or `createReply` / `createReplyAll` / `createForward` | `claimed`                                   | the operation and intent        |
| 2    | `PATCH` the draft: body, recipients, `internetMessageId = <op_…@host>` | `claimed`                                   | the immutable draft id          |
| 3    | attachments: under 3 MB direct, 3 to 150 MB by upload session          | `claimed`                                   | each attachment's admission     |
| 4    | `getMailTips` for every recipient                                      | `claimed`                                   | the modifiers it raised, if any |
| 5    | `POST messages/{id}/send`                                              | `executing`, `byte_admitted=1`              | the full recovery binding       |
| 6    | observation (below)                                                    | `executed` on 202, confirmed on observation | nothing new                     |

Step 4 can only raise. `recipientScope` of `external` on an address the trusted set would accept adds
`+external`. `externalMemberCount` or `totalMemberCount` above ten adds `+bulk`, which closes the gap where
a distribution list counts as one recipient (G15). A raised modifier after approval sends the request back
for approval instead of sending.

Byte admission means step 5, which the protocol-2 `begin` permit already requires. No new operation state
is added. A crash before step 5 leaves a stray draft and no delivery.

**Observation (A24, G29).** The two Microsoft pages disagree on whether the draft's immutable id survives
send. So observation has two keys and trusts neither alone:

1. `GET messages/{draft-id}`: if it resolves to an item in Sent Items that is no longer a draft, delivery
   is observed.
2. Otherwise `$filter=internetMessageId eq '<op_…@host>'` on Sent Items. Exactly one match is observed;
   more than one is an anomaly reported to the owner.

Neither key finding nothing proves non-delivery. Absence never settles `failed_safe`, which is the existing
`delivery_unknown` rule. P1 and P2 decide which key is reliable, and P3 whether the filter works.

`reply` gains `mode: "reply" | "reply_all"`. On Outlook it picks `createReply` or `createReplyAll`. On Gmail
`reply_all` is a follow-on and refused for now. `forward` gains `as_attachment`, which sends the original as
an item attachment (3 MB cap, V).

Limits: 500 recipients (V); the default 35 MB message size is configurable by tenant administrators (V), so
the ceiling is per account, learned from MailTips `maxMessageSize` and P9, and never `GMAIL_SEND_MAX`. At
most 250 attachments (V). `from` must be the mailbox itself (V), so `senderFor` accepts only its address.

### 8.6 Delta cursors

`sync_folder` returns an opaque cursor that names a server-side row holding the delta link, bound to owner,
account and folder. A delta link's lifetime "isn't fixed" (V), so an expired one returns
`cursor_expired` and the caller restarts. Raw delta links never reach the model.

## 9. Tool surface

### 9.1 The existing 38 on Outlook

All 38 are supported. Differences from Gmail:

| Tools                                                                                                                                        | Outlook behaviour                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| control tools (7)                                                                                                                            | unchanged; `list_accounts` adds `provider`, `capabilities`, `query_dialect`     |
| `search_threads`, `get_thread`                                                                                                               | KQL, 1,000 cap, Worker-side grouping and sort (8.1)                             |
| `get_message`, `get_draft`, `list_drafts`, `download_attachment`                                                                             | item attachments save as `.eml`; reference attachments listed, not downloadable |
| `list_labels`                                                                                                                                | folders and master categories, each typed                                       |
| `create_label`, `update_label`, `delete_label`                                                                                               | master categories; colour presets; rename refused (`immutable_on_provider`)     |
| `label_message`, `unlabel_message`, `update_message_labels`                                                                                  | categories, serialised per message                                              |
| `apply_sensitive_message_label`                                                                                                              | moves to `deleteditems`, `junkemail` or `archive`                               |
| `label_thread`, `unlabel_thread`, `apply_sensitive_thread_label`, `trash_thread`, `untrash_thread`, `mark_thread_spam`, `unmark_thread_spam` | convergent loops (8.2)                                                          |
| `trash_message`, `untrash_message`, `mark_message_spam`, `unmark_message_spam`                                                               | moves with recorded source (8.4)                                                |
| `create_draft`, `update_draft`                                                                                                               | JSON drafts; attachment change replaces the draft (8.3)                         |
| `send_message`, `reply`, `forward`, `send_draft`                                                                                             | draft-first with MailTips and two-key observation (8.5)                         |

### 9.2 New tools (25)

On a Gmail account each returns `unsupported_for_provider` until a Gmail follow-on adds it (Gmail filters,
vacation responder and forwarding need the `gmail.settings.basic` and `gmail.settings.sharing` scopes,
which the Gmail grant does not request today). Every refusal happens before policy evaluation, so it never
creates a pending action.

| Tool                      | Action           | Graph                                     | Notes                                                            |
| ------------------------- | ---------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| `list_folders`            | read.message     | `mailFolders`, `childFolders`             | Tree with counts, hidden folders marked, depth and count bounded |
| `list_folder_messages`    | read.message     | `mailFolders/{id}/messages`               | `limit` default 20, max 50, `page_token`                         |
| `sync_folder`             | read.message     | `messages/delta`                          | Opaque cursor; the delta link stays server-side (8.6)            |
| `export_message`          | read.attachment  | `messages/{id}/$value`                    | `.eml` into staging, 25 MiB ceiling                              |
| `get_mail_tips`           | read.message     | `getMailTips`                             | Recipient scope, member counts, automatic replies, size limit    |
| `create_folder`           | folder.manage    | `POST mailFolders`, `childFolders`        | `hidden: true` is `+sensitive`                                   |
| `rename_folder`           | folder.manage    | `PATCH mailFolders/{id}`                  | Well-known folders refused                                       |
| `move_folder`             | folder.manage    | `mailFolders/{id}/move`                   | Classified by target (7.2)                                       |
| `copy_folder`             | folder.manage    | `mailFolders/{id}/copy`                   | Copies contents                                                  |
| `trash_folder`            | folder.manage    | `mailFolders/{id}/move` to `deleteditems` | Always `+sensitive`. Never DELETE                                |
| `create_search_folder`    | folder.manage    | `childFolders` as `mailSearchFolder`      | Result warns of the 45-day expiry                                |
| `update_search_folder`    | folder.manage    | `PATCH mailFolders/{id}`                  | Query, sources, nesting                                          |
| `move_message`            | message.organize | `messages/{id}/move`                      | Classified by target (7.2)                                       |
| `copy_message`            | message.organize | `messages/{id}/copy`                      | System folders refused as targets                                |
| `update_message_state`    | message.organize | `PATCH messages/{id}`                     | Read state, flag, importance, focus (7.4)                        |
| `list_rules`              | read.message     | `messageRules`                            | Marks forwarding, redirecting and deleting rules                 |
| `create_rule`             | rule.manage      | `POST messageRules`                       | 7.5                                                              |
| `update_rule`             | rule.manage      | `PATCH messageRules/{id}`                 | Includes enable, disable and sequence                            |
| `delete_rule`             | rule.manage      | `DELETE messageRules/{id}`                | Deletes the rule only                                            |
| `get_mailbox_settings`    | read.message     | `GET mailboxSettings`                     | Includes automatic replies                                       |
| `set_auto_reply`          | settings.edit    | `PATCH mailboxSettings`                   | 7.6                                                              |
| `update_mailbox_settings` | settings.edit    | `PATCH mailboxSettings`                   | Values checked against supported languages and time zones        |
| `list_focus_overrides`    | read.message     | `inferenceClassification/overrides`       | At most 1,000 per mailbox (V)                                    |
| `set_focus_override`      | settings.edit    | `POST` or `PATCH` an override             | 7.6                                                              |
| `remove_focus_override`   | settings.edit    | `DELETE` an override                      | Deletes a preference only                                        |

38 existing plus 25 new makes 63 tools on an Outlook account.

### 9.3 Annotations

Following the Gmail design's 2.5: every `list_*`, `get_*`, `sync_folder` and `get_mail_tips` carry
`readOnlyHint: true`. `export_message` matches `download_attachment`. `trash_folder`, `move_folder`,
`move_message`, `delete_rule`, `delete_label`, `create_rule` and `update_rule` carry `destructiveHint: true`,
the rule tools because a rule can trash future mail. `set_auto_reply` carries `openWorldHint: true`. They
are hints only; the policy engine is the enforcement.

## 10. Schema (A11)

Additive only, because the CI legacy writer baseline and the protocol-2 triggers reject anything else.

- `accounts.provider TEXT NOT NULL DEFAULT 'gmail' CHECK(provider IN ('gmail','outlook'))`.
- `accounts.provider_registration TEXT`, `NULL` for Gmail.
- The Outlook subject goes in the existing `google_sub` as `ms:{tid}:{oid}`. A Google `sub` is numeric, so
  the prefix cannot collide, and `UNIQUE (user_id, google_sub)` keeps meaning one account per identity
  without a table rebuild. The address goes in `google_email`. The naming debt is accepted (G19).
- New tables: `delta_cursors` (8.6), `graph_subscriptions` (Phase 6) and per-item outcomes for 8.2. Their
  columns are a Phase 1 deliverable.
- No renamed columns and no new operation states.

## 11. Documents that change when the code ships

| Document                           | Change                                                                                                                 | Ships with |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------- |
| `docs/INVARIANTS.md`               | 7a and 7b with proof types; every Graph request carries the immutable-id header; no rule may permanently delete        | Phase 2    |
| `SECURITY.md`                      | A leaked Outlook token can permanently delete; administrator consent in work tenants; rules as persistent exfiltration | Phase 2    |
| `docs/runbooks/microsoft-entra.md` | New: both registrations, certificate rotation, scopes, administrator consent                                           | Phase 2    |
| `README.md`, `ARCHITECTURE.md`     | Provider seam, capability matrix, "locally verified against a synthetic Graph" until live                              | each phase |
| Deferred register                  | PKCE for the Google flow; Gmail `reply_all`; Gmail filters, vacation and forwarding                                    | Phase 1    |

## 12. Phases and gates

| Phase | What                                                                                                 | Gate                                                                     |
| ----- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 0     | Probes P1 to P18 on a throwaway personal account and an owned developer tenant                       | Evidence in the Plan 6 feasibility format, each with its falsifier       |
| 1     | Provider seam, migration, `ProviderId`, `classifyTarget`, both transports, allowlist, limiter design | 862 TypeScript tests and the CI legacy corpus unchanged and green        |
| 2     | Connect and read: every read tool in 9.1 and 9.2                                                     | A live read on a real mailbox the owner controls                         |
| 3     | Organise: labels, categories, folders, moves, message state, thread loops                            | Classifier matrix, allowlist mutation tests, `P6-BATCH` acceptance tests |
| 4     | Send: draft-first sends, `update_draft`, MailTips, observation                                       | O2 proven live. O1 stays `not_run`                                       |
| 5     | Rules and settings                                                                                   | Rule-policy matrix, including the refused `permanentDelete` action       |
| 6     | Change notifications for observation and the folder cache                                            | Validation handshake and lifecycle events against the fake and live      |

A `fake-graph` built from Phase 0 fixtures backs the worker suite, and its results are labelled "Locally
verified against a synthetic Graph", never "live" (G16). Probes that send go only to mailboxes the owner
controls, and probes that change a real mailbox need explicit authorization first.

## 13. Phase 0 probes

P1 to P13 are as in the gauntlet, amended by revision 2. Revision 3 adds:

| ID  | Measure                                                                                                   | Falsifier                                                       |
| --- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| P1  | (amended) Draft id after send, on personal and work, against the two conflicting Microsoft pages          | The id resolves to a different item, or never resolves          |
| P14 | Error bodies when the certificate has expired or the tenant blocks the credential type                    | A body the taxonomy cannot place                                |
| P15 | A forwarding rule to an external address on personal and work; whether an NDR comes back                  | A forward that leaves silently where the docs say it is blocked |
| P16 | Delta link lifetime and the `syncStateNotFound` and 410 paths                                             | An expired link that returns data instead of an error           |
| P17 | Subscription validation, renewal, `missed` and `reauthorizationRequired` events against a deployed Worker | A notification the Worker cannot authenticate by `clientState`  |
| P18 | What happens to items when a master category is deleted, and to a search folder after 45 days             | Mail content lost when a category definition goes               |

## 14. Decisions

| ID  | Question                           | Recommendation, and what v2 assumes                                                                                                |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Which accounts can connect         | Personal accounts, and a single-tenant app in a tenant the owner administers. Other work tenants once their administrator consents |
| D2  | `update_draft`                     | Supported. Attachment changes replace the draft and return a new id (8.3). Reversed from v1                                        |
| D3  | Label administration               | Supported, with `MailboxSettings.ReadWrite`. Reversed from v1, because full coverage needs the scope anyway                        |
| D4  | Client credential                  | A certificate and `private_key_jwt`, rotated yearly                                                                                |
| D5  | Gmail equivalents of the new tools | A separate follow-on spec. It needs new Google scopes and its own review                                                           |

## 15. Open questions

- What DELETE does to a message or folder (P4). Until then both stay refused.
- Which observation key is reliable after send (P1, P2, P3).
- Where the Durable Object limiter sits in the release path's quiescence story. Part of the Phase 1 design,
  and it may touch the open feasibility decisions.
- O1, the provider commit barrier, which Outlook inherits as `not_run`.

## 16. References

Every source is listed in the [gauntlet](../reviews/2026-10-05-outlook-spec-gauntlet.md#references), its
[revision 2](../reviews/2026-10-05-outlook-spec-gauntlet.md#additional-references) and its
[revision 3](../reviews/2026-10-05-outlook-spec-gauntlet.md#revision-3-references).
