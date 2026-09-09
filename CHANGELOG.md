# Changelog

Notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project will follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from its first
release.

## [Unreleased]

The project is pre-release. Nothing here has sent an email.

### Added

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

- The `@types/node` dependency, which nothing used. The worker tsconfig lists its types explicitly and
  does not include `node`, and the only `node:` import sits outside the tsconfig `include`. It also
  shadowed the Workers `Crypto` interface, which is where `DigestStream` is declared.

### Security

- The development bearer requires both `DEV_STATIC_TOKEN` and `DEV_STATIC_USER`. A partial configuration
  authenticates nobody rather than inventing an identity.
- Dependabot ignores vitest major bumps. `@cloudflare/vitest-plugin` peers on `vitest ^4.1.0` and it is
  what runs the Worker tests inside workerd, so a major bump cannot pass CI until the plugin accepts one.

### Not yet implemented

Google OAuth and the approval pages, the 38 Gmail tools and the send pipeline, and the local companion.
