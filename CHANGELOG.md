# Changelog

Notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project will follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from its first
release.

## [Unreleased]

The project is pre-release. Nothing here has sent an email.

The suite is 840 tests, 642 of them inside the real Workers runtime against D1, R2 and KV emulation with
no mocked storage. `npm run verify` is the gate, and CI runs the same command.

### Added

- The 38 remote tools. Reads, drafts, sends, labels, spam and trash all run through one gate that
  applies the policy engine, stores an `ask` as a canonical payload, and journals every external
  mutation. `execute_pending` runs an approved action once; a second call is a replay.
- URL-mode elicitation on protocol revision 2026-07-28. When the client can open a URL, an `ask`
  answers `input_required` with the approval page and HMAC-bound `requestState`; the accepted retry
  waits for the owner's decision inside the same call. Every other client receives the approval URL as
  text, which is spec 1.4's second path.
- The send pipeline: staged attachments and carried originals become one MIME message with RFC 2047
  headers and RFC 2231 filenames; media or multipart upload at or under 5 MB, resumable above; a 4xx is
  `failed_safe`, anything else after the upload opened is `delivery_unknown` and never retried.
- `download_attachment` stages the decoded bytes and returns a handle; bytes never enter a result.
- An in-memory Gmail for the test suite that mirrors the discovery document (revision 20260907),
  including both upload protocols and fault injection hooks for Plan 5.

- Identity and the owner's web pages. Every route is now behind a real principal, and the development
  bearer is deleted rather than disabled.
  - OAuth 2.1 for MCP clients and the local companion through `@cloudflare/workers-oauth-provider`, with
    S256 PKCE and dynamic registration for compatibility. The owner decides
    at consent time which scope a client may hold: the companion may hold `staging`, everyone else `mcp`.
    Each scope has its own audience, so a token for one route is refused at the other.
  - Google OIDC login for the owner, with a bootstrap page that shows the Google `sub` to configure on a
    fresh deployment and grants no session while doing it.
  - Google account connection per alias, requesting `gmail.modify` and never `mail.google.com`. Refresh
    tokens are stored encrypted per account, and a connection that fails after Google issued one revokes
    it rather than leaving a live grant behind.
  - One-use OAuth state in D1, consumed by a single atomic statement. Two callbacks carrying the same
    state yield one session; two consent decisions on one request yield one grant.
  - Credential writes guarded by an account credential version, so a revocation that lands during a token
    refresh wins and the refreshed token is discarded.
  - Browser sessions with hashed identifiers, a twelve hour lifetime, a two hour idle timeout, rotation at
    login, and recent-authentication checks that read the login time and never activity.
  - Six server-rendered pages with no client JavaScript: approve, accounts, policy, audit, login and the
    consent screen. The approval page renders a typed view per action and prints any unrecognised payload
    in full, so nothing is approved blind.
  - Stateless per-form CSRF tokens bound to session, method, route and object, plus an Origin check.
  - The companion-facing staging routes for reading a staged attachment and acknowledging the write.
- Worker foundations: the authority core of the Gmail MCP server.
  - D1 schema where ownership is a composite foreign key rather than a convention, with partial unique
    indexes for owner-wide policy rows and bounded checks on account flags.
  - Action-based policy engine. Every action resolves to `allow`, `ask` or `deny`; modifiers
    (`+external`, `+attachment`, `+bulk`, `+sensitive`, `+overwrite`) can only raise a level.
  - Recipient trust rules over a deliberately restricted address grammar, with punycode domains and
    provider-aware local-part handling.
  - Approval engine. A pending action stores its canonical (RFC 8785) payload and the hash of exactly
    those bytes; the claim is one atomic transaction that also reserves the attachments named in the
    approved payload.
  - Operation journal for external side effects, with idempotency keys bound to an action and a payload
    hash, and an explicit `delivery_unknown` state for ambiguous sends.
  - Attachment staging with non-enumerable handles, validate-before-write ingest, download-only reads,
    and a reserve, consume and release lifecycle.
  - Structured audit log that renders its own summaries, so message content cannot pass through it.
  - Scheduled recovery that is bounded per run and transactional, and leaves in-flight operations alone.
  - AES-256-GCM keyring with per-ciphertext key ids and framed additional authenticated data.
  - MCP endpoint with four control tools, behind a development bearer that requires two secrets and is
    deleted rather than disabled once OAuth lands.
- Project documentation: README, architecture overview, security policy, contribution guide, code of
  conduct, and GitHub issue and pull request templates.
- Tooling: ESLint with type-aware rules, Prettier, EditorConfig, and a single `npm run verify` gate that
  CI runs unchanged. Dependabot watches npm and GitHub Actions weekly.

