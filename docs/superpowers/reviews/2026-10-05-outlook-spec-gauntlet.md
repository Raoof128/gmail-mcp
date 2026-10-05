# Outlook support: spec gauntlet

Started 2026-10-05 against `70ba710` on `main`. This is a ledger for an adversarial review of the Outlook
support proposal (spec v0, stated in chat the same day). It records what was checked, what the spec got
wrong, and what remains unproven. It is a self-review by the author of the proposal, so it is not
independent review and must not be cited as such.

## Authorization boundary

In scope: reading the repository, reading public Microsoft documentation, local format, lint, type and
test runs. Out of scope and not performed: any call to Microsoft Graph or Entra, any real mailbox
mutation, deployment, and pushing. Every claim that needs one of those stays `not_run` with its missing
prerequisite named. Documentation reading is not live evidence, and a synthetic fake never becomes live
evidence.

## Spec under test (v0)

| ID  | Claim in spec v0                                                                                |
| --- | ----------------------------------------------------------------------------------------------- |
| S1  | Policy, approval, audit, journal, staging and companion are reusable unchanged                  |
| S2  | Phase 1 is a pure refactor behind a `MailProvider` seam, with a migration to generalise columns |
| S3  | Outlook auth is Entra OIDC plus persisting the rotated refresh token                            |
| S4  | Send uses Graph, and recovery finds the sent message by the generated `Message-ID`              |
| S5  | Invariant 7 (no permanent delete) degrades from scope-enforced to code-enforced                 |
| S6  | Labels map to categories, and system labels map to folder moves                                 |
| S7  | The same 38 tool names are kept, and the account alias picks the provider                       |
| S8  | Large attachments use a draft plus an upload session                                            |
| S9  | Outlook ships read-only first                                                                   |

## Evidence grades

| Grade | Meaning                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------- |
| V     | Stated on a primary Microsoft page fetched this session. The reading went through a summarising fetch tool |
| S     | Secondary source (Q&A, blog, news). Plausible, not authoritative                                           |
| M     | From memory, not checked this session                                                                      |
| P     | Needs a live probe. No document can settle it                                                              |

The fetch tool summarises pages, and in this pass its summaries twice disagreed with each other or with
memory. A V grade therefore means "the primary page says this as relayed", and any V claim that carries a
design decision should be re-read at the page before the spec relies on it.

## Standing classification of the Outlook gates

Set before the findings, so a later result cannot be talked into the shape the run wants.

| ID  | Requirement                                | Expected terminal state                         | Why                                                                                                                                    |
| --- | ------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | Provider commit barrier                    | `not_run / provider_barrier_unavailable`        | No documented control withholds a 202 from the Worker. A client disconnect does not prove loss between Graph and the Worker            |
| O2  | Correlation key survives draft to Sent     | **test it** (P1)                                | Immutable ids are documented to persist. Whether that holds under real send lag is checkable, so do not pre-classify it as unavailable |
| O3  | Custom `Message-ID` preserved              | non-load-bearing; record the result             | Docs are silent. The design must not depend on it                                                                                      |
| O4  | Permanent-delete exclusion                 | `scope_enforcement_unavailable`; holds by code  | `Mail.ReadWrite` includes it and no narrower scope exists. Never describe it as scope-enforced                                         |
| O5  | Behaviour at the 4-concurrent mailbox cap  | `not_run` until P10                             | The only source is a secondary Q&A page                                                                                                |
| O6  | Consent in a tenant the owner does not own | `not_run`                                       | Depends on that tenant's consent policy                                                                                                |
| O7  | Peak isolate memory on attachment paths    | inherits the existing `measurement_unavailable` | The Gmail gate is unchanged by adding a provider                                                                                       |

## Baseline

| Item                    | Value                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| Commit                  | `70ba710`                                                                                                    |
| Node, npm               | v22.22.0, 10.9.4                                                                                             |
| Format, lint, typecheck | clean                                                                                                        |
| Tests                   | shared 11, worker 662, companion 23 passed and 1 skipped, qualification 165, all passing                     |
| Not run                 | Swift (`verify:native`), `sql_conformance.py`, `capture_writer_corpus.py --check`, the Plan 6 contract check |
| Side effect             | `typecheck` regenerated `worker/worker-configuration.d.ts`; reverted, tree clean                             |

## Findings summary

Two blockers (the spec as written is wrong or unsafe), eight high, seven medium, two low.

| ID  | Severity | Spec | Finding                                                                             | Outcome         |
| --- | -------- | ---- | ----------------------------------------------------------------------------------- | --------------- |
| G1  | Blocker  | S4   | Recovery keyed on a generated `Message-ID` is unsound on Graph                      | Spec amended    |
| G2  | Blocker  | S3   | `verifyIdToken` would reject every Microsoft token                                  | Spec amended    |
| G3  | High     | S3   | Token rotation, error taxonomy and the recovery refresh allowlist                   | Spec amended    |
| G4  | High     | S5   | Invariant 7 cannot be scope-enforced, and DELETE semantics are undocumented         | Spec amended    |
| G5  | High     | S3   | Consent and tenancy decide who can connect                                          | Decision needed |
| G6  | High     | S1   | No per-mailbox concurrency control exists, and Graph caps it                        | Spec amended    |
| G7  | High     | S7   | Seven thread-level mutation tools cannot be single atomic calls                     | Spec amended    |
| G8  | High     | S6   | The sensitivity classifier is shape-based and under-classifies Outlook folders      | Spec amended    |
| G9  | High     | S6   | Message ids change on move unless every request opts in to immutable ids            | Spec amended    |
| G10 | High     | S8   | The send pipeline is a rewrite, and the protocol-2 permit is tied to byte admission | Spec amended    |
| G11 | Medium   | S7   | `update_draft` has no safe Graph equivalent without a DELETE                        | Decision needed |
| G12 | Medium   | S2   | Schema changes must be additive, because CI pins a legacy writer baseline           | Spec amended    |
| G13 | Medium   | S3   | `send_as` for Outlook is the mailbox address only                                   | Spec amended    |
| G14 | Medium   | S7   | Search dialect, ordering and thread grouping differ                                 | Spec amended    |
| G15 | Medium   | S1   | Org-domain discovery and distribution lists weaken `+external` and `+bulk`          | Residual risk   |
| G16 | Medium   | S1   | A fake Graph risks being read as live evidence                                      | Process rule    |
| G17 | Medium   | S9   | Body format, item attachments and reference attachments                             | Spec amended    |
| G18 | Low      | n/a  | Competing Microsoft MCP server and EWS retirement                                   | No action       |
| G19 | Low      | S2   | `GmailMcpError`, `gmail_error` and `@gmail-mcp/*` naming debt                       | Deferred        |

