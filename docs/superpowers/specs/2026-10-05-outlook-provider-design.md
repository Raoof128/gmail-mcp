# Outlook provider design (spec v1)

Status: design draft. Nothing here has implementation acceptance, and nothing here changes a current
guarantee. [INVARIANTS.md](../../INVARIANTS.md), [SECURITY.md](../../../SECURITY.md) and the README describe
the system as it is, so they are amended in the same change that ships the code each amendment describes,
and not before.

This spec supersedes v0, which was stated in chat on 2026-10-05 and never committed. Every change from v0
traces to a finding in [the Outlook spec gauntlet](../reviews/2026-10-05-outlook-spec-gauntlet.md) (G1 to
G28) and to an amendment below (A1 to A16). Claims about Microsoft behaviour carry the gauntlet's grades:
V (stated on a primary page as of October 2026), S (secondary), M (memory) and P (needs a live probe).
Nothing in this spec is live evidence.

## Goal and non-goals

Goal: connect an owner's Outlook mailbox through Microsoft Graph as a second provider behind the same
policy, approval, audit, journal, staging and companion machinery, with no guarantee weakened silently.
Where a guarantee is weaker for Outlook, the spec says so and says which proof type replaces it.

Not in scope for v1:

- Multi-tenant distribution, publisher verification and other owners (`P6-MULTI-USER`).
- Shared mailboxes, delegation, send-as aliases and send-on-behalf (G13).
- Thread-level batch mutations (`P6-BATCH`, G7).
- EWS, IMAP and SMTP. EWS in Exchange Online is disabled from October 2026 and fully off in April 2027
  (V), so Graph is the only path.
- Any `Mail-Advanced.*` permission (G4).
- Changing the Google owner login. The owner signs in with Google. Microsoft identity is only ever an
  account being connected.

## What is reused, and what is not

v0 claimed six subsystems were reusable unchanged (S1). That is true of the policy engine, approval, audit,
idempotency and the companion. It is not true of these, each of which gets a provider seam:

| Area                      | Gmail today                                                 | Why it cannot be shared as is                                               |
| ------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| Identity verification     | `worker/src/google/oidc.ts` `verifyIdToken`                 | Requires `email_verified` and a Google issuer (G2)                          |
| Token refresh             | `RefreshResponse` drops `refresh_token`                     | Entra rotates refresh tokens on every use (G3)                              |
| Recovery egress allowlist | `recovery-http.ts` `allowed()` hard-codes `GOOGLE.tokenUrl` | Needs the Entra token URL and the Graph send route (G3)                     |
| Id schema                 | `GmailId`, `[A-Za-z0-9_-]`                                  | Graph ids carry `=` padding (G21)                                           |
| Sensitivity classifier    | `isSystemLabel`, `/^[A-Z][A-Z0-9_]*$/`                      | Outlook folders and categories never match it, so `+sensitive` is lost (G8) |
| Send pipeline             | MIME build, resumable upload, `GMAIL_SEND_MAX`              | Graph sends JSON drafts with attachment sessions (G10)                      |
| Concurrency               | None                                                        | Graph caps four concurrent requests per mailbox (G6)                        |

## Amendments added after the gauntlet

A1 to A13 are defined in the gauntlet. Revision 2 of the gauntlet adds three, and refines two.

| ID  | Amendment                                                                                                           | From    |
| --- | ------------------------------------------------------------------------------------------------------------------- | ------- |
| A14 | A per-provider `ProviderId` schema. Graph ids are URL-safe base64 with `=` padding                                  | G21     |
| A15 | Two transports: an authenticated one for `graph.microsoft.com` only, and an unauthenticated one for upload sessions | G22     |
| A16 | Certificate client credential, PKCE, and an error taxonomy keyed on the OAuth `error` value                         | G24, G3 |
| A9+ | Category writes are serialised per message                                                                          | G23     |
| A2+ | The generated `Message-ID` is set on the draft as a secondary correlator. The immutable draft id stays the key      | G27     |

## Decisions

