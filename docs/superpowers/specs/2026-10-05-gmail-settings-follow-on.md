# Gmail follow-on: the Outlook tools on Gmail (decision D5)

Status: design draft. Nothing here has implementation acceptance or changes a current guarantee.

The [Outlook provider design](2026-10-05-outlook-provider-design.md) adds 25 tools that return
`unsupported_for_provider` on a Gmail account. Decision D5 put their Gmail equivalents in a separate spec,
because some need a new Google scope and all of them deserve their own review. This is that spec.

Sources: the Gmail API v1 reference, scopes page, quota page, guides and Google Cloud Help, fetched as raw
HTML on 2026-10-05 and quoted verbatim. Grades as in the Outlook gauntlet: V (verbatim on a primary Google
page), S (secondary or inferred from V facts), U (the documentation is silent). No Google API was called.

## 1. What `gmail.modify` already allows

The Worker requests `gmail.modify` and never `https://mail.google.com/`. Every read-side equivalent, and
every per-message one, works under that grant:

| Outlook tool                     | Gmail mechanism                                                                                                   | Scope  | Grade             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------ | ----------------- |
| `list_folders`                   | `labels.list`, nested by `/` in the name                                                                          | modify | V; nesting rule U |
| `list_folder_messages`           | `messages.list` with `labelIds`                                                                                   | modify | V                 |
| `sync_folder`                    | `history.list` from a stored `historyId`; a 404 means full resync                                                 | modify | V                 |
| `export_message`                 | `messages.get?format=raw`, base64url-decoded into staging as `.eml`                                               | modify | V                 |
| `move_message`                   | `messages.modify`: add the target label, remove `INBOX` or the source label                                       | modify | V                 |
| `update_message_state`           | `UNREAD`, `STARRED`, `IMPORTANT` labels. No follow-up dates, no low importance                                    | modify | V                 |
| `create_folder`, `rename_folder` | `labels.create`, `labels.patch`: the same as `create_label`, `update_label`                                       | modify | V                 |
| `list_rules`                     | `settings.filters.list`                                                                                           | modify | V                 |
| `get_mailbox_settings`           | `getVacation`, `getLanguage`, `getImap`, `getPop`, `getAutoForwarding`, `forwardingAddresses.list`, `sendAs.list` | modify | V                 |
| `reply` with `mode: "reply_all"` | the existing send pipeline with every original recipient                                                          | modify | S                 |

`history.list` reports `messageAdded`, `messageDeleted`, `labelAdded` and `labelRemoved`, and "A
`historyId` is typically valid for at least a week, but in some rare circumstances may be valid for only a
few hours" (V). The cursor design is the Outlook one (design 8.6): an opaque, owner-bound cursor whose
`historyId` stays server-side, and `cursor_expired` on a 404.

`list_rules` and `get_mailbox_settings` carry the same security value as on Outlook: they show a filter
that forwards or trashes, and an enabled auto-forward, whoever set it up.

## 2. What needs `gmail.settings.basic`

| Outlook tool                 | Gmail mechanism                                                      | Grade |
| ---------------------------- | -------------------------------------------------------------------- | ----- |
| `create_rule`, `delete_rule` | `settings.filters.create`, `settings.filters.delete`                 | V     |
| `update_rule`                | No update exists (V). Create the new filter, then delete the old one | V     |
| `set_auto_reply`             | `settings.updateVacation`                                            | V     |
| `update_mailbox_settings`    | `settings.updateLanguage` only                                       | V     |

`gmail.settings.basic` is a Restricted scope, as `gmail.modify` already is (V). So adding it does not
change the verification class: "If you store restricted scope data on servers (or transmit), then you must
go through a security assessment" applies today (V). The personal-use exemption still applies under 100
users (V), and so does the existing deferred item `P6-GOOGLE-VERIFICATION`.

## 3. What stays impossible or refused

| Capability                                                         | Why                                                                                                                                                                                              | Grade |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| `get_mail_tips`                                                    | No Gmail API                                                                                                                                                                                     | U     |
| Focused Inbox overrides                                            | No equivalent. `CATEGORY_*` labels can be applied, but whether that trains sorting is undocumented                                                                                               | V/U   |
| `copy_folder`, `copy_message`                                      | A label is not a container. A second label shows the message twice without copying it. `messages.insert` would duplicate, but it bypasses "most scanning and classification", so it is refused   | V     |
| `trash_folder`                                                     | `labels.delete` "Immediately and permanently deletes the specified label" (V). It does not delete mail, but there is no reversible form, so a folder trash is refused rather than mapped onto it | V     |
| Search folders                                                     | No equivalent                                                                                                                                                                                    | U     |
| Auto-forwarding, forwarding addresses, send-as, delegates (writes) | "This method is only available to service account clients that have been delegated domain-wide authority" (V). An owner's OAuth grant cannot use them                                            | V     |
| IMAP and POP writes                                                | `updateImap` can set `expungeBehavior: deleteForever`. Refused outright under invariant 7                                                                                                        | V     |
| `gmail.settings.sharing`                                           | "restricted to administrative use only" (V). Never requested                                                                                                                                     | V     |