## Findings

### G1. Recovery keyed on a generated `Message-ID` (Blocker)

Spec v0 copies the Gmail design: build MIME under `<op_...@host>` and later search for it.

- The create-message page documents no settable `internetMessageId` and is silent on whether a `Message-ID` in
  submitted MIME survives (V, Microsoft n.d.d).
- `sendMail` and draft send both return 202 with an empty body, so neither returns an id (V, Microsoft n.d.b,
  n.d.c). A 202 means accepted, and the docs say it does not guarantee delivery completion (V, n.d.b).
- A GitHub issue reports the id changing after send in Outlook desktop and persisting in OWA, unresolved
  (S, OfficeDev n.d.).
- Immutable ids, requested with `Prefer: IdType="ImmutableId"`, persist from a draft to its Sent Items copy,
  with a propagation delay before that copy is visible (V, Microsoft n.d.g).

Verdict: the correlation key must be the immutable draft id, not the `Message-ID`. Amendment A1 and A2.
Absence of the Sent copy, or a still-draft state, is never proof of non-delivery, so it cannot settle
`failed_safe`. That matches the existing `delivery_unknown` semantics.

Falsifier: P1. The id must resolve to the same item in Sent Items, and must never resolve to a different one.

### G2. Identity verification (Blocker)

`worker/src/google/oidc.ts` `verifyIdToken` requires an `email` claim, requires `email_verified === true`, and
pins Google's issuers. Against Entra: `email` is optional and mutable and must not identify a user, `sub` is
pairwise per application, the stable key is `tid` plus `oid`, and the issuer is per tenant and must contain
the token's `tid` (V, Microsoft n.d.m, n.d.n). Personal accounts carry a fixed `tid` (V, n.d.m). Owner login
stays Google, so only the connect side changes.

Amendment A4: a provider-specific identity verifier returning `subject = tid:oid` and a display address read
from Graph rather than the token.

Falsifier: tests for an issuer whose tenant differs from `tid`, a token with no `email`, a personal-account
token, and an alias reconnect keyed on the new subject.

### G3. Token lifecycle (High)

Refresh tokens replace themselves on every use, and the old one is not revoked (V, Microsoft n.d.l). Today
`RefreshResponse` in `oidc.ts` discards `refresh_token`, so a stored token would age out instead of renewing
(inference; confirm in P6). `guardedWrite` in `tokens.ts` already fences a write on `credential_version`, so
the fix reuses it.

Only `invalid_grant` maps to `needs_reconnect` today. Entra can also fail with an expired client secret or a
step-up requirement; the exact error codes are M and are a P6 deliverable. Mapping a secret expiry to
`internal` would present every Outlook account as a transient outage. `recovery-http.ts` `allowed()` hard-codes
`GOOGLE.tokenUrl`, so recovery refresh needs its own exact-URL allowlist entry.

Amendment A5.

### G4. Invariant 7 (High)

`Mail.ReadWrite` is the only permission for `permanentDelete`, and no narrower option exists (V, Microsoft
n.d.a). The DELETE message page does not say whether DELETE moves to Deleted Items or hard-deletes, and notes
only that items in the recoverable-items deletions folder cannot be deleted (V, n.d.j). Treat DELETE as
destructive until P4 says otherwise.

Amendment A6. Split invariant 7: 7a Gmail, scope-enforced; 7b Outlook, code-enforced at one network choke
point with an allowlist that excludes `DELETE` on messages and folders and excludes `permanentDelete`. Add a
SECURITY.md residual row: a leaked Outlook access token can permanently delete, and a leaked Gmail token
cannot.

Separately, Microsoft will require the higher `Mail-Advanced.ReadWrite` family from 2026-12-31 to change
sensitive properties of non-draft messages; drafts, categories, flags and folder moves are unaffected (V,
Microsoft 365 Developer Blog n.d.; S, Office 365 for IT Pros 2026). Do not request it. Add a negative scope
test, mirroring the existing check that the Gmail grant carries `gmail.modify`.

Falsifier: a mutation test that adds a DELETE route to the allowlist and must turn red.

### G5. Consent and tenancy (High)

Unverified multi-tenant apps registered after 2020-11-08 cannot get ordinary user consent beyond basic
profile where risk-based step-up consent is enabled. Personal-account-only and single-tenant apps are not
affected. Verification needs a Cloud Partner Program account and an app registered with a work or school
identity (V, Microsoft n.d.o). A multi-tenant registration also needs per-tenant issuer handling (V, n.d.n).

Decision D1: register personal-account-only and single-tenant apps for the owner's own mailboxes, and defer a
combined multi-tenant registration with `P6-MULTI-USER`. A university or corporate tenant will often need
administrator consent; that is O6 and stays `not_run`. A new runbook, `docs/runbooks/microsoft-entra.md`, is
the counterpart of the Google Cloud runbook.

### G6. Concurrency and throttling (High)

A secondary source gives 10,000 requests per 10 minutes and 4 concurrent requests per app and mailbox, and 150
MB of uploads per 5 minutes, citing the official Outlook limits section (S, Microsoft Q&A n.d.). The primary
page came back truncated, so these figures are unverified. The repo has no per-account concurrency control
(no match for a semaphore, mutex or Durable Object in `worker/src`, and none bound in `wrangler.jsonc`).
`get_thread` fan-out, the five-minute cron and parallel agent calls can exceed four.

Amendment A10: a per-mailbox limiter, designed in Phase 1. An isolate-local semaphore does not span
isolates, so this needs a shared primitive, which is new infrastructure.

Falsifier: P10.

### G7. Thread-level mutations (High)

