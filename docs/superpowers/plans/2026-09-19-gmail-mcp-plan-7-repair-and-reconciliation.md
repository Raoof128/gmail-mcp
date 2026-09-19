# Gmail MCP Plan 7: Owner Repair and Documentation Reconciliation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the owner a way to repair charged save debt, finish the three documentation items the spec reconciliation left open, and either explain or quarantine the two intermittent test failures observed on 2026-09-19.

**Architecture:** Three independent strands. The repair strand adds a native journal-inspection and release path and the CLI command that drives it, because the code comments promise "owner repair" and no repair exists. The documentation strand finishes what the reconciliation of `8bfdd01` deliberately stopped short of. The flake strand treats two intermittent failures as findings rather than noise. Each strand is independently shippable; none depends on another.

**Tech Stack:** Swift 6.4 with the Darwin C shim and SQLite for the native helper, TypeScript on Node >= 22.18.0 for the companion CLI, Vitest 4.x for the TypeScript suites, `swift test` for the native suite. No new production dependency.

**Spec:** `docs/superpowers/specs/2026-09-09-gmail-mcp-design.md` (current architecture revision 2026-09-19). The gauntlet record `docs/superpowers/reviews/2026-09-17-full-project-gauntlet.md` is canonical for external gate classification.

## Global constraints

- Baseline `8bfdd018fcfa4efe127bc86dd2cd1577a2f7b60e`. Branch from `main`; commit in small steps; do not push or deploy unless the owner asks.
- `npm run verify` must exit 0 before any commit, and `swift build --package-path native -c release` plus `swift test --package-path native` must pass for any native change. Exit code 0 is the claim.
- Write the failing test first and watch it fail. A test that passes the moment it is written has proven nothing.
- Migrations are append-only. The native journal schema is owner data on a live machine: never drop or rewrite a table, and never delete a reservation whose receipt is not accounted for.
- Task 1 touches the crash-recovery state machine that invariants 27, 33, 35 and 36 rest on. Any predicate it changes owes a mutation-confirmed regression, not only a green suite. Neutralise the clause with `(x OR 1=1)` rather than deleting a bound parameter, and print the mutated region to confirm the edit landed where intended.
- Missing proof is `not_run`. A tested refusal path is not a satisfied external gate. Nothing in this plan closes any of the five gates in spec 4.8.
- Run the `stop-slop` skill over any prose this plan produces, before committing it.

## Sequence

Tasks 1 and 2 are the repair strand and must run in order. Tasks 3, 4 and 5 are documentation and can run at any time. Tasks 6 and 7 are the flake strand and are independent. Nothing here blocks anything else.

---

## File structure

| File                                                                  | Responsibility                                                                                                        |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `companion/native/Sources/NativeCore/SaveReceipts.swift`              | gains `unresolvedDebt()` and `releaseDebt(scope:handle:)`; owns the decision about which receipts a human may release |
| `companion/native/Sources/NativeHelper/main.swift`                    | routes two new operations, `debt.list` and `debt.release`, to the above                                               |
| `companion/native/Tests/NativeCoreTests/ReceiptTests.swift`           | tests for both, including the case that must refuse                                                                   |
| `companion/src/cli.ts`                                                | the `debt` and `debt --release <handle>` commands                                                                     |
| `companion/test/cli.test.ts`                                          | asserts the CLI prints debt and refuses an unknown handle                                                             |
| `docs/superpowers/specs/2026-09-09-gmail-mcp-design.md`               | sections 4.7 and 4.9, and the qualification detail in 4.8                                                             |
| `docs/superpowers/reviews/2026-09-19-spec-reconciliation-gauntlet.md` | the second gauntlet's record, appended to, never rewritten                                                            |

---

### Task 1: The native helper can report and release charged save debt

A failed save keeps its 25 MiB reservation until `recoverStartup` collects the temporary. When the
temporary is gone, `discardTemporary` returns false, `recover` marks the receipt
`publication_unknown`, and the reservation stays charged for ever. On 2026-09-19 one hand-deleted
temporary left `save:dfbf797b…` holding 26,214,400 bytes and every later save answered
`spool_budget`. The comments in `SafeFiles.swift` call the remedy "owner repair"; no repair exists.

**Files:**