These are the owner's to make. Each has a recommendation, and the spec is written as if it were accepted.

| ID  | Question                        | Recommendation                                                                                                                                                                                                                      | Why                                                                                                                                                                 |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Which accounts can connect      | Two registrations. A personal-accounts app on `/consumers`. A single-tenant app in a developer tenant the owner administers, on `/{tenant-id}`. University and employer tenants are out of scope until their administrator consents | Default tenant policy blocks user consent to `Mail.ReadWrite` for every third-party app, verified or not (G20, V). Single-tenant apps avoid step-up consent (G5, V) |
| D2  | `update_draft` on Outlook       | Unsupported in v1                                                                                                                                                                                                                   | Replacing an attachment needs a DELETE that breaks invariant 7b (G11)                                                                                               |
| D3  | Label administration on Outlook | `list_labels` reads well-known folders only, and the category master list is out of v1. `create_label`, `update_label` and `delete_label` are unsupported                                                                           | The master list needs a `MailboxSettings.*` scope (V), one more consent item. Assigning a category by name needs no extra scope (V)                                 |
| D4  | Client credential               | A certificate, with the private key in a Worker secret, used to sign a `private_key_jwt` assertion. Rotate yearly                                                                                                                   | Secrets are capped at 24 months and Microsoft says not to use them in production (G24, V)                                                                           |

## Identity and connect (A4, A5, A16)

### Registrations and endpoints

| Registration       | Supported account types | Authorize and token endpoints                                 | Expected `tid`                             |
| ------------------ | ----------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| `outlook-personal` | Personal accounts only  | `https://login.microsoftonline.com/consumers/oauth2/v2.0/…`   | `9188040d-6c67-4c5b-b112-36a304b66dad` (V) |
| `outlook-tenant`   | This directory only     | `https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/…` | the configured tenant id                   |

The registration is chosen by the owner on the connect page, never inferred from an address. The Microsoft
Learn MSAL authority page still says a personal-only app must be registered as "work and school and
personal" and restricted in code, while the current portal offers "personal accounts only" (V, conflicting).
The runbook registers whichever the portal offers and the verifier enforces the `tid` either way.

### Scopes

`openid profile offline_access User.Read Mail.ReadWrite Mail.Send`. `profile` is required, because `oid` is
only issued with it (V). A negative test refuses a grant carrying any `Mail-Advanced.*`, `Mail.ReadWrite.Shared`,
`Mail.Send.Shared` or `MailboxSettings.*` scope, mirroring the Gmail check that refuses a grant without
`gmail.modify` and never requests `https://mail.google.com/`.

### Authorization code flow

Confidential client with PKCE (S256). PKCE is "recommended for all application types, both public and
confidential clients" (V). The Google connect flow does not use PKCE today. That is out of scope here, and
the deferred register should record it.

### Identity verifier

A new `verifyMicrosoftIdToken`, separate from the Google verifier so that neither can be loosened by the
other:

1. Signature against the JWKS at `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`, where
   `{tenant}` is `consumers` or the configured tenant id. Fetched per verification, as the Google verifier
   already does. Keys "could be rolled over immediately" (V).
2. `aud` equals the registration's client id.
3. `tid` is a GUID and equals the registration's expected `tid`.
4. `iss` equals exactly `https://login.microsoftonline.com/{tid}/v2.0`, with `{tid}` taken from the token (V).
5. `oid` is present and a GUID.
6. `nonce` matches the state row, as for Google.

The account subject is `ms:{tid}:{oid}`. The claims-validation page says to use `tid` and `oid` as a
combined key (V). `email` and `preferred_username` are never used for identity, because both are mutable
(V). The display address comes from `GET /me` (`mail`, falling back to `userPrincipalName`) and is a label,
not a key.

Tests: an issuer whose tenant differs from `tid`; a personal token presented to the tenant registration and
the reverse; a token with no `email`; a token with no `oid`; a reconnect where the same `oid` arrives with a
different address, which must update the same account and never create a second.

### Token lifecycle