### Changed

- `getAccessToken` accepts `forceRefresh`, which the Gmail client uses on a 401.
- `Deps` carries `sleep` and the approval wait interval and deadline, so tests collapse time.
- `draft.write` is journaled for updates as well as creates, because reserving an upload handle needs
  an operation row. Journaling is decided per tool, not per policy action.
- Idempotency keys live in their own table, keyed on the client's intent, and hold across the whole
  approval lifecycle: the same key returns the same pending action, then replays its result.
- Every local consequence of a Gmail result is one D1 batch.
- A claim on a pending action that already ran answers `pending_replayed` rather than
  `pending_not_approved`.
- `create_label` no longer creates missing parent labels.

- Staging ingest validates before it writes. The body is read to completion, length-checked and hashed
  before anything reaches R2. Streaming straight through aborted the in-flight upload when the declared
  length was wrong, which left a partial object behind and surfaced as an unhandled rejection that made
  the test runner exit non-zero even though every assertion passed.
- Prose across the project documents had its AI writing patterns removed: em dashes, bold-lead bullets
  rewritten as sentences, decorative adverbs and one transition crutch. The named invariants in the
  design spec and the mandated fields in the implementation plan kept their bold leads, because the rest
  of those documents and the code comments cite them by name.
- Domain canonicalisation is stricter. `toAsciiDomain` rejects empty labels, leading and trailing
  hyphens, labels over 63 bytes and names over 253, having previously accepted `-foo.com`. The web pages
  store trusted domains through it, so what it accepts is a permission boundary.
- CI runs `actions/checkout` and `actions/setup-node` at v7.

### Removed

- The development bearer, along with `DEV_STATIC_TOKEN` and `DEV_STATIC_USER`. Nothing reaches `/mcp`
  without a token the OAuth provider issued.
- The `@types/node` dependency, which nothing used. The worker tsconfig lists its types explicitly and
  does not include `node`, and the only `node:` import sits outside the tsconfig `include`. It also
  shadowed the Workers `Crypto` interface, which is where `DigestStream` is declared.

### Security

- The retired decision not to put an internal correlation identifier into outgoing mail now has a test.
  `X-Claude-Audit-Id` was retired in the original design and correctly recorded as retired rather than
  deferred, but a retired privacy decision with no test is the kind of thing that returns quietly. Two
  cases assert that a built message carries no `X-` header of any kind and no operation identifier
  outside the `Message-ID` that legitimately travels, and the check is broader than the header that was
  named because the decision was about metadata reaching recipients rather than one spelling.
- Qualification evidence cannot be re-pointed at another identity. Twelve axes, from owner and account
  through grant epoch, deployment, build and profile to run id, manifest and start time, are each moved
  in the report and the expectation together so the top-level equality check is satisfied and only a
  deeper binding can refuse. All twelve are refused, along with eight single-edge graph corruptions. The
  binding that carries it is the run identity hash inside every observation, which is the sole guard for
  the three axes that are not part of the target, and it joins the load-bearing list.
- Deployment identity is proved against the code actually receiving the traffic, not against a
  deployment object that once existed. Six authoritative comparisons each turn exactly one case red when
  neutralised alone, and the two that carry the invariant are the served build and version headers: every
  platform-side identifier can line up while the Worker answering `/healthz` is something else.
- The absence of peak memory evidence cannot leave the release aggregate. `resources` is one of the
  components `assessRelease` requires, a missing component blocks without incrementing the verified
  count, and a pass needs every component plus both modes, so an unmeasured gate stays blocking. Release
  authority is additionally unreachable today by construction: `release` is only ever `fail` or
  `not_run`, and `implementation_incomplete` is always among the blockers.
- Every refusal predicate guarding a restore is now covered by a case of its own, and each was
  neutralised alone to confirm the case named after it is the one that fails. The half of the restore
  matrix that would need a restore request is recorded as `not_run` with its prerequisite, because there
  is no request to make ambiguous and no reconciliation step to read a post-restore fact from. The rule
  that an uncertain restore must not produce a blind second request is currently enforced by
  construction rather than by a check, which is stronger while it lasts and needs re-testing as a rule
  the day a controller appears.
- The cross-host exclusion gate refuses at both of its emission sites, neither of which was tested
  before. A missing mechanism and a failing check both write a `not_run` record, neither reaches
  dispatch, and the private failure text stays out of the record. The gate itself remains open: what
  passes is the refusal, not the guarantee.
