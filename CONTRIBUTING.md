# Contributing

Thank you for considering a contribution. This covers the development loop, how the project thinks about
tests, and what makes a change easy to review.

## Getting set up

You need Node 20 or newer. The repository is an npm workspace with two packages. `shared` holds the
contracts, `worker` holds the Cloudflare Worker.

```bash
npm install
npm run verify
```

`npm run verify` runs formatting, linting, type checking and the tests, in that order. CI runs the same
thing. Green locally means green in CI.

For a faster loop, run the gates one at a time:

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
R2 and KV emulation. Nothing in the storage layer is mocked, so a passing test means the SQL, the
transactions and the constraints work.

## How this project tests

Write the test first and watch it fail before you write the code. This is not ceremony. Several real
defects here were caught only because someone watched a test fail for the right reason first, and a test
that passes the moment you write it has proven nothing.

Three habits matter more than a coverage number.

Assert the invariant rather than the implementation. The claim tests assert that one caller wins a race
and that no operation row survives a failure. They say nothing about which SQL statement ran.

Test the failure path. Most of the value in this codebase is in what it refuses to do, so a change to a
permission boundary needs a test showing the boundary hold.

Decide which side is wrong before you change either one. When a test fails, work out whether the checker
or the fixture is at fault. Never loosen a check to make evidence pass.

## Making a change

1. Branch from `main`.
2. Write the test and watch it fail for the reason you expect.
3. Write the smallest change that makes it pass.
4. Run `npm run verify`.
5. Commit in small steps. Explain why in the message body, since the diff already shows what.
6. Open a pull request saying what changed, how you verified it, and what you left undone.

### Style

Prettier handles formatting, so do not hand-format anything. Linting is type-aware and strict on purpose:
`any` erases the guarantees the security model depends on, and a floating promise loses its errors.

When a rule truly should not apply, disable it inline at the one line that needs it and write the reason
next to it. The codebase has a handful of these and each one explains itself. Please do not switch a rule
off across the project.

### Comments

Comment the decision rather than the mechanics. `// increment i` earns nothing. The comments worth
writing explain why the code has the shape it has, and they are most useful when the obvious alternative
was tried and rejected. The note in the staging module about why the upload is buffered rather than
streamed is the model to follow.

## Changes that need extra care

Four areas carry security invariants. A change to any of them needs a test demonstrating the invariant
still holds.

In `worker/src/approval/`, attachments must come from the approved payload rather than a caller argument,
and a pending action must be claimable once.

In `worker/src/operations/journal.ts`, an idempotency key binds to one action and one payload hash.
Reusing a key with different content is a conflict, and never a quiet replay of the old result.

In `worker/src/policy/`, modifiers may only raise a permission level, and account ownership is checked
before any policy decision.

In `worker/migrations/`, ownership is enforced by composite foreign keys. Migrations are append-only, so
add a new numbered file rather than editing one that has already been applied.

## Reporting problems

Bugs and feature requests belong in GitHub issues, and the templates ask for what a maintainer needs.

Security vulnerabilities do not. Follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Code of Conduct

The [Code of Conduct](CODE_OF_CONDUCT.md) governs participation.