## 4. Policy

The four actions the Outlook design adds (`folder.manage`, `message.organize`, `rule.manage`,
`settings.edit`) apply to Gmail unchanged. The Gmail specifics:

- **Filters.** A `forward` action "effectively redirects the message to the address specified in this
  field, maintaining the original sender in the 'From' field" (V), and only to an address the owner already
  verified in Gmail (V). It is a recipient for `+external` and `+bulk`, exactly as an Outlook
  `forwardTo` is. Adding `TRASH` or `SPAM`, or removing `INBOX`, is `+sensitive`: Trash is emptied "After
  30 days" (V), so a trashing filter is a slow delete of future mail. That matches the Outlook rule
  `delete` action, which is `+sensitive` and allowed. A filter takes "only one user-defined label" (V).
- **`update_rule`** creates the replacement before deleting the original, so a failure leaves two filters
  rather than none. The result reports both ids, and the approval covers the pair.
- **Vacation.** `+external` unless `restrictToContacts` or `restrictToDomain` is set. `restrictToDomain` is
  Workspace-only (V). An end time is required, so a forgotten responder cannot run forever.
- **Message state.** `UNREAD`, `STARRED` and `IMPORTANT` are not system labels in the `+sensitive` sense,
  and today's classifier treats them as such because they match `/^[A-Z][A-Z0-9_]*$/`. The Gmail
  `classifyTarget` must list them explicitly as not sensitive, or `update_message_state` asks every time.

## 5. A finding about the current system

`users.drafts.delete` accepts `gmail.modify` and "Immediately and permanently deletes the specified draft.
Does not simply trash it" (V). `messages.insert` and `messages.import` also accept `gmail.modify`, and take
a `deleted` flag that marks a message "permanently deleted (not TRASH) and only visible in Google Vault"
on Workspace accounts (V).

Invariant 7 in `docs/INVARIANTS.md` says "No permanent delete" is scope-enforced. For messages and threads
that is true: `messages.delete`, `threads.delete` and `batchDelete` need `https://mail.google.com/` (V). For
drafts, insert and import it is not. The Worker never calls any of them (checked at `70ba710`: the only
Gmail DELETE is `delete_label`), so the guarantee holds by construction, not by scope. That is a proof-type
correction to a current document, so it is tracked as its own change rather than made here.

## 6. Scope rollout

Requesting a new scope invalidates nothing, but a grant without it cannot use the tools in section 2.

- Phase A ships section 1 under the existing grant. No reconnect, no new consent.
- Phase B adds `gmail.settings.basic` as an opt-in per account. `accounts.scopes` already records what each
  grant carries, so a tool in section 2 on an account without the scope returns `needs_scope` with the
  connect link instead of failing at Google. The connect check that refuses a grant without
  `gmail.modify`, and never requests `https://mail.google.com/`, is unchanged; a second check refuses
  `gmail.settings.sharing`.

## 7. Quota

The current quota model applies to "Cloud projects created on or after May 1, 2026": 6,000 units per
minute per user per project (V). The costs that matter here: `history.list` 2, `messages.get` 20, filter
create and delete 5, `updateVacation` 5, `batchModify` 50 (V). None changes the existing rate design.

## 8. Acceptance

- Every row in sections 1 and 2 against `FakeGoogle`, labelled "Locally verified against a synthetic Gmail".
- A filter-policy matrix: `forward` raises `+external`; `TRASH`, `SPAM` and removing `INBOX` raise
  `+sensitive`; IMAP and POP writes are refused; a mutation that drops each rule turns the suite red.
- `update_rule` with a failed delete leaves both filters and reports both.
- `sync_folder` returns `cursor_expired` on a 404 from `history.list`, and never a partial result.
- One live run on the owner's scratch account through the Google Cloud dev project, under the existing
  runbook.

## References

Google (n.d.a) [Gmail API REST reference](https://developers.google.com/workspace/gmail/api/reference/rest), Google for Developers, accessed 5 October 2026.

Google (n.d.b) [users.settings.filters](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.filters), Google for Developers, accessed 5 October 2026.

Google (n.d.c) [users.history.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list), Google for Developers, accessed 5 October 2026.

Google (n.d.d) [users.drafts.delete](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/delete), Google for Developers, accessed 5 October 2026.

Google (n.d.e) [users.messages.insert](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/insert), Google for Developers, accessed 5 October 2026.

Google (n.d.f) [Choose Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), Google for Developers, accessed 5 October 2026.

Google (n.d.g) [Usage limits](https://developers.google.com/workspace/gmail/api/reference/quota), Google for Developers, accessed 5 October 2026.

Google (n.d.h) [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), Google for Developers, accessed 5 October 2026.

Google (n.d.i) [Unverified apps](https://support.google.com/cloud/answer/13464323), Google Cloud Help, accessed 5 October 2026.

Google (n.d.j) [Delete or recover deleted Gmail messages](https://support.google.com/mail/answer/7401), Gmail Help, accessed 5 October 2026.

Google (n.d.k) [users.settings.updateAutoForwarding](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings/updateAutoForwarding), Google for Developers, accessed 5 October 2026.