Graph has no thread resource, only a `conversationId` property (V, Microsoft n.d.h). Seven tools are single
atomic calls in Gmail and would be N-message loops on Graph: `label_thread`, `unlabel_thread`,
`apply_sensitive_thread_label`, `trash_thread`, `untrash_thread`, `mark_thread_spam`, `unmark_thread_spam`.
Partial failure and idempotency for a loop is the deferred `P6-BATCH` design.

Amendment A8: these return `unsupported_for_provider` on Outlook in v1. S7 is amended to a capability matrix
exposed through `list_accounts`.

### G8. Sensitivity classifier (High)

`isSystemLabel` in `worker/src/tools/labels.ts` is `/^[A-Z][A-Z0-9_]*$/`. It feeds `sensitiveModifiers` in the
label tools and refuses update and delete of system labels. Outlook categories are free-form display names,
and well-known folders are lower-case names (the DELETE page itself names `recoverableitemsdeletions`). A move
into Junk or Deleted Items would not match, so it would not raise `+sensitive`: a silent policy downgrade in
the unsafe direction. The `GmailId` schema type would also reject category names containing spaces.

Amendment A9: classification is supplied by the provider (`classifyTarget`), and categories are not label ids.

Falsifier: a matrix test that every Outlook route into Junk, Deleted or Archive yields `+sensitive`, confirmed
by neutralising the predicate.

### G9. Id stability (High)

By default an id changes when an item moves between folders, and the immutable form is opt-in per request
(V, Microsoft n.d.g, n.d.h). Trash, spam and restore are moves, so without the header the id returned by one
call fails in the next. Immutable ids still change on archive-mailbox moves and on export and re-import (V,
n.d.g). Gmail ids are stable across label changes, so no existing code defends against this.

Amendment A7: one fetch wrapper adds the header to every Graph request, a test fails if any outbound request
lacks it, and every tool result returns the post-move id. Ids are case-sensitive (V, n.d.g).

### G10. Send pipeline (High)

`mime/build.ts`, `mime/encode.ts`, `composeMime`, `GMAIL_SEND_MAX`, `MEDIA_UPLOAD_MAX`, `resumable.ts`,
`validateSessionUrl` and `operations/send.ts` are Gmail-shaped. The Graph path is a JSON message, attachments
below 3 MB posted directly, and 3 to 150 MB through an upload session whose chunks go in order and whose URL
is pre-authenticated (V, Microsoft n.d.f). Reply and forward are drafts created with `createReply` and
`createForward` (V, Microsoft n.d.e). The `S/MIME` 4 MB limit on the MIME path is documented (V, n.d.d); the
general MIME ceiling is not (P9).

The protocol-2 `begin` permit in `0005_operation_recovery.sql` allows `claimed` to `executing` only with
`byte_admitted=1`. For Outlook, byte admission must mean the `/send` call. Drafts and attachments happen while
the operation is `claimed`, and the binding, including the immutable draft id, is persisted before `/send`. A
crash before `/send` leaves a stray draft and no delivery, which matches Gmail's refusal to delete anything.
No new operation state is needed: the `operations.state` set is closed by a CHECK constraint.

Gmail's own session URL grew an undocumented parameter in live testing (see the comment in `resumable.ts`), so
the Outlook upload URL shape must be learned in P8 and not hard-coded from documentation.

Amendments A1, A2, A3.

### G11. `update_draft` (Medium)

Graph does not edit MIME properties individually (V, Microsoft n.d.e), and replacing a draft attachment needs
an attachment DELETE, which contradicts the no-DELETE allowlist. Decision D2: v1 offers `create_draft`,
`get_draft`, `list_drafts` and `send_draft`, and `update_draft` is unsupported on Outlook. One upside: an
Outlook draft has a known immutable id, so `send_draft` could be reconciled automatically, which Gmail's
manual-draft path cannot. Keep that conservative until O2 is proven.

### G12. Schema evolution (Medium)

CI fetches an immutable legacy writer baseline (`6e78bc5...`) and runs `capture_writer_corpus.py --check` and
`sql_conformance.py`, and the protocol-2 triggers reject legacy writers on protocol-2 rows. A column rename or
a new operation state therefore fails the project's own gates by design. Amendment A11: Phase 1 is additive
only, with a `provider` column defaulting to `gmail` and a provider-subject column. The existing result-id
columns keep their names, and the naming debt is accepted (G19).

### G13. `send_as` (Medium)

`from` must correspond to the mailbox actually used (V, Microsoft n.d.h). `senderFor` in `tools/compose.ts`
accepts the account address plus `sendAs`. For Outlook, `sendAs` is the mailbox address alone in v1; aliases,
shared mailboxes and delegation need further permissions and are out of scope. Amendment A12.

### G14. Search (Medium)

`$search` uses KQL, returns at most 1,000 results, and orders by sent date (V, Microsoft n.d.k). The fetched
summary says it may be combined with `$filter`; that conflicts with recollection and is unresolved (P5). Tool
descriptions are static and currently say "Gmail query syntax". Amendment A13: neutral wording, with
`query_dialect` exposed per account. Thread grouping by `conversationId` splits across message-level pages.

### G15. Org-domain discovery and distribution lists (Medium)

Marking a recipient internal relies on `org_domains`. Auto-discovering a tenant's domains needs a scope the
spec does not request, so Outlook work accounts classify everyone as external until an allowlist is set. That
fails safe. A distribution list counts as one recipient for `+bulk`; Google Groups behave the same, so this is
a residual risk rather than a regression. The service enforces a 500-recipient cap per message (V, n.d.h).

### G16. Test honesty (Medium)

The worker suite runs against `FakeGoogle`, a synthetic Gmail in workerd. A `fake-graph` must be seeded from
recorded Phase 0 fixtures and labelled "Locally verified against a synthetic Graph", never "Live". Any probe
that sends mail goes only to mailboxes the owner controls. Real mailbox mutation needs explicit authorization,
as in the earlier gauntlet.

### G17. Bodies and attachments (Medium)

A file attachment's `/$value` returns raw bytes, an item attachment returns MIME, and a reference attachment
returns 405 (V, Microsoft n.d.i). Raw bytes allow streaming and could later lift the 25 MiB ceiling
(`P6-LARGE-DOWNLOAD`). Reference attachments must surface as non-downloadable. The body-content-type
preference that yields plain text is M and belongs to P11.

