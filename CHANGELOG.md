# Changelog

Notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project will follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from its first
release.

## [Unreleased]

The project is pre-release. Nothing here has sent an email.

### Added

- Identity and the owner's web pages. Every route is now behind a real principal, and the development
  bearer is deleted rather than disabled.
  - OAuth 2.1 for MCP clients and the local companion through `@cloudflare/workers-oauth-provider`, with
    Client ID Metadata Documents, S256 PKCE and dynamic registration for compatibility. The owner decides
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
- Worker foundations: the authority core of the Gmail MCP server, tested against the real Workers
  runtime across 77 tests with no mocked storage.
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

- Staging ingest validates before it writes. The body is read to completion, length-checked and hashed
  before anything reaches R2. Streaming straight through aborted the in-flight upload when the declared
  length was wrong, which left a partial object behind and surfaced as an unhandled rejection that made
  the test runner exit non-zero even though every assertion passed.
- Prose across the project documents had its AI writing patterns removed: em dashes, bold-lead bullets
  rewritten as sentences, decorative adverbs and one transition crutch. The named invariants in the
  design spec and the mandated fields in the implementation plan kept their bold leads, because the rest
  of those documents and the code comments cite them by name.
- CI runs `actions/checkout` and `actions/setup-node` at v7.

### Removed

- The development bearer, along with `DEV_STATIC_TOKEN` and `DEV_STATIC_USER`. Nothing reaches `/mcp`
  without a token the OAuth provider issued.

- The `@types/node` dependency, which nothing used. The worker tsconfig lists its types explicitly and
  does not include `node`, and the only `node:` import sits outside the tsconfig `include`. It also
  shadowed the Workers `Crypto` interface, which is where `DigestStream` is declared.

### Security

- OAuth state is strongly consistent. Workers KV is eventually consistent, so a read followed by a delete
  cannot promise one-use semantics; that state moved to D1 and is consumed by one statement.
- Remembered consent is bound to the owner's Google `sub`, so approving a client under one owner does not
  silently approve it for another owner in the same browser.
- Trust-boundary settings on the accounts page, including the recipient allowlist and organisation
  domains, need a recent login and are audited. Allowlist entries are stored through the same
  canonicalisation the trust rules read them with, so a stored entry always means what it will match.
- Policy edits and approval decisions write their audit row in the same transaction as the change.

- The development bearer requires both `DEV_STATIC_TOKEN` and `DEV_STATIC_USER`. A partial configuration
  authenticates nobody rather than inventing an identity.
- Dependabot ignores vitest major bumps. `@cloudflare/vitest-plugin` peers on `vitest ^4.1.0` and it is
  what runs the Worker tests inside workerd, so a major bump cannot pass CI until the plugin accepts one.

### Not yet implemented

Google OAuth and the approval pages, the 38 Gmail tools and the send pipeline, and the local companion.