Every successful refresh returns a new refresh token, and the old one is not revoked (V). The refresh
response schema gains an optional `refresh_token`. When present, the new token is encrypted and written
through the existing `guardedWrite` fenced on `credential_version`. A lost race discards the newer token,
which is safe because the old one still works for its remaining lifetime (90 days by default, V).

### Error taxonomy

No Microsoft page maps an AADSTS code to an OAuth `error` value (V/U), so the classifier keys on the OAuth
`error` first and uses the AADSTS code only to pick the reason shown to the owner.

| OAuth `error` from the token endpoint | Example codes (texts V)                          | Account state                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `invalid_grant`                       | 70000, 700082 (inactivity), 50173 (revoked)      | `needs_reconnect`                                                                                                                                            |
| `interaction_required`                | 50076, 50079 (MFA)                               | `needs_reconnect`, reason "sign in again"                                                                                                                    |
| `consent_required`                    | 65001                                            | `needs_reconnect`, reason "consent"                                                                                                                          |
| `invalid_client`                      | 7000215, 7000222 (credential invalid or expired) | operator fault: every Outlook account on that registration is held, and the owner is told the credential needs rotating. Never `internal`, never per-account |
| anything else, or 5xx                 |                                                  | `internal`, transient                                                                                                                                        |

P6 captures the real response bodies, including whether an `error_codes` array is present (M).

## Graph transport (A6, A7, A10, A14, A15)

### Two transports, one choke point each

| Transport     | Host                                                  | Carries `Authorization` | Carries `Prefer: IdType="ImmutableId"` | Used for                         |
| ------------- | ----------------------------------------------------- | ----------------------- | -------------------------------------- | -------------------------------- |
| `graphFetch`  | `graph.microsoft.com`, `/v1.0` only                   | yes                     | yes, on every request (V)              | everything except upload chunks  |
| `uploadFetch` | learned in P8, documented as `outlook.office.com` (V) | **never** (V)           | no                                     | attachment upload-session chunks |

`graphFetch` refuses any other host. `uploadFetch` validates the session URL with a validator that is
written from the P8 capture, as `validateSessionUrl` was for Gmail. A test drives every Outlook tool
through the fake and fails if any request to `graph.microsoft.com` lacks the immutable-id header, or if any
request to the upload host carries `Authorization`.

### Method allowlist (invariant 7b)

`graphFetch` accepts only an enumerated set of method and path shapes. The list is closed: `GET` reads,
`POST` to `messages`, `createReply`, `createReplyAll`, `createForward`, `send`, `move`,
`attachments`, `attachments/createUploadSession`, and `PATCH` on a message. It has no `DELETE` on any
path and no `permanentDelete`. DELETE on a message is undocumented (V: the page never says whether it moves
or purges), so it is treated as destructive. A mutation test adds a DELETE route to the list and must turn
the suite red. A stray draft left by a crash is left in place, matching Gmail's refusal to delete anything.

`Mail.ReadWrite` is the only permission for `permanentDelete` and nothing narrower exists (V), so invariant
7 is split:

- **7a, Gmail.** Scope-enforced, unchanged.
- **7b, Outlook.** Code-enforced at `graphFetch`, with the mutation test above as its proof type. A leaked
  Outlook access token can permanently delete, and a leaked Gmail token cannot. That goes into SECURITY.md
  as a residual-risk row the day Outlook ships.

### Ids

A new `ProviderId` schema per provider. For Outlook it is URL-safe base64 with optional `=` padding,
`^[A-Za-z0-9_-]+={0,2}$`, up to 512 characters. The Graph examples show `-`, `_` and a trailing `=` and never
`+` or `/` (V), but the character set of a REST id is undocumented. P12 records the observed set. An id
outside the schema is refused, never widened silently. Every id is path-encoded with `encodeURIComponent`.
Ids are case-sensitive (V). Every tool result that moves an item returns the post-move id (A7).

### Concurrency and throttling