- Native publication is restarted from each surviving combination of temporary file, published file and
  receipt. A file at the destination proves nothing on its own: recovery is decided by the receipt and
  the verified identity behind it, and an established publication whose destination stopped matching
  becomes `publication_unknown` rather than permission to write there again. The receipt is recorded as
  verified before the rename and published only after it, so a failure in between stays retryable
  instead of losing the transfer. Mutation testing also corrected an assumption: the state check in
  recovery is redundant with the temporary-discard check rather than load-bearing, which is why it is
  not listed among the load-bearing predicates.
- The companion is killed at every edge of the authority handoff and never produces two authoritative
  local publications. A crash after fsync but before the reply is read leaves a durable receipt, so the
  retry skips the download and the publication entirely; a crash before the bytes land legitimately
  redoes the work. Measuring that needed two counters rather than one, since a counter incremented on
  entry reads a correct retry as a duplicate. The companion also refuses to report a file as
  acknowledged when the helper has not recorded the acknowledgement, which was true before and is now
  tested: the guard was unreachable from every case in the suite, so deleting it kept everything green.
- The global materialization slot is proved on both halves. Safety: one holder at a time, the same owner
  refused a second job, a live upload blocking it, and no slot left behind by a refused reservation.
  Liveness: the slot returns when the body throws, and a holder stalled past its lease stops excluding
  anyone. Exclusivity is therefore time-bounded rather than absolute, which is the deliberate price of
  not letting one dead process wedge every later job, and it is now written down as such.
- A download acknowledgement can no longer release bytes another claim still covers, and a reader that
  vanishes gives its slot back. The consuming update carries `reserved_by_operation_id IS NULL`, so an
  operation that has reserved an attachment keeps it even though the reader is told its acknowledgement
  was recorded, which is true and harmless. Releasing a lease recomputes it from the streams that remain
  rather than clearing the column, so one reader finishing does not strip the lease from another still
  reading, and the slot is returned in a `finally` inside the stream's cancel. No settlement permit ever
  spans R2 I/O, which every case asserts rather than one.
- An abandoned upload can never become the authoritative one, and an interrupted one is never declared
  safe on a guess. A put that was entered but never answered leaves its writer unknown, so its debt stays
  charged: the sweep deletes the bytes on every pass, and a delayed write landing later is removed again
  on the next. Resurrected bytes are harmless because nothing can reference them, since no handle row is
  ever written for an abandoned generation and a retry is issued its own key. Two predicates carry that
  and neither has a partner, so both are now named in the ledger alongside the other load-bearing ones.
- The restore identity condition is a schema refinement rather than a call-site check. `RestoreTarget`
  refuses any value whose generation differs from its snapshot's restore generation, or whose database
  differs from the snapshot's, in either direction, so the duplicated field is not a second source of
  truth. Restore itself remains unimplemented and its live matrix is recorded as `not_run` with the
  prerequisite named, because no restore request can be issued and inventing evidence for one would be
  worse than the gap. The controller's last refusal, which stops a future working quiescence verifier
  from silently activating an unreviewed restore, had no test at all and now has one.
- Every failure point between the first mutating request and the client's reply is measured against one
  evidence tuple, and none of them can report `failed_safe`. That code is a promise that Gmail did
  nothing, and once bytes have been handed to the transport nobody can honestly make it. What enforces
  this is an ordering rather than a check: `beginSend` runs strictly before the byte-moving request, so
  the condition `recordFailure` tests is already false downstream. Moving the request ahead of it makes a
  transport reset report `failed_safe` with the bytes already streamed, which is how the ordering was
  confirmed to be load-bearing. The two rungs after Gmail has committed report `executed` with
  `local_settlement_failed`, because reporting a failure there would invite a retry of a delivered send.
- Administration that lands mid-recovery stops the run in progress, not merely the next one. The lease
  names the qualification epoch it was admitted under and every request re-reads the control row, so
  disabling the mode or replacing the epoch refuses the second leg of an observation already underway.
  Disabling is refused independently by the control state and by the recovery row suspension; the epoch
  is one clause on its own. Replacing an epoch parks the recovery at `manual` rather than retrying it, so
  re-arming is an operator act, and the operation's delivery truth is untouched throughout.
- Interrupted storage cleanup leaves recoverable debt rather than orphans. `abandonStorage` deletes the
  object before the row that names it, so a crash between the two leaves a row a retry can settle instead
  of an object nothing will ever collect. Reversing those two statements breaks three of the six cases.
  A restore landing mid-cleanup is stopped by the installation fence on each per-object batch, and a
  manifest naming another owner, account or operation is refused before anything is selected or removed.
