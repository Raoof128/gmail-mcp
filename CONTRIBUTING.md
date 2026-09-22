# Contributing

Thank you for considering a contribution. This covers the development loop, how the project thinks about
tests, and what makes a change easy to review.

## Getting set up

You need Node 22.18 or newer, which the root `engines` field pins. The repository is an npm workspace
with four packages: `shared` holds the contracts, `worker` holds the Cloudflare Worker, `companion` holds
the local stdio client and its Swift helper, and `scripts/qualification` holds the release-evidence
tooling.

```bash
npm install
npm run verify
```

There are two gates and they are not the same gate.

`npm run verify` runs formatting, linting, type checking and the TypeScript suites across all four
workspaces, in that order. CI runs exactly this, so green locally means green in CI. It does **not**
compile or test Swift.

`npm run verify:native` is the other half: `swift test --package-path companion/native` followed by a
release build. It needs macOS 26.6 or newer and Xcode command-line tools, so CI does not run it. Any
change under `companion/native/` owes both gates before it is committed.

For a faster loop, run the gates one at a time:

```bash
npm run format        # rewrite files to the project style
npm run lint          # eslint, type-aware
npm run typecheck     # regenerates Worker types, then tsc
npm test              # the TypeScript tests in all four workspaces
```

To run a single test file:

```bash
cd worker && npx vitest run test/claim.test.ts
```

Or a single native test case:

```bash
swift test --package-path companion/native --filter ReceiptTests
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

### Two rules the project audit converged on

Both came out of finding tests that were green for the wrong reason, and both are cheap to apply.

**Reachability.** A passing assertion proves nothing if the guard it was written around never ran. A loop
over an empty result set passes without executing one assertion, and `expect(x === "a" || x.length > 0)`
is true for every input. Assert the counter, the non-empty result, or the barrier arrival before
asserting what followed. Some guards are reachable only in one ordering: the download acknowledgement's
reservation predicate never runs unless the handle is read before it is reserved.

**Mutation identity.** A surviving mutation is evidence only once you have confirmed the mutation landed
where you aimed it. A first-occurrence `replace` hits the first match in the file, which twice here was
not the one intended. Print the changed region before believing a null result. Neutralise a clause with
`(x OR 1=1)` rather than deleting a bound parameter, because changing the bind count breaks the statement
and every test then fails for the wrong reason.

## Making a change

1. Branch from `main`.
2. Write the test and watch it fail for the reason you expect.
3. Write the smallest change that makes it pass.
4. Run `npm run verify`, and `npm run verify:native` too if the change touches `companion/native/`.
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

The project keeps a set of security invariants, each with a test behind it.
[The design spec](docs/superpowers/specs/2026-09-09-gmail-mcp-design.md) holds the reasoning and is
authoritative, and
[the full-project gauntlet](docs/superpowers/reviews/2026-09-17-full-project-gauntlet.md) records the
invariant matrix with the proof type behind each one. A change near any of them must leave its test
demonstrating it, or amend the invariant deliberately and say so in the commit message.

Four areas concentrate them, and a change to any of these needs a test demonstrating the invariant still
holds.

In `worker/src/approval/`, attachments must come from the approved payload rather than a caller argument,
and a pending action must be claimable once.

In `worker/src/operations/journal.ts`, an idempotency key binds to one action and one payload hash.
Reusing a key with different content is a conflict, and never a quiet replay of the old result.

In `worker/src/policy/`, modifiers may only raise a permission level, and account ownership is checked
before any policy decision.

In `worker/migrations/`, ownership is enforced by composite foreign keys. Migrations are append-only, so
add a new numbered file rather than editing one that has already been applied.

A fifth area sits outside the Worker. In `companion/native/`, the save receipt state machine decides
whether a transfer is retryable or permanently unknown, and the exclusive rename is what stops a transfer
overwriting a file it cannot account for. Changes there owe `npm run verify:native` and, where they touch
a predicate, a mutation-confirmed regression rather than only a green suite.

## Reporting problems

Bugs and feature requests belong in GitHub issues, and the templates ask for what a maintainer needs.

Security vulnerabilities do not. Follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Code of Conduct

The [Code of Conduct](CODE_OF_CONDUCT.md) governs participation.