### G18. Landscape (Low)

Microsoft's own Work IQ Mail MCP server is in preview, is organisational only, has no attachment handling, and
does not support personal accounts (S, Scalekit 2026). The project's differentiators stand. EWS in Exchange
Online is being disabled from 2026-10-01, with a final date of 2027-04-01 (S, University of Waterloo n.d.).
The Graph path is unaffected. No action.

### G19. Naming debt (Low)

`GmailMcpError`, the client-visible code `gmail_error` and the `@gmail-mcp/*` scope are Gmail-named. Do not
rename during the refactor. Introduce a `ProviderError` subclass later, and decide the repository name
separately.

## Spec v1 amendments

| ID  | Amendment                                                                                                                        | From    |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------- |
| A1  | Draft-first send. Direct `sendMail` is forbidden because it yields no correlation key                                            | G1      |
| A2  | The recovery binding, with the immutable draft id, is persisted before `/send`. Byte admission means `/send`                     | G1, G10 |
| A3  | `executed` requires 202 with the id known. Observation confirms. Absence never settles `failed_safe`                             | G1      |
| A4  | Provider-specific identity: `subject = tid:oid`, display address read from Graph                                                 | G2      |
| A5  | Persist rotated refresh tokens through `guardedWrite`. Map secret expiry and step-up to reconnect states. Add recovery token URL | G3      |
| A6  | Split invariant 7. One choke-point allowlist. No `Mail-Advanced.*` scope. SECURITY.md residual row                               | G4      |
| A7  | `Prefer: IdType="ImmutableId"` on every request, tested. Tool results return post-move ids                                       | G9      |
| A8  | Capability matrix. Seven thread mutation tools and `update_draft` are `unsupported_for_provider` in v1                           | G7, G11 |
| A9  | Provider-supplied `classifyTarget`. Categories are not label ids                                                                 | G8      |
| A10 | Per-mailbox concurrency limiter, designed in Phase 1                                                                             | G6      |
| A11 | Additive schema only. No renamed columns. No new operation states                                                                | G12     |
| A12 | `sendAs` is the mailbox address only                                                                                             | G13     |
| A13 | Neutral tool descriptions. `list_accounts` exposes provider, capabilities and `query_dialect`                                    | G14, G7 |

## Revised phases

| Phase | What                                                                                         | Gate                                                              |
| ----- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 0     | Probes P1 to P13 on throwaway accounts. Evidence document and recorded fixtures              | Evidence in the Plan 6 feasibility format                         |
| 1     | `MailProvider` seam, additive schema, classifier, choke-point allowlist, limiter design      | 862 TypeScript tests and the CI legacy corpus unchanged and green |
| 2     | Outlook read-only: connect, search, get, list drafts, download attachment, capability matrix | A live read on a real mailbox                                     |
| 3     | Categories, moves to Deleted and Junk with `+sensitive`, restore                             | Policy, audit and classifier matrix tests                         |
| 4     | Send, reply, forward and `send_draft` with observation                                       | O2 proven live. O1 stays `not_run`                                |

## Phase 0 probes

Every probe runs on a throwaway personal account or an owned developer tenant, and any destructive probe needs
explicit authorization first.

| ID  | Measure                                                                                       | Falsifier                                              |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| P1  | Draft, send, then GET by immutable id: same id, Sent folder, propagation delay distribution   | The id resolves to a different item, or never resolves |
| P2  | Sent copy `internetMessageId` against the header the recipient sees                           | Informational. Non-load-bearing (O3)                   |
| P3  | `$filter=internetMessageId eq` on Sent Items and on all messages, personal and work           | A filter that errors or returns more than one match    |
| P4  | DELETE on a message in Inbox and in Deleted Items, on a disposable mailbox                    | Treat as destructive if soft-delete is not observed    |
| P5  | `$search` with `$filter` and `$orderby`, personal against work                                | A combination the doc allows but the service rejects   |
| P6  | Refresh rotation, token lifetime, tenant endpoint against common endpoint, error bodies       | A stored token that stops renewing                     |
| P7  | Consent for a personal-only app and a single-tenant app                                       | An unexpected admin-consent requirement                |
| P8  | Upload-session URL host and shape, expiry, ordering, resume, state of a half-complete session | A URL form the validator cannot describe               |
| P9  | Size ceilings for JSON messages with attachments, and the MIME path for information           | A 413 below the stated limits                          |
| P10 | Four concurrent requests per mailbox, 429 behaviour, `Retry-After` format                     | Throttling below the secondary-source figures          |
| P11 | Body-content-type preference, item and reference attachments                                  | A body the plain-text path cannot represent            |
| P12 | Id stability across move to Deleted and Junk and back, with the immutable header              | An id that changes despite the header                  |
| P13 | Category value semantics: names or ids, length and character limits, master list              | A category name the schema type rejects                |

## Not established

- Anything about live Graph behaviour. No request was made to Microsoft.
- The throttling figures (secondary source) and the DELETE semantics (undocumented).
- Whether a custom `Message-ID` survives (undocumented, reports conflict).
- Whether `$search` combines with `$filter` (the fetched summary and recollection disagree).
- O1, the provider commit barrier. The Gmail version is already `not_run`, and Outlook inherits it.
- Independence. This review has the same author as the proposal.

## References