The limits are per app per mailbox: 10,000 requests per 10 minutes, four concurrent requests, and 150 MB
uploaded per 5 minutes (V). An isolate-local semaphore does not span isolates, so the limiter is a Durable
Object keyed on the account id. That is new infrastructure, and its design is a Phase 1 deliverable. It
holds a concurrency of three, keeping one slot for the cron and the recovery path, and an upload byte
budget. It serialises category writes per message (G23). A `429` honours `Retry-After`. P10 measures the
real behaviour.

## Mailbox model (A9, A13)

### Folders and categories

Gmail labels map onto two Outlook concepts, and the classifier is supplied by the provider
(`classifyTarget`), never by the shape of a string.

| Gmail concept    | Outlook concept                     | Classified `+sensitive` |
| ---------------- | ----------------------------------- | ----------------------- |
| `TRASH`          | well-known folder `deleteditems`    | yes                     |
| `SPAM`           | well-known folder `junkemail`       | yes                     |
| removing `INBOX` | move to well-known folder `archive` | yes                     |
| `INBOX`          | well-known folder `inbox`           | yes, as a move target   |
| user label       | category, by display name           | no                      |
| any other folder | user mail folder, by immutable id   | yes, as a move target   |

Every move is `+sensitive`, because a move is how Outlook hides mail. A matrix test asserts that every
Outlook route into Deleted Items, Junk or Archive yields `+sensitive`, and the mutation that neutralises
the predicate must turn it red. Categories are display names, a string collection on the message (V), and
are not label ids. A category write reads the collection, applies the change, and writes it back, under
the per-message serialisation above. P13 tests `If-Match` on `@odata.etag` (M) and records the length and
character limits, which are undocumented.

### Restore (G26)

Graph has no `untrash`. When our tool moves an item into Deleted Items or Junk, the operation payload keeps
the source folder id. `untrash_message` and `unmark_message_spam` move the item back there if the operation
is ours and the folder still exists, and to Inbox otherwise. The result reports which.

### Search and threads (G14, G25)

- `$search` is KQL, returns at most 1,000 results, and is ordered by sent date (V). It is not combined with
  `$filter` on messages (S). `search_threads` on Outlook takes KQL, groups by `conversationId` in the Worker,
  and says when the 1,000 cap truncates.
- A `$filter` with `$orderby` must name the order properties in the filter, first and in the same order, or
  Graph returns `InefficientFilter` (V). `get_thread` therefore filters on `conversationId` alone, caps the
  page count, and sorts in the Worker.
- Tool descriptions become provider-neutral. `list_accounts` reports `provider`, `capabilities` and
  `query_dialect` (`gmail` or `kql`) per account.

### Bodies and attachments (G17)

Reads send `Prefer: outlook.body-content-type="text"` and check the `Preference-Applied` response header
(V). File attachments stream from `/$value` as raw bytes. Item attachments return MIME and are downloaded as
`.eml`. Reference attachments return `405` (V) and are listed as not downloadable, with their link withheld.

## Send (A1, A2, A3, A12)

Direct `sendMail` is forbidden: it returns `202` with an empty body (V), so it leaves no correlation key.
Every send is draft-first.

| Step | Graph call                                                                                           | Operation state                             | Persisted before the call   |
| ---- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------- |
| 1    | `POST messages`, or `createReply` / `createReplyAll` / `createForward` (201 with the draft, V)       | `claimed`                                   | the operation and intent    |
| 2    | `PATCH` the draft: body, recipients, `internetMessageId = <op_…@host>` (writable while `isDraft`, V) | `claimed`                                   | the immutable draft id      |
| 3    | attachments: `POST` below 3 MB, upload session from 3 MB to 150 MB (V)                               | `claimed`                                   | each attachment's admission |
| 4    | `POST messages/{id}/send` (202, V)                                                                   | `executing`, with `byte_admitted=1`         | the full recovery binding   |
| 5    | `GET messages/{id}` until it is in Sent Items                                                        | `executed` on 202, confirmed on observation | nothing new                 |