- Modify: `companion/native/Sources/NativeCore/SaveReceipts.swift`
- Test: `companion/native/Tests/NativeCoreTests/ReceiptTests.swift`

**Interfaces:**

- Consumes: `Journal.entries(prefix:)`, `Journal.release(id:)`, `SaveReceipt`, `NativeError.refused`
- Produces:
  - `public struct DebtRow: Codable { public let scope: String; public let handle: String; public let state: String; public let root: String; public let relative: String; public let bytes: Int; public let temporaryPresent: Bool }`
  - `public func unresolvedDebt() throws -> [DebtRow]`
  - `public func releaseDebt(scope: String, handle: String) throws -> Bool`
  - in `Journal.swift`: `public func reservedBytes(id: String) throws -> Int?`, because
    `entries(prefix:)` selects only `scope, key, request_hash, payload` and carries no byte count;
    the charge lives in the separate `reservations` table keyed by `reservation(scope, handle)`,
    which is `"save:" + digest(scope + NUL + handle)` and is not invertible

- [ ] **Step 1: Write the failing test for listing debt**

```swift
func testUnresolvedDebtListsAChargedPublicationUnknownReceipt() throws {
  let h = harness()                                   // existing helper in ReceiptTests
  try h.saves.prepare(scope: "s", handle: "hA", root: "attachments", relative: "a.pdf")
  try h.markPublicationUnknown(scope: "s", handle: "hA")   // see Step 3 for why this exists
  let debt = try h.saves.unresolvedDebt()
  XCTAssertEqual(debt.count, 1)
  XCTAssertEqual(debt[0].handle, "hA")
  XCTAssertEqual(debt[0].state, "publication_unknown")
  XCTAssertFalse(debt[0].temporaryPresent)
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `swift test --package-path companion/native --filter ReceiptTests/testUnresolvedDebtLists`
Expected: FAIL, `value of type 'SaveReceipts' has no member 'unresolvedDebt'`

- [ ] **Step 3: Implement `unresolvedDebt`**

Read every `save:` journal entry, decode its `SaveReceipt`, and report the ones a human might need
to act on. `temporaryPresent` is what tells the owner whether the safe collector can still do the
job: when it is true the fix is to start the helper, and when it is false only a release can clear
the charge.

```swift
public struct DebtRow: Codable {
  public let scope: String, handle: String, state: String, root: String, relative: String
  public let bytes: Int, temporaryPresent: Bool
}

public func unresolvedDebt() throws -> [DebtRow] {
  var rows: [DebtRow] = []
  for item in try journal.entries(prefix: "save:") {
    let receipt = try JSONDecoder().decode(SaveReceipt.self, from: Data(item.record.payload.utf8))
    guard receipt.state != "acknowledged" else { continue }
    let scope = String(item.scope.dropFirst(5))
    let present = receipt.temporary.map { files.temporaryExists(root: receipt.root, path: $0) } ?? false
    // entries() carries no byte count; the charge is in the reservations table under the digest id.
    let bytes = try journal.reservedBytes(id: reservation(scope, item.key)) ?? 0
    rows.append(DebtRow(
      scope: scope, handle: item.key, state: receipt.state,
      root: receipt.root, relative: receipt.relative,
      bytes: bytes, temporaryPresent: present))
  }
  return rows
}
```

Add the existence probe beside `discardTemporary` in `SafeFiles.swift`, reusing its path validation
so it cannot be pointed at an arbitrary file:

```swift
public func temporaryExists(root id: String, path: String) -> Bool {
  guard let r = try? root(id, write: true) else { return false }
  let leaf = (path as NSString).lastPathComponent
  guard leaf.range(of: "^\\.gmail-mcp-[A-Fa-f0-9-]{36}$", options: .regularExpression) != nil
  else { return false }
  let fd = gm_open(r.fd, path, O_RDONLY | O_NONBLOCK, 0)
  if fd < 0 { return false }
  close(fd)
  return true
}
```

`markPublicationUnknown` in the test harness persists a receipt in that state directly, because the
production route to it needs a deleted temporary and the test must not delete files on the machine
running it.

- [ ] **Step 4: Run it and watch it pass**

Run: `swift test --package-path companion/native --filter ReceiptTests/testUnresolvedDebtLists`
Expected: PASS

- [ ] **Step 5: Write the failing test for releasing, and for refusing to release**

The refusal is the point of the task. A receipt whose temporary is still on disk must not be
released by hand, because the safe collector can still check its device and inode; releasing it
would drop the charge while leaving the file.

```swift
func testReleaseDebtClearsAChargeThatOnlyAHumanCanClear() throws {
  let h = harness()
  try h.saves.prepare(scope: "s", handle: "hB", root: "attachments", relative: "b.pdf")
  try h.markPublicationUnknown(scope: "s", handle: "hB")
  XCTAssertTrue(try h.saves.releaseDebt(scope: "s", handle: "hB"))
  XCTAssertTrue(try h.saves.unresolvedDebt().isEmpty)
}

