# Contributing

Thank you for considering a contribution. This document covers the development loop, how the project
thinks about tests, and what makes a change straightforward to review.

## Getting set up

Node 20 or newer is required. The repository is an npm workspace with two packages: `shared` holds the
contracts, `worker` holds the Cloudflare Worker.

```bash
npm install
npm run verify
```

`npm run verify` runs formatting, linting, type checking and the tests, in that order. It is exactly what
CI runs. If it is green locally, CI will be green.

Individual gates, when you want a faster loop:

```bash
npm run format        # rewrite files to the project style
npm run lint          # eslint, type-aware
npm run typecheck     # regenerates Worker types, then tsc
npm test              # every test in both packages
```

To run a single test file:

```bash
cd worker && npx vitest run test/claim.test.ts
```

Worker tests execute inside the real Workers runtime through `@cloudflare/vitest-plugin`, against real D1,
R2 and KV emulation. There are no mocks for the storage layer, so a passing test means the SQL, the
transactions and the constraints actually work.

## How this project tests

Tests are written before the code, and the failing run is observed before the implementation is written.
This is not ceremony. Several real defects in this codebase were caught only because a test was watched
failing for the right reason first: an assertion that passes on first write has proven nothing.

Three habits matter more than coverage numbers:

- **Assert the invariant, not the implementation.** The claim tests assert that exactly one caller wins a
  race and that no operation row is created on failure. They do not assert which SQL statement ran.
- **Test the failure path.** Most of the value in this codebase is in what it refuses to do. A change to
  a permission boundary needs a test showing the boundary holding.
- **Fix the right side.** When a test fails, decide whether the checker or the fixture is wrong before
  changing either. Never loosen a check to make evidence pass.

## Making a change

1. **Branch** from `main`.
2. **Write the test first** and watch it fail for the reason you expect.
3. **Implement** the smallest change that makes it pass.
4. **Run `npm run verify`.**
5. **Commit** in small, self-contained steps. Explain why in the message body, since the diff already
   shows what.
6. **Open a pull request** describing what changed, how you verified it, and anything you decided not to
   do.

### Style

Formatting is Prettier's job; do not hand-format. Linting is type-aware and strict on purpose: `any`
erases the guarantees the security model depends on, and floating promises lose errors.

If a rule genuinely should not apply, disable it inline at the one site that needs it, with a comment
explaining why. There are a handful of these in the codebase and each one has a reason next to it.
Please do not switch a rule off project-wide.

### Comments

Comment the decision, not the mechanics. `// increment i` earns nothing. The comments worth writing here
explain why the code is shaped a certain way, especially when the obvious alternative was tried and
rejected. The staging module's note about why the upload is buffered rather than streamed is the model to
follow.

## Changes that need extra care

Some parts of this codebase carry security invariants. Changes to them need a test that demonstrates the
invariant still holds:

- **`worker/src/approval/`** — attachments must come from the approved payload, never from a caller
  argument, and a pending action must be claimable exactly once.
- **`worker/src/operations/journal.ts`** — an idempotency key is bound to one action and one payload hash.
  Reuse with different content is a conflict, not a silent reuse of the old result.
- **`worker/src/policy/`** — modifiers may only raise a permission level, and account ownership is checked
  before any policy decision.
- **`worker/migrations/`** — ownership is enforced by composite foreign keys. Migrations are append-only:
  add a new numbered file rather than editing one that has been applied.

## Reporting problems

Bugs and feature requests belong in GitHub issues; the templates ask for what a maintainer needs.

Security vulnerabilities do not. Please follow [SECURITY.md](SECURITY.md) instead of opening a public
issue.

## Code of Conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