Byte admission means step 4, which is what the protocol-2 `begin` permit in `0005_operation_recovery.sql`
already requires. No new operation state is added: the set is closed by a CHECK constraint and the CI legacy
corpus would fail. A crash before step 4 leaves a stray draft and no delivery.

The settlement key is the immutable draft id, which survives send to the Sent Items copy, after a delay (V).
The `Message-ID` set in step 2 is secondary. Whether it survives send is undocumented, so P2 decides
whether observation may use it. Absence of the Sent copy, or the item still being a draft, is never proof
of non-delivery and never settles `failed_safe`. That is the existing `delivery_unknown` rule.

`from` must be the mailbox that sends (V). `senderFor` accepts only the mailbox address for Outlook in v1.

Limits: 500 recipients across To, Cc and Bcc (V); a default message size limit of 35 MB that tenant
administrators can change (V). The Outlook ceiling is therefore a per-account value learned at connect
time and in P9, never `GMAIL_SEND_MAX`. An upload session for a file under 3 MB fails (V), so the path
choice is strictly by size. Chunks go in order and under 4 MB (V); the 320 KiB rule is OneDrive's and does
not apply.

## Capability matrix (A8)

`list_accounts` exposes this per account. An unsupported tool returns `unsupported_for_provider` before
policy evaluation, so it never creates a pending action.

| Tools                                                                                                                                        | Outlook v1                      | Phase |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----- |
| `list_accounts`, `get_policy`, `list_pending`, `execute_pending`, `cancel_pending`, `connect_account`, `open_policy_editor`                  | supported                       | 2     |
| `search_threads`, `get_thread`, `get_message`, `download_attachment`, `list_drafts`, `get_draft`                                             | supported                       | 2     |
| `list_labels`                                                                                                                                | well-known folders only (D3)    | 3     |
| `label_message`, `unlabel_message`, `update_message_labels`                                                                                  | categories                      | 3     |
| `apply_sensitive_message_label`, `trash_message`, `untrash_message`, `mark_message_spam`, `unmark_message_spam`                              | moves, always `+sensitive`      | 3     |
| `create_draft`                                                                                                                               | supported                       | 4     |
| `send_message`, `reply`, `forward`, `send_draft`                                                                                             | draft-first send                | 4     |
| `label_thread`, `unlabel_thread`, `apply_sensitive_thread_label`, `trash_thread`, `untrash_thread`, `mark_thread_spam`, `unmark_thread_spam` | `unsupported_for_provider` (G7) | n/a   |
| `update_draft`                                                                                                                               | `unsupported_for_provider` (D2) | n/a   |
| `create_label`, `update_label`, `delete_label`                                                                                               | `unsupported_for_provider` (D3) | n/a   |

That is 27 of 38 tools supported and 11 refused.

## Schema (A11)

Additive only. The CI legacy writer baseline and the protocol-2 triggers reject anything else, by design.

- `accounts.provider TEXT NOT NULL DEFAULT 'gmail' CHECK(provider IN ('gmail','outlook'))`.
- `accounts.provider_registration TEXT`, `NULL` for Gmail, `outlook-personal` or `outlook-tenant` otherwise.
- The Outlook subject is stored in the existing `google_sub` column as `ms:{tid}:{oid}`. A Google `sub` is
  numeric, so the prefix cannot collide, and the existing `UNIQUE (user_id, google_sub)` keeps meaning "one
  account per identity" without a table rebuild. The address goes in `google_email`. The naming debt is
  accepted (G19).
- No renamed columns, no new operation states.

## Documents that change when the code ships

| Document                           | Change                                                                                                            | Ships with |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------- |
| `docs/INVARIANTS.md`               | Split 7 into 7a and 7b with their proof types. New invariant: every Graph request carries the immutable-id header | Phase 2    |
| `SECURITY.md`                      | Residual row: a leaked Outlook token can permanently delete. Admin consent in work tenants                        | Phase 2    |
| `docs/runbooks/microsoft-entra.md` | New, the counterpart of `google-cloud.md`: both registrations, certificate rotation, scopes                       | Phase 2    |
| `README.md`, `ARCHITECTURE.md`     | Provider seam, capability matrix, status rows marked "locally verified against a synthetic Graph" until live      | each phase |
| Deferred register                  | PKCE for the Google connect flow. Thread batch mutations for Outlook. Category administration                     | Phase 1    |