func testReleaseDebtRefusesWhileTheTemporaryIsStillCollectable() throws {
  let h = harness()
  try h.saves.prepare(scope: "s", handle: "hC", root: "attachments", relative: "c.pdf")
  try h.createTemporary(scope: "s", handle: "hC")     // leaves the .gmail-mcp- file in place
  XCTAssertThrowsError(try h.saves.releaseDebt(scope: "s", handle: "hC")) { error in
    // NativeError is `enum { refused(String), system(String, Int32) }` and has no `.reason`.
    guard case NativeError.refused(let reason) = error else { return XCTFail("wrong error: \(error)") }
    XCTAssertEqual(reason, "temporary_still_present")
  }
}
```

- [ ] **Step 6: Run both and watch them fail**

Run: `swift test --package-path companion/native --filter ReceiptTests/testReleaseDebt`
Expected: FAIL, no member `releaseDebt`

- [ ] **Step 7: Implement `releaseDebt`**

```swift
public func releaseDebt(scope: String, handle: String) throws -> Bool {
  guard let row = try journal.get(scope: "save:" + scope, key: handle) else { return false }
  let receipt = try JSONDecoder().decode(SaveReceipt.self, from: Data(row.payload.utf8))
  if let temp = receipt.temporary, files.temporaryExists(root: receipt.root, path: temp) {
    // The collector can still verify device and inode. A human release here would drop the
    // charge and leave the file, which is the one outcome nothing else in this design permits.
    throw NativeError.refused("temporary_still_present")
  }
  try journal.release(id: reservation(scope, handle))
  return true
}
```

- [ ] **Step 8: Run the whole native suite**

Run: `swift test --package-path companion/native`
Expected: PASS, including the existing crash, race and restart tests

- [ ] **Step 9: Mutation-confirm the refusal**

Change the guard to `if false, let temp = receipt.temporary, ...` and print the mutated lines to
confirm the edit landed in `releaseDebt` and nowhere else. Re-run
`swift test --package-path companion/native --filter ReceiptTests/testReleaseDebtRefuses`.
Expected: that test FAILS. Restore the guard and confirm it passes again. A refusal nothing can
break is a refusal nothing was testing.

- [ ] **Step 10: Commit**

```bash
git add companion/native/Sources companion/native/Tests
git commit -m "feat(native): let the owner see and release charged save debt

A save that lost the exclusive rename keeps its reservation until
recoverStartup collects the temporary. When the temporary is gone the
collector cannot verify what it is removing, the receipt becomes
publication_unknown, and the charge stays for ever: one hand-deleted file
left 26,214,400 bytes held and every later save answered spool_budget. The
comments called the remedy owner repair and there was none.