- The grant a recovery was admitted under is now proven, not assumed. A reconnect or a revoke that lands
  while a protocol-2 recovery is mid-flight moves the account's `credential_version`, and the recovery
  must stop rather than finish its work against the replacement grant. Six cases drive the real cron path
  and mutation-testing names which guard does the work at each point: the token pin, the durable admission
  gate, and one clause in `recoveryFences`. That clause, `a.credential_version=r.credential_version`, is
  the only guard in the path that is a single point of failure, and removing it settles the operation
  against the new grant. The inverse is asserted too, because it is what a careless fix would break: an
  ordinary access token refresh is not a new grant and leaves both the epoch and the recovery intact. No
  defect was found; the fences held.
- Canonicalisation refuses a hole in an array. `canonicalize` mapped over arrays, and `map` skips a hole
  while `join` renders it as nothing, so a sparse array produced `[1,,3]`, which no JSON parser accepts.
  This is the primitive `payload_hash` and the intent hash are computed over. Nothing schema-validated
  can carry a hole, so it was latent, but a primitive whose job is to be exact should refuse rather than
  guess. The rest of RFC 8785 was probed at the same time and already behaved: negative zero, `1e21`, key
  order by UTF-16 code unit rather than code point, null-prototype objects, `Date`, `BigInt`, `undefined`.
- A new client identity can only come into existence while the owner has opened a registration window.
  Dynamic client registration answered any unauthenticated caller, which is enough to phish the owner's
  own consent page: register a plausibly named client with your own redirect URI, send the owner a link
  to `/authorize` on this origin, and an approval hands you the code. Registration is closed by default
  and the owner opens ten minutes of it from the accounts page, behind the same CSRF and recent-login
  bar as a policy edit. The window is a database row, so nothing a registration request carries can
  open it.
- Client ID Metadata Documents are refused. A CIMD client identifies by URL and never registers, so
  accepting them left the registration window with a door beside it that any HTTPS host could walk
  through, and made the authorisation server fetch a URL an unauthenticated caller chose. MCP's 2026
  security guidance reserves accepting any HTTPS client id for open servers; this deployment has one
  owner, and the library offers no allowlist to configure instead.
- A redirect target may not carry control characters. `isInternalPath` and `redirect` checked only the
  character after the leading slash, and a URL parser strips tab, CR and LF before resolving, so
  `/<TAB>//evil.test` left the origin. It was reachable through `/login?return=`, which is acted on
  after a successful Google login. The runtime rejects CR and LF in a header value but not tab.
- Creating OAuth state collects expired state. Both `/login` and `/authorize` insert a row without
  authentication, and only a five-minute cron with a 200-row limit removed any, so request volume grew
  the table without bound. Each insert now collects expired rows in the same batch.
- OAuth state is strongly consistent. Workers KV is eventually consistent, so a read followed by a delete
  cannot promise one-use semantics; that state moved to D1 and is consumed by one statement.
- Remembered consent is bound to the owner's Google `sub`, so approving a client under one owner does not
  silently approve it for another owner in the same browser.
- Trust-boundary settings on the accounts page, including the recipient allowlist and organisation
  domains, need a recent login and are audited. Allowlist entries are stored through the same
  canonicalisation the trust rules read them with, so a stored entry always means what it will match.
- Policy edits and approval decisions write their audit row in the same transaction as the change.
- The libheif advisories carried by `sharp` are cleared. `miniflare` pins it at exactly 0.35.2, so the
  root manifest overrides it to the patched 0.35.4. The package never reaches the deployed Worker, but a
  clean `npm audit` is worth more than an exception nobody rereads.
- Dependabot ignores vitest major bumps. `@cloudflare/vitest-plugin` peers on `vitest ^4.1.0` and it is
  what runs the Worker tests inside workerd, so a major bump cannot pass CI until the plugin accepts one.

### Not yet implemented

Plan 6 closure: production controllers and mode-to-enable wiring, mutation-bearing preparation closure,
the administration interruption matrix, upload transaction and race acceptance, and restore integration.

Three feasibility gates stay open as refusal paths rather than being argued closed: no supported
mechanism isolates a Gmail provider commit from a Worker receipt on the exact deployed artifact; D1 Time
Travel cancelling in-flight queries does not establish that an old or cross-host writer cannot write
afterwards; and Cloudflare's sampled invocation memory does not establish peak isolate coverage for the
required runs.

Both protected-resource metadata documents advertise `scopes_supported: ["mcp", "staging"]`, because the
provider takes one metadata object for both well-known paths. A client following the specification's
scope selection strategy would request both and be refused, since a client may hold one scope or the
other. Splitting it means wrapping the well-known routes.

Local development over plain HTTP is deferred by choice: the Worker builds its redirect URIs, token
audiences and `Origin` check as `https://<WORKER_HOSTNAME>`, so `wrangler dev` cannot complete an OAuth
flow. Three of those four call sites are security boundaries, so they get a deliberate change rather than
a convenience flag.