## Phases and gates

| Phase | What                                                                                                           | Gate                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 0     | Probes P1 to P14 on a throwaway personal account and an owned developer tenant. Evidence and recorded fixtures | Evidence in the Plan 6 feasibility format, with each probe's falsifier stated |
| 1     | Provider seam, additive migration, `ProviderId`, `classifyTarget`, both transports, allowlist, limiter design  | 862 TypeScript tests and the CI legacy corpus unchanged and green             |
| 2     | Outlook read-only: connect, verifier, token rotation, search, threads, messages, drafts list, attachments      | A live read on a real mailbox the owner controls                              |
| 3     | Categories, moves to Deleted Items, Junk and Archive with `+sensitive`, restore                                | Classifier matrix and allowlist mutation tests                                |
| 4     | Draft-first send, reply, forward, `send_draft`, observation                                                    | O2 proven live. O1 stays `not_run`                                            |

A `fake-graph` built from the Phase 0 fixtures backs the worker suite. Results against it are labelled
"Locally verified against a synthetic Graph" and never "live" (G16). Any probe that sends mail goes only to
mailboxes the owner controls, and any probe that mutates a real mailbox needs explicit authorization first.

## Phase 0 probes

P1 to P13 are as in the gauntlet, with these changes.

| ID  | Change from the gauntlet                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------ |
| P2  | Set `internetMessageId` on the draft, then compare it with the Sent copy and with the header the recipient sees                |
| P5  | Confirm `SearchWithFilter` on `/messages`, and `InefficientFilter` for `conversationId` with `$orderby`                        |
| P6  | Record the token-endpoint bodies for each row of the error taxonomy, including any `error_codes` array                         |
| P7  | Expect "admin consent required" for a default work tenant. Record whether the personal-only registration meets step-up consent |
| P8  | Record the upload URL host, path and query shape. Confirm a chunk sent with `Authorization` is refused or ignored              |
| P12 | Also record the id character set seen across messages, folders and attachments                                                 |
| P13 | Also test `If-Match` with `@odata.etag` on a category PATCH                                                                    |
| P14 | New. Error bodies and states when a tenant has blocked client secrets or the certificate has expired                           |

## Open questions

- What DELETE does to a message (P4). Until then it is destructive and unreachable.
- Whether the `Message-ID` set on a draft survives send (P2).
- Where the Durable Object limiter's state lives across deploys, and whether it is in the release path's
  quiescence story. This is part of the Phase 1 design and may touch the open feasibility decisions.
- O1, the provider commit barrier, which Outlook inherits as `not_run`.

## References

The full reference list is in the [gauntlet](../reviews/2026-10-05-outlook-spec-gauntlet.md#references) and
its [revision 2](../reviews/2026-10-05-outlook-spec-gauntlet.md#additional-references). The pages this spec
leans on most:

Microsoft (n.d.) [Get immutable identifiers for Outlook resources](https://learn.microsoft.com/en-us/graph/outlook-immutable-id), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.) [Update message](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.) [Attach large files to Outlook messages or events](https://learn.microsoft.com/en-us/graph/outlook-large-attachments), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.) [Microsoft Graph service-specific throttling limits](https://learn.microsoft.com/en-us/graph/throttling-limits), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.) [Secure applications and APIs by validating claims](https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.) [Refresh tokens in the Microsoft identity platform](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.) [Manage app consent policies](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.) [Add and manage application credentials](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials), Microsoft Learn, accessed 5 October 2026.

Microsoft 365 Developer Blog (2026) [Breaking change ahead: Graph API updates to sensitive email properties](https://devblogs.microsoft.com/microsoft365dev/graph-api-updates-to-sensitive-email-properties/), 26 March, accessed 5 October 2026.