releaseDebt refuses while the temporary is still on disk, because the safe
collector can still check its device and inode there, and a human release
would drop the charge and leave the file."
```

---

### Task 2: `gmail-mcp-companion debt` exposes the repair to the owner

The native side is useless to the owner until the CLI drives it. This is also the command a future
reader will reach for when a save answers `spool_budget`, so its output has to explain the state
rather than print a row.

**Files:**

- Modify: `companion/src/cli.ts`
- Modify: `companion/native/Sources/NativeHelper/main.swift`
- Test: `companion/test/cli.test.ts`

**Interfaces:**

- Consumes: `unresolvedDebt()` and `releaseDebt(scope:handle:)` from Task 1; `NativeProcess.call`
- Produces: helper operations `{ op: "debt" }` returning `{ meta: { rows: DebtRow[] } }` and
  `{ op: "debt.release", scope, handle }` returning `{ meta: { released: Bool } }`

- [ ] **Step 1: Write the failing test**

`test/cli.test.ts` has no `runCli` or `fakeNative`: it spawns the real CLI with `spawn(process.execPath,
[cli, "serve"])` and speaks frames over stdio. Follow that pattern rather than inventing a harness,
which means the native binary must be built first (`npm run build:native`). Test the two things that
do not need real debt to exist: the command runs, and an unknown handle is refused rather than
reported as released.

```ts
it("debt runs against the real helper and refuses an unknown handle", async () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const list = spawnSync(process.execPath, [cli, "debt"], { encoding: "utf8" });
  expect(list.status).toBe(0);
  // Either there is no debt on this machine, or every row names its remedy.
  expect(list.stdout).toMatch(/No charged save debt\.|--release /);

  const bogus = spawnSync(process.execPath, [cli, "debt", "--release", "nosuchhandle"], { encoding: "utf8" });
  expect(bogus.stdout).toContain("No such handle.");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd companion && npx vitest run test/cli.test.ts -t "prints charged debt"`
Expected: FAIL, unknown command `debt`

- [ ] **Step 3: Route the two operations in the helper**

In `main.swift`, beside the existing `save.*` cases:

The helper answers with `try reply(try json(value))`; there is no `Response` type. `Command`
already declares optional `scope` and `handle`, so no new fields are needed.

```swift
case "debt":
  struct DebtReply: Encodable { let rows: [SaveReceipts.DebtRow] }
  try reply(try json(DebtReply(rows: try saves.unresolvedDebt())))
case "debt.release":
  struct ReleaseReply: Encodable { let released: Bool }
  try reply(try json(ReleaseReply(released: try saves.releaseDebt(
    scope: required(command.scope), handle: required(command.handle)))))
```

- [ ] **Step 4: Add the CLI command**

```ts
if (command === "debt") {
  const { values } = parseArgs({ args: process.argv.slice(3), options: { release: { type: "string" } } });
  const native = new NativeProcess();
  try {
    if (values.release) {
      const out = await native.call({ op: "debt.release", scope: "default", handle: values.release });
      process.stdout.write(out.meta.released ? "Released.\n" : "No such handle.\n");
      return;
    }
    const rows = (await native.call({ op: "debt" })).meta.rows as DebtRow[];
    if (rows.length === 0) {
      process.stdout.write("No charged save debt.\n");
      return;
    }
    for (const r of rows) {
      const remedy = r.temporaryPresent
        ? "start the companion; the helper collects this on startup"
        : `run: gmail-mcp-companion debt --release ${r.handle}`;
      process.stdout.write(`${r.handle}  ${r.state}  ${r.bytes} bytes  ${r.root}/${r.relative}\n  ${remedy}\n`);
    }
  } finally {
    native.close();
  }
  return;
}
```

Add `debt` to the usage string in the `catch` at the bottom of `main()`.

- [ ] **Step 5: Run the test and watch it pass**

Run: `cd companion && npx vitest run test/cli.test.ts`
Expected: PASS

- [ ] **Step 6: Repair the live machine and record the result**

This plan was written on a machine holding real debt. Confirm the command reads it:

Run: `node companion/src/cli.ts debt`
Expected: one row, 26,214,400 bytes, state `publication_unknown`, `temporaryPresent` false, remedy
`--release <handle>`.

Take the handle from that output. Do **not** use
`dfbf797b5fb1ce98630b409df9817790415c5cfbef7d1a2449f7d0de78fb042e`, which is what
`sqlite3 journal.sqlite "SELECT id FROM reservations"` prints: that is the reservation id,
`"save:" + digest(scope + NUL + handle)`, and the digest cannot be inverted to a handle. The handle
is the journal record's key, which is why `unresolvedDebt` reports both.

Run: `node companion/src/cli.ts debt --release <handle from the listing>`
Expected: `Released.` Then prove the repair end to end, because `Released.` is a claim and the
saving is the evidence: run a `save_attachment` to a path that does not exist yet and expect a
published receipt rather than `spool_budget`.

- [ ] **Step 7: Run the gate and commit**

```bash
npm run verify
git add companion/src companion/test companion/native/Sources
git commit -m "feat(companion): a debt command, because spool_budget needs a way out

When a save answers spool_budget the owner has no way to see what is
charged or clear it. debt lists every unresolved receipt with the remedy
that fits it: a restart when the helper can still collect the temporary
safely, a release when it cannot."
```

---

### Task 3: Section 4.8 documents the qualification architecture, not only its gates

The reconciliation added the five external gates and stopped, because describing RunIdentity,
evidence-graph integrity and qualification epochs from memory would have been fiction. Read the
source first, then write only what it says.

**Files:**

- Read: `scripts/qualification/` in full, and `worker/src/build-identity.ts`
- Modify: `docs/superpowers/specs/2026-09-09-gmail-mcp-design.md`, section 4.8

- [ ] **Step 1: Read the qualification source and list what exists**

Run: `ls scripts/qualification && grep -rn "identitySha256\|RunIdentity\|epoch" scripts/qualification | head -40`

Write down, in the plan's execution record, the actual names: the identity a run binds, the field an
observation carries, how evidence is verified, and what an epoch changes. Do not proceed on memory.

- [ ] **Step 2: Extend 4.8 with what you found**

Cover, and only if the source supports each one: how a build identity is derived and what it hashes;
what `identitySha256` binds an observation to; how the evidence graph is checked before release; what
a qualification epoch is and what replacing one does to work already in flight; and which components
must have evidence for release to be possible.

- [ ] **Step 3: Check every claim against a file**

For each sentence, name the file and symbol that makes it true. Delete any sentence you cannot
anchor. A design document that describes machinery nobody can find is worse than one that is silent.

- [ ] **Step 4: Run stop-slop, then the gate, then commit**

```bash
npm run verify
git add docs/superpowers/specs/2026-09-09-gmail-mcp-design.md
git commit -m "docs(spec): describe the qualification architecture from source"
```

---

### Task 4: The testing matrix describes the gauntlet, not the pre-implementation plan

Section 4.7 predates the gauntlet and reads like a list of intentions. It should say how the system
is actually verified and point at the canonical evidence, without scattering test counts that go
stale the next time anyone adds a test.

**Files:**

- Modify: `docs/superpowers/specs/2026-09-09-gmail-mcp-design.md`, section 4.7

- [ ] **Step 1: Rewrite 4.7 around method rather than inventory**

Name the four suites and what each one runs against: the Worker suite inside workerd with real D1,
R2 and KV emulation; the shared package under Node; the companion suite; the native Swift suite.
State the three rules the gauntlet converged on, which are already in CLAUDE.md and are the useful
part: an assertion must not be vacuous, the named guard must actually be reached, and a mutation
must have changed the region intended.

- [ ] **Step 2: Replace counts with a pointer**

Delete any fixed test count. Say that `npm run verify` is the gate and that
`docs/superpowers/reviews/2026-09-17-full-project-gauntlet.md` holds the invariant matrix, the
load-bearing predicate table and the findings.

- [ ] **Step 3: Keep the four things the matrix got right**

The 25 MiB round trips stay as functional exercises with their 4.8 caveat. The fake-Gmail adapter,
the elicitation resume and the media/resumable boundary at 5 MB stay, because each names a real
case. Do not lose them in the rewrite.

- [ ] **Step 4: Run stop-slop, then the gate, then commit**

```bash
npm run verify
git add docs/superpowers/specs/2026-09-09-gmail-mcp-design.md
git commit -m "docs(spec): 4.7 describes how the system is verified now"
```

---

### Task 5: A second gauntlet over the reconciled document

Step 9 of the review that prompted the reconciliation. The first gauntlet audited the
implementation; this one audits the document that now claims to describe it. It runs after Tasks 3
and 4, because auditing a section that is about to be rewritten wastes the pass.

**Files:**

- Create: `docs/superpowers/reviews/2026-09-19-spec-reconciliation-gauntlet.md`

- [ ] **Step 1: Take the baseline**

Record the commit, the output of `npm run verify`, and the spec's current revision line. A gauntlet
without a baseline cannot tell a finding from a change made during the run.

- [ ] **Step 2: Sweep every normative claim in the spec against source or a live probe**

For each claim, record the file and symbol, or the probe and its output, or `not_verified` with the
reason. The 2026-09-19 pass verified six claims this way: the `search_threads` ceiling of 50, the
998-byte subject cap, the 500-recipient cap, malformed addresses refused before policy, the label
tools refusing TRASH, and `+overwrite` having no emitter. Extend that, do not repeat it.

- [ ] **Step 3: Check the document against itself**

The first reconciliation existed because sections contradicted each other: OAuth state in KV in one
place and D1 in another, a journal heading denied three lines later, two definitions of
`requestState`. Look for the same shape again, in the sections the reconciliation did not touch.

- [ ] **Step 4: Classify every finding before looking at the answer**

Stop-ship, medium or precision, with the expected terminal state written before the check runs, as
the first gauntlet did for its external gates. A finding classified after the result is a finding
shaped by it.

- [ ] **Step 5: Append the record and commit**

Append to the new review file; never rewrite an earlier review. Run stop-slop over it.

```bash
git add docs/superpowers/reviews/2026-09-19-spec-reconciliation-gauntlet.md
git commit -m "docs(review): second gauntlet over the reconciled architecture"
```

---

### Task 6: The companion CLI test races the CLI's own startup

Reproduced and captured while this plan was being gauntleted, on the eighth full-suite run:

```
FAIL test/cli.test.ts > launches the CLI directly in Node and lists tools without accessing credentials
AssertionError: expected false to be true
 ❯ test/cli.test.ts:25:56
    await expect.poll(() => stdout.includes('"id":1')).toBe(true);
Caused by: Error: Matcher did not succeed in time.
```

The earlier guess in CLAUDE.md, that host state from `init` and `login` had leaked in, is wrong and
the capture is what kills it: the failure is the **first** poll, waiting for the `initialize` reply,
in a test whose own name says it runs without accessing credentials. Nothing has read a config by
then. What the test actually does is spawn `node src/cli.ts serve`, which makes Node type-strip
`cli.ts` and everything it imports on every run, then wait on `expect.poll`'s default budget of one
second. Under a parallel suite that budget is not reliably enough for a cold Node start plus type
stripping. The test is timing the machine, not the CLI.

**Files:**

- Modify: `companion/test/cli.test.ts`

- [ ] **Step 1: Confirm the mechanism before changing anything**

Measure how long the spawn actually takes, alone and under load, so the fix is sized by a number
rather than by taste:

```bash
cd companion
for i in 1 2 3; do /usr/bin/time -p node src/cli.ts serve </dev/null >/dev/null 2>&1; done
npx vitest run 2>&1 | grep -E "cli.test|Duration"
```

Expected: a cold start in the hundreds of milliseconds, close enough to one second under load to
explain an occasional miss. If it is nowhere near, this diagnosis is wrong; record that in the
execution record and stop rather than applying the fix below.

- [ ] **Step 2: Give both polls a budget that reflects a process start**

Both polls need it, not only the one that failed; the second is merely luckier.

```ts
await expect.poll(() => stdout.includes('"id":1'), { timeout: 15_000, interval: 50 }).toBe(true);
...
await expect.poll(() => stdout.includes('"id":2'), { timeout: 15_000, interval: 50 }).toBe(true);
```

This is not loosening a check. The assertion is unchanged, and a reply that never arrives still
fails; what changes is that the test stops asserting a deadline it was never trying to measure. If
the CLI genuinely hangs, fifteen seconds still catches it.

- [ ] **Step 3: Make the failure diagnosable when it does fail**

The capture above cost eight runs because the assertion prints `expected false to be true` and
discards everything the child said. Include it:

```ts
await expect
  .poll(() => stdout.includes('"id":1'), { timeout: 15_000, interval: 50 })
  .toBe(true)
  .catch(() => {
    throw new Error(`no initialize reply.\nstdout: ${stdout}\nstderr: ${stderr}`);
  });
```

- [ ] **Step 4: Run the loop**

Run: `cd companion && for i in $(seq 1 40); do npx vitest run 2>&1 | grep -q "[0-9] failed" && echo "FAIL $i"; done`
Expected: forty clean runs. Anything else means the timeout was not the cause, and the execution
record says so rather than the timeout being raised again.

- [ ] **Step 5: Commit**

```bash
npm run verify
git add companion/test/cli.test.ts
git commit -m "test(companion): stop timing a cold Node start with a one-second poll"
```

### Task 7: Decide what the recovery-suite timeouts are

Two recovery tests failed on timeouts at 18.5s and 29.2s during a run in which only markdown had
changed, and a re-run was clean. CLAUDE.md already records that contention, not regression, is the
usual cause, and that anything above about 600ms locally deserves a look. The question this task
answers is whether these two are contention or are genuinely close to their ceiling.

**Files:**

- Read: `worker/test/recovery-barrier-ladder.test.ts`, `worker/test/recovery-transport-matrix.test.ts`

- [ ] **Step 1: Measure them alone**

Run: `cd worker && npx vitest run test/recovery-barrier-ladder.test.ts test/recovery-transport-matrix.test.ts --reporter=verbose`
Record the per-test durations.

- [ ] **Step 2: Measure them under the full suite**

Run: `cd worker && npx vitest run --reporter=verbose 2>&1 | grep -E "recovery-(barrier|transport)"`
Record the same durations under load and compute the ratio.

- [ ] **Step 3: Decide, and write the decision down**

If the alone-to-loaded ratio is in the six-to-nine range CLAUDE.md already documents for CI, this is
contention and the finding is closed with the measurement. If a test is near its ceiling even alone,
cut its cost the way the settlement sweep was cut: hoist the expensive setup out of the loop first,
and only then consider a timeout, with the real reason written next to it.

Do not raise a timeout to make a run green. That converts a measurement into a wish.

- [ ] **Step 4: Commit the measurement**

```bash
git add worker/test CLAUDE.md
git commit -m "test(recovery): measure the two slow files and record the verdict"
```

---

## Self-review

**Spec coverage.** Tasks 3, 4 and 5 close the three documentation items the reconciliation left
open: the qualification architecture in 4.8, the testing matrix in 4.7, and the second gauntlet.
Tasks 1 and 2 close the repair gap the code comments promise and do not provide. Tasks 6 and 7 close
the two intermittents. Nothing here touches the five external gates in 4.8, and nothing should.

**Placeholders.** Every code step carries the code. Task 3 deliberately carries no prose: its first
step is to read the source, because writing that section from memory is how the document became a
palimpsest in the first place.

**Type consistency.** `DebtRow` has the same seven fields in the Swift definition, the Swift test,
the helper response and the TypeScript consumer. `releaseDebt` returns `Bool` in Swift and is read
as `meta.released` in the CLI. `temporaryExists(root:path:)` is named identically at its definition
in `SafeFiles.swift` and both call sites in `SaveReceipts.swift`.

**Self-gauntlet, run before anyone executed this.** Nine assumptions in the first draft were
checked against source. Four held: `new NativeProcess()` defaults to no `--init`, `Command` already
declares optional `scope` and `handle`, `journal.entries(prefix:)` yields `(scope, key, record)`
with the payload the receipt decodes from, and `reservation(scope, handle)` is reachable inside
`SaveReceipts`. Five were wrong and are corrected above:

| Defect                            | What the source says                                                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `item.record.bytes`               | `entries()` selects `scope, key, request_hash, payload` only; the charge lives in the `reservations` table, so `Journal.reservedBytes(id:)` had to be added to the interface |
| `(error as? NativeError)?.reason` | `NativeError` is `enum { refused(String), system(String, Int32) }` with no properties; the test must pattern-match                                                           |
| `--release dfbf797b…`             | that is the reservation id, `"save:" + digest(scope + NUL + handle)`, and is not invertible; the release takes the handle, which is the journal key                          |
| `runCli` / `fakeNative`           | neither exists in `test/cli.test.ts`, which spawns the real CLI over stdio                                                                                                   |
| `Response(meta:)`                 | the helper answers with `reply(try json(value))`                                                                                                                             |

Every one of those would have stopped the engineer at the first compile. They are recorded rather
than quietly fixed, because the rate matters: five of nine inferred APIs were wrong, so any future
plan step that was not read out of the source should be treated as a guess until it is.

**Known weakness.** Task 1 assumes `ReceiptTests` has a harness with `markPublicationUnknown` and
`createTemporary`. It does not yet. Whoever executes Task 1 writes them first, as part of Step 1,
and if the existing harness shape makes that awkward the test setup is the thing to change, not the
assertion.