Microsoft 365 Developer Blog (n.d.) [Breaking change ahead: Graph API updates to sensitive email properties](https://devblogs.microsoft.com/microsoft365dev/graph-api-updates-to-sensitive-email-properties/), accessed 5 October 2026.

Microsoft (n.d.a) [message: permanentDelete](https://learn.microsoft.com/en-us/graph/api/message-permanentdelete?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.b) [user: sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.c) [message: send](https://learn.microsoft.com/en-us/graph/api/message-send?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.d) [Create message](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.e) [Send emails with MIME content using the Outlook mail API](https://learn.microsoft.com/en-us/graph/outlook-send-mime-message), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.f) [Attach large files to Outlook messages or events](https://learn.microsoft.com/en-us/graph/outlook-large-attachments), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.g) [Get immutable identifiers for Outlook resources](https://learn.microsoft.com/en-us/graph/outlook-immutable-id), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.h) [message resource type](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.i) [Get attachment](https://learn.microsoft.com/en-us/graph/api/attachment-get?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.j) [Delete message](https://learn.microsoft.com/en-us/graph/api/message-delete?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.k) [Use the $search query parameter](https://learn.microsoft.com/en-us/graph/search-query-parameter), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.l) [Refresh tokens in the Microsoft identity platform](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.m) [ID token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.n) [Convert single-tenant app to multitenant](https://learn.microsoft.com/en-us/entra/identity-platform/howto-convert-app-to-be-multi-tenant), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.o) [Publisher verification overview](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview), Microsoft Learn, accessed 5 October 2026.

Microsoft Q&A (n.d.) [Increasing Microsoft Graph per-mailbox throttling limits](https://learn.microsoft.com/en-us/answers/questions/5853334/increasing-microsoft-graph-per-mailbox-throttling), accessed 5 October 2026.

OfficeDev (n.d.) [internetMessageId changes after sending, Issue #2659](https://github.com/OfficeDev/office-js/issues/2659), GitHub, accessed 5 October 2026.

Office 365 for IT Pros (2026) [Microsoft limits app access to sensitive message properties](https://office365itpros.com/2026/03/26/sensitive-message-properties-graph/), 26 March, accessed 5 October 2026.

Scalekit (2026) [Outlook MCP vs Outlook API for AI agents](https://www.scalekit.com/blog/outlook-mcp-vs-api), accessed 5 October 2026.

University of Waterloo (n.d.) [Retirement of Exchange Web Services (EWS) on October 1, 2026](https://uwaterloo.ca/science-computing/news/retirement-exchange-web-services-ews-october-1-2026), accessed 5 October 2026.

## Revision 2: documentation re-verification

Appended 2026-10-05, same baseline `70ba710`. Everything above is left as written. This pass re-read every
claim graded M or S, and every V claim that carries a design decision, against the primary pages as they
stand in October 2026. This time each page's raw HTML was fetched and the text grepped, so the quotes below
are not summaries. The authorization boundary is unchanged: no request went to Graph, Entra or any
discovery endpoint. It is still the same author, so it is still not independent review.

### Re-graded claims

| Claim                                       | Was | Now | What the page says                                                                                                                                                                                                                  |
| ------------------------------------------- | --- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `internetMessageId` cannot be set (G1)      | V   | V   | **Wrong.** The update page says "Updatable only if isDraft = true" (Microsoft n.d.p). The resource page is silent, which is where v0 went wrong. Whether it survives send is still undocumented                                     |
| Outlook throttling figures (G6)             | S   | V   | Stated on the official throttling page: 10,000 requests per 10 minutes, four concurrent requests and 150 MB uploaded per 5 minutes, per app per mailbox (Microsoft n.d.q)                                                           |
| DELETE semantics (G4)                       | V   | V   | Still silent. The delete page never says whether the item goes to Deleted Items. Only `permanentDelete` states its effect. G4 stands                                                                                                |
| `$search` with `$filter` (G14)              | V   | S   | The search page's combined example is for directory objects only. Q&A answers report `SearchWithFilter` on `/messages` (Microsoft Q&A n.d.b). Treat as not combinable                                                               |
| `$filter` with `$orderby` (G14)             | n/a | V   | Every `$orderby` property must also appear in `$filter`, in the same order and first, or the call fails with `InefficientFilter` (Microsoft n.d.r)                                                                                  |
| Immutable id survives send (G1, O2)         | V   | V   | Confirmed, with a delay: "The copy of the message is not created until the message successfully sends, which might take time" (Microsoft n.d.g). O2 still needs P1                                                                  |
| `Mail-Advanced.*` change (G4)               | V/S | V   | Enforcement begins 31 December 2026. It covers the "Updatable only if isDraft = true" properties on non-draft messages. Drafts are unaffected (Microsoft 365 Developer Blog 2026)                                                   |
| Personal-account `tid`, `email`, `sub` (G2) | V   | V   | Confirmed. One qualification: the claims-validation page says to use `tid` and `oid` as a combined key, while the id-token page allows `sub` or `oid` alone. `oid` is only issued with the `profile` scope (Microsoft n.d.m, n.d.s) |
| Refresh rotation (G3)                       | V   | V   | Confirmed: tokens replace themselves on every use and the old one is not revoked. Default lifetime is 90 days (Microsoft n.d.l)                                                                                                     |
| Entra error codes (G3)                      | M   | V/U | The code texts are documented (700082, 50173, 50076, 50079, 65001, 7000215, 7000222). No page maps a code to an OAuth `error` value (Microsoft n.d.t)                                                                               |
| Publisher verification (G5)                 | V   | V/U | Confirmed for multi-tenant apps. Single-tenant is out of scope by its wording. The personal-only exemption is not stated (U). An app registered with a personal account cannot be verified (Microsoft n.d.o)                        |
| Body content type (G17)                     | M   | V   | `Prefer: outlook.body-content-type="text"`, confirmed by a `Preference-Applied` response header (Microsoft n.d.u)                                                                                                                   |
| EWS retirement (G18)                        | S   | V/S | Months are V: disablement starts October 2026 and is complete in April 2027. The exact days are S (Microsoft n.d.v)                                                                                                                 |
| Microsoft's mail MCP server (G18)           | S   | V   | Work IQ Mail is in preview and requires a Microsoft 365 Copilot licence and a tenant. Personal accounts are not mentioned (Microsoft n.d.w)                                                                                         |

### New findings

| ID  | Severity | Finding                                                                                                | Outcome         |
| --- | -------- | ------------------------------------------------------------------------------------------------------ | --------------- |
| G20 | High     | Default tenant consent policy blocks user consent to `Mail.ReadWrite` for every third-party app        | Decision needed |
| G21 | High     | `GmailId` rejects Graph ids                                                                            | Spec amended    |
| G22 | High     | The upload-session `PUT` must not carry `Authorization`, so A7's one-wrapper rule would leak the token | Spec amended    |
| G23 | Medium   | Category assignment is a whole-collection PATCH, so concurrent label edits lose updates                | Spec amended    |
| G24 | Medium   | Client secrets are discouraged for production and capped at 24 months                                  | Decision needed |
| G25 | Medium   | `get_thread` by `conversationId` cannot also sort server-side                                          | Spec amended    |
| G26 | Medium   | Restoring from Deleted Items or Junk has no Graph "restore": the original folder is lost               | Spec amended    |
| G27 | Low      | The generated `Message-ID` can be stamped on the draft, so it becomes a secondary correlator           | Spec amended    |
| G28 | Low      | Upload-session mechanics: no 320 KiB rule, a 3 MB minimum, a fixed expiry, and a fixed host            | Spec amended    |

**G20. Consent in work tenants (High).** "Let Microsoft manage your consent settings" is the default for new
tenants, and under it end users cannot consent to `Mail.Read` or `Mail.ReadWrite` for Microsoft Graph
(Microsoft n.d.x). This holds whether or not the app is publisher verified. `Mail.Send` and `User.Read`
are not on the list. Personal accounts can consent to `Mail.ReadWrite` (Microsoft n.d.y). Consequence: a
university or employer mailbox needs a tenant administrator to approve the app, every time. O6 keeps
`not_run`, and its expected result in a default tenant is now "admin consent required", not "unknown".
Decision D1 is narrowed in spec v1.

**G21. Id schema (High).** `GmailId` in `shared/src/schemas.ts` allows `[A-Za-z0-9_-]` only. Every message
and attachment id in the Graph examples ends in `=` padding, for example
`AAMkAGUzY5QKjAAABEgAQAMkpJI_X-LBFgvrv1PlZYd8=` (Microsoft n.d.i, n.d.u). So every id-taking tool would
reject every Outlook id, not just category names as G8 said. The general character set of a REST id is not
documented. Only the binary forms are stated to be URL-safe base64 (Microsoft n.d.z). Amendment A14.

**G22. Upload sessions and the bearer token (High).** "Do not specify an Authorization request header. The
PUT query uses a pre-authenticated URL from the uploadUrl property, that allows access to the
https://outlook.office.com domain" (Microsoft n.d.f). A7 says one fetch wrapper stamps every Graph request.
Applied naively, that sends the mailbox token to a second host. Amendment A15: two transports. The test
asserts that no request to the upload host carries `Authorization`, and that the authenticated transport
refuses every host except `graph.microsoft.com`.

**G23. Category writes (Medium).** A message's `categories` property is a collection of display names, and
the update page types it as a string collection (Microsoft n.d.p, n.d.aa). A label edit is therefore read,
modify, write the whole collection. Two concurrent edits to one message lose one of them. Gmail's
`modify` is a server-side add/remove, so the current code never had this race. Amendment A9 is extended:
serialise category writes per message under the limiter, and P13 tests whether `If-Match` on the message
`@odata.etag` is honoured (M).

**G24. Client credential (Medium).** Secrets are limited to 24 months, Microsoft recommends under 12, and
recommends certificates or federated credentials, saying secrets should not be used in production
(Microsoft n.d.ab). A Worker can sign a `private_key_jwt` client assertion with WebCrypto. Decision D4.

**G25. Thread reads (Medium).** With the `$filter`/`$orderby` rule above, `$filter=conversationId eq '…'`
cannot carry `$orderby=receivedDateTime` unless `receivedDateTime` is also filtered, which it cannot
usefully be. Amendment: filter only, with a bounded page cap, and sort in the Worker. P5 covers it.

**G26. Restore target (Medium).** Gmail `untrash` restores the labels a message had. Graph has only `move`,
and a message in Deleted Items does not say where it came from. Amendment: record the source folder id in
the operation payload when the tool moves an item. `untrash_message` and `unmark_message_spam` move back to
that folder when the operation is ours and the folder still exists, and to Inbox otherwise. The tool result
says which.

**G27. `Message-ID` on the draft (Low).** Because `internetMessageId` is writable while `isDraft` is true,
the existing `<op_…@host>` form can be set on the draft before `/send`. That is a permitted write under
`Mail.ReadWrite` before and after 31 December 2026. It gives the recipient-visible header the Gmail design
already uses, if it survives. It stays secondary: the immutable draft id remains the settlement key (A1 to
A3), and P2 decides whether the header can even be used for observation.

**G28. Upload mechanics (Low).** The Outlook rules are: bytes go up in order, chunks under 4 MB are
recommended, and the expiry is fixed by the first response (Microsoft n.d.f). The 320 KiB multiple belongs
to OneDrive, not Outlook. A session for a file under 3 MB fails with
`ErrorAttachmentSizeShouldNotBeLessThanMinimumSize`, so path choice is strictly by size. The documented
host is `outlook.office.com`. The validator still learns the full URL shape in P8 and does not hard-code
it, for the reason G10 gives.

### Not established, after this revision

- Anything about live Graph or Entra behaviour. No request was made.
- What DELETE does to a message. Still undocumented, still treated as destructive.
- Whether a `Message-ID` set on a draft survives send. Writable, survival undocumented.
- The general character set of a Graph REST id. Examples only.
- Which AADSTS code arrives with which OAuth `error` value. Texts documented, mapping not.
- Whether a personal-accounts-only registration is exempt from step-up consent.
- Whether `If-Match` is honoured on a message PATCH.
- O1 is unchanged and inherited.

### Additional references

Microsoft (n.d.p) [Update message](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.q) [Microsoft Graph service-specific throttling limits](https://learn.microsoft.com/en-us/graph/throttling-limits), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.r) [List messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.s) [Secure applications and APIs by validating claims](https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.t) [Microsoft Entra authentication and authorization error codes](https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.u) [Get message](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.v) [Deprecation of Exchange Web Services in Exchange Online](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-ews-exchange-online), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.w) [Tooling servers overview](https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.x) [Manage app consent policies](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.y) [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.z) [user: translateExchangeIds](https://learn.microsoft.com/en-us/graph/api/user-translateexchangeids?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.aa) [outlookCategory resource type](https://learn.microsoft.com/en-us/graph/api/resources/outlookcategory?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.ab) [Add and manage application credentials](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials), Microsoft Learn, accessed 5 October 2026.

Microsoft 365 Developer Blog (2026) [Breaking change ahead: Graph API updates to sensitive email properties](https://devblogs.microsoft.com/microsoft365dev/graph-api-updates-to-sensitive-email-properties/), 26 March, accessed 5 October 2026.

Microsoft Q&A (n.d.b) [Question 1184920](https://learn.microsoft.com/en-us/answers/questions/1184920) and [question 1401458](https://learn.microsoft.com/en-us/answers/questions/1401458), answers quoting the `SearchWithFilter` error, accessed 5 October 2026.

## Revision 3: full-surface inventory

Appended 2026-10-05, same baseline. The owner asked for coverage of everything the Graph mail API exposes,
not a Gmail-parity subset. This pass inventoried every v1.0 method on messages, attachments, folders,
search folders, categories, inbox rules, mailbox settings, Focused Inbox, MailTips, subscriptions, delta and
batching, and listed the beta-only and administrator-only endpoints. About 110 Microsoft Learn pages were
fetched as raw HTML and the text was grepped, so quotes are verbatim. The authorization boundary is
unchanged: no request went to Graph or Entra. It is still the same author.

Spec v2 is the result. It supports all 38 existing tools on Outlook, adds 25 Outlook tools, and gives every
endpoint a disposition: offered, internal or refused.

### Findings

| ID  | Severity | Finding                                                                                               | Outcome      |
| --- | -------- | ----------------------------------------------------------------------------------------------------- | ------------ |
| G29 | High     | Microsoft's own pages disagree on whether a draft's immutable id survives send                        | Spec amended |
| G30 | High     | `$batch` can carry any method and path, so an allowlist that ignores batch bodies is bypassable       | Spec amended |
| G31 | High     | `permanentDelete` is documented only under `/users/{id}/…`, so a `/me`-only block misses it           | Spec amended |
| G32 | High     | Inbox rules can forward, redirect, delete and permanently delete, and run after this service is gone  | Spec amended |
| G33 | High     | `reply`, `replyAll`, `forward` and `sendMail` all return 202 with no id                               | Spec amended |
| G34 | Medium   | MIME request bodies carry recipients inside base64, out of sight of the policy engine                 | Spec amended |
| G35 | Medium   | Automatic replies with an external audience send owner text to any sender                             | Spec amended |
| G36 | Medium   | Delegate meeting delivery can route meeting mail away from the owner                                  | Spec amended |
| G37 | Medium   | Focused Inbox overrides can bury a sender, and a create silently overwrites                           | Spec amended |
| G38 | Medium   | The default consent policy also blocks `MailboxSettings.*` and `Mail.ReadBasic` in work tenants       | Decision D3  |
| G39 | Medium   | Change notifications have short lifetimes, a 10-second handshake, and do not cover folders            | Phase 6      |
| G40 | Medium   | `Prefer: outlook.allow-unsafe-html` returns unsanitised HTML                                          | Spec amended |
| G41 | Low      | Search folders expire after 45 days unused and can be evicted                                         | Spec amended |
| G42 | Low      | Hidden folders are left out of listings by default                                                    | Spec amended |
| G43 | Low      | Exchange Online limits sending to 30 messages a minute                                                | Spec amended |
| G44 | Low      | Mailbox export, import, item hard delete and message trace are v1.0, not beta, but administrator-only | Excluded     |
| G45 | High     | A move into `recoverableitemsdeletions` is a delayed permanent delete                                 | Spec amended |
| G46 | Medium   | A category name cannot be changed after creation                                                      | Spec amended |

**G29. Draft id across send (High).** The immutable-id page says to create a draft with the header, send
it, and get it by the same id: "This is the copy in Sent Items" (V, Microsoft n.d.g). The mail overview
says immutable ids hold "as long as the message remains in the same mailbox, with the exception of sending
a draft message, and a few other scenarios" (V, Microsoft n.d.ac). Both are primary pages, and they
conflict. A1 to A3 relied on the first. Amendment A24: two observation keys, the draft id and the
`internetMessageId` stamped by G27, neither trusted alone and neither proving non-delivery by absence. P1
now tests both pages' claims on personal and work accounts.

**G30. Batch bodies (High).** A batch carries up to 20 sub-requests, each with its own method and URL
(V, Microsoft n.d.ad). An allowlist that checks only the outer `POST $batch` lets a refused DELETE through.
Amendment A17: only the Worker builds batches, and every sub-request passes the allowlist first. The 7b
mutation test includes a caller-supplied batch.

**G31. Path prefixes (High).** Message and folder `permanentDelete` are documented under `/users/{id}/…`
only (V, Microsoft n.d.a, n.d.ae). A17: `graphFetch` accepts `/v1.0/me/` paths only, refuses `/users/` and
`/beta/` outright, and matches `permanentDelete` under any prefix.

**G32. Inbox rules (High).** The rule actions are `assignCategories`, `copyToFolder`, `delete`,
`forwardAsAttachmentTo`, `forwardTo`, `markAsRead`, `markImportance`, `moveToFolder`, `permanentDelete`,
`redirectTo` and `stopProcessingRules`. `permanentDelete` means the message is "permanently deleted and not
saved to the Deleted Items folder" (V, Microsoft n.d.af). Microsoft's own security guidance names rules
that forward externally as a compromise pattern, and since 2021 new organisations block automatic
external forwarding by default with an NDR (V, Microsoft n.d.ag). Nothing documents the personal-account
behaviour (U). Amendment A20: a `permanentDelete` action is refused whatever the policy, forward targets
are recipients for `+external` and `+bulk`, and delete or hide patterns are `+sensitive`. `list_rules`
marks every forwarding or deleting rule, including ones this service did not create.

**G33. Direct sends (High).** All four direct routes return 202 with an empty body (V, Microsoft n.d.b,
n.d.c, n.d.ah). A1 is extended from `sendMail` to all four.

**G34. MIME writes (Medium).** Draft creation, `sendMail` and the reply family all accept base64 MIME,
with recipients taken from its headers (V, Microsoft n.d.e). The policy engine would have to parse MIME to
see who receives the mail. Amendment: every write is JSON; MIME is only read, through `export_message`.

**G35 to G37. Settings (Medium).** `automaticRepliesSetting.externalAudience` is `none`, `contactsOnly` or
`all` (V). `delegateMeetingMessageDeliveryOptions` includes `sendToDelegateOnly` (V). A Focused Inbox
override for an address that already has one updates it in place, and a mailbox holds at most 1,000 (V,
Microsoft n.d.ai). Amendment A21: an external audience is `+external`, a delivery change is `+sensitive`,
and an override to Other is `+sensitive`.

**G38. Consent (Medium).** The managed default excludes from user consent, among others, `Mail.Read`,
`Mail.ReadWrite`, `Mail.ReadBasic`, `MailBoxSettings.Read` and `MailBoxSettings.ReadWrite` (V, Microsoft
n.d.x). Personal accounts can consent to `MailboxSettings.ReadWrite` (V, Microsoft n.d.y). So requesting it
adds nothing in a work tenant, where `Mail.ReadWrite` needs the administrator anyway. D3 is reversed: the
scope is requested and label administration, rules and settings are supported.

**G39. Change notifications (Medium).** Message subscriptions last at most 10,080 minutes, or 1,440 with
resource data, and a mailbox allows 1,000 of them across all applications. The validation reply is due
within 10 seconds. `mailFolder` is not subscribable. The webhook page calls `clientState` required while
the resource page calls it optional (V, Microsoft n.d.aj). Phase 6 uses basic notifications only, always
sets `clientState`, and pins the notification URL to this Worker.

**G40. Unsafe HTML (Medium).** `Prefer: outlook.allow-unsafe-html` returns the original, unsanitised HTML
(V, Microsoft n.d.ak). A17's transport test fails if any request carries it.

**G41 and G42. Folders (Low).** Search folders "expire after 45 days of no usage", and older ones are
evicted past a per-folder limit (V). Folders created with `isHidden` are left out unless
`includeHiddenFolders=true` (V). Amendment A19: listings always include hidden folders, creating one is
`+sensitive`, and a search folder result warns of expiry.

**G43. Send rate (Low).** "30 messages per minute" (V, Microsoft n.d.al). The limiter admits sends against it.

**G44. Administrator APIs (Low).** `exportItems`, `createImportSession`, `mailboxItem` delta and delete,
and message trace are v1.0 under `/admin/exchange/`. They need administrator-consented scopes, do not
support personal accounts, and item delete takes `disposalType=hardDelete` (V). Excluded, and the scope
check refuses `MailboxItem.*` and `MailboxFolder.*`.

**G45. Recoverable items (High).** `recoverableitemsdeletions` is a well-known folder name a move can
target. Items there stay "until the deleted item retention period is reached", which defaults to 14 days,
and then the Managed Folder Assistant purges them (V, Microsoft n.d.am). A move there is a delayed
permanent delete. A19 refuses it, and every other system folder except Inbox, Archive, Deleted Items and
Junk, as a move target.

**G46. Category names (Medium).** "You can't modify the displayName property once you have created the
category" (V, Microsoft n.d.an). Gmail `update_label` can rename. On Outlook a rename returns
`immutable_on_provider` and a colour change is allowed.

### Amendments A17 to A24

| ID  | Amendment                                                                                                          | From          |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------- |
| A17 | `graphFetch` takes `/v1.0/me/` only; refuses `/users/`, `/beta/`, caller batches and the unsafe-HTML header        | G30, G31, G40 |
| A18 | Four new actions: `folder.manage`, `message.organize`, `rule.manage`, `settings.edit`                              | full coverage |
| A19 | Classification covers hidden folders and refuses system folders, including `recoverableitemsdeletions`, as targets | G41, G42, G45 |
| A20 | Rule policy: no `permanentDelete` action, forward targets are recipients, hide patterns are `+sensitive`           | G32           |
| A21 | Settings policy: external auto-replies, delegate delivery and Focused overrides raise modifiers                    | G35 to G37    |
| A22 | Thread tools as convergent, bounded loops with a frozen member set and per-item outcomes                           | G7            |
| A23 | `update_draft` patches in place, and replaces the draft when attachments change                                    | G11           |
| A24 | Two-key send observation, and MailTips before send that can only raise modifiers                                   | G29, G15      |

A8 is superseded: no existing tool is `unsupported_for_provider` on Outlook. D2 and D3 are reversed.

### Not established, after this revision

- Which observation key holds after send. The two pages conflict.
- What DELETE does to a message or a folder. Both stay refused.
- What happens to tagged items when a master category is deleted (U, P18).
- Personal-account behaviour for external forwarding rules (U, P15).
- Everything live. No request was made.

### Revision 3 references

Microsoft (n.d.ac) [Use the Outlook mail REST API](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.ad) [Combine multiple HTTP requests using JSON batching](https://learn.microsoft.com/en-us/graph/json-batching), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.ae) [mailFolder: permanentDelete](https://learn.microsoft.com/en-us/graph/api/mailfolder-permanentdelete?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.af) [messageRuleActions resource type](https://learn.microsoft.com/en-us/graph/api/resources/messageruleactions?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.ag) [Control automatic external email forwarding](https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-policies-external-email-forwarding), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.ah) [message: reply](https://learn.microsoft.com/en-us/graph/api/message-reply?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.ai) [Create inferenceClassificationOverride](https://learn.microsoft.com/en-us/graph/api/inferenceclassification-post-overrides?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.aj) [subscription resource type](https://learn.microsoft.com/en-us/graph/api/resources/subscription?view=graph-rest-1.0) and [Receive change notifications through webhooks](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.ak) [Create and send Outlook messages](https://learn.microsoft.com/en-us/graph/outlook-create-send-messages), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.al) [Exchange Online limits](https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.am) [Recoverable Items folder in Exchange Online](https://learn.microsoft.com/en-us/exchange/policy-and-compliance/recoverable-items-folder/recoverable-items-folder), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.an) [Update outlookCategory](https://learn.microsoft.com/en-us/graph/api/outlookcategory-update?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.ao) [Get mail tips](https://learn.microsoft.com/en-us/graph/api/user-getmailtips?view=graph-rest-1.0), Microsoft Learn, accessed 5 October 2026.

Microsoft (n.d.ap) [Get incremental changes to messages in a folder](https://learn.microsoft.com/en-us/graph/delta-query-messages), Microsoft Learn, accessed 5 October 2026.
