# Gmail MCP Plan 7: Owner Repair and Documentation Reconciliation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the owner a way to repair charged save debt, finish the three documentation items the spec reconciliation left open, and either explain or quarantine the two intermittent test failures observed on 2026-09-19.

**Architecture:** Three strands. The repair strand adds a native journal-inspection and release path, the CLI that drives it, and one owner-authorized run against the live machine, because the code comments promise "owner repair" and no repair exists. The documentation strand finishes what the reconciliation of `8bfdd01` deliberately stopped short of. The flake strand treats two intermittent failures as findings rather than noise.

**Tech Stack:** Swift 6.4 with the Darwin C shim and SQLite for the native helper, TypeScript on Node >= 22.18.0 for the companion CLI, Vitest 4.x for the TypeScript suites, `swift test` for the native suite. No new production dependency.

**Spec:** `docs/superpowers/specs/2026-09-09-gmail-mcp-design.md` (current architecture revision 2026-09-19). The gauntlet record `docs/superpowers/reviews/2026-09-17-full-project-gauntlet.md` is canonical for external gate classification.

**Revision 2, 2026-09-19.** Revision 1 was gauntleted twice: once by the author before anyone read it, and once by an external reviewer who found nine stop-ships in it. The defect ledger at the end of this document records both passes, including the two reviewer remedies that source proved wrong and the four defects neither pass found until the live journal was read.

## Global constraints

- Baseline `f212652`. Branch from `main`; commit in small steps; do not push or deploy unless the owner asks.
- Two gates, and they are not the same gate. `npm run verify` runs format, lint, typecheck and the TypeScript suites across every workspace; it does **not** compile or test Swift. `npm run verify:native` runs `swift test --package-path companion/native` followed by `swift build --package-path companion/native -c release`. Any task touching Swift owes both. Each task below names the ones it owes immediately before its commit, because a constraint fifty minutes up the page is a constraint nobody re-reads.
- Exit code 0 is the claim. Read the output.
- Write the failing test first and watch it fail. A test that passes the moment it is written has proven nothing.
- Migrations are append-only. The native journal is owner data on a live machine: never drop or rewrite a table, and never delete a reservation whose receipt is not accounted for.
- Tasks 1 to 3 touch the crash-recovery state machine that invariants 27, 33, 35 and 36 rest on. Any predicate they change owes a mutation-confirmed regression, not only a green suite. Neutralise the clause with `(x OR 1=1)` rather than deleting a bound parameter, and print the mutated region to confirm the edit landed where intended.
- Missing proof is `not_run`. A tested refusal path is not a satisfied external gate. Nothing in this plan closes any of the five gates in spec 4.8.
- Run the `stop-slop` skill over any prose this plan produces, before committing it.

## Sequence

```
Task 1 -> Task 2 -> Task 3        repair; Task 3 needs separate owner authorization
Task 4 -> Task 5 -> Task 6        documentation; 4 and 5 edit the same file, so they serialise
Task 7                            independent
Task 8                            independent
```

Revision 1 claimed the documentation tasks could run in any order and then said in Task 6 that it runs after the other two. Tasks 4 and 5 edit neighbouring sections of one file, so a subagent fan-out across them collides. Run them in order.

---

## File structure

| File                                                                  | Responsibility                                                                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `companion/native/Sources/NativeCore/SafeFiles.swift`                 | gains `TemporaryPresence` and `temporaryPresence(root:path:)`, the probe that only ENOENT may answer `absent`                |
| `companion/native/Sources/NativeCore/Journal.swift`                   | gains `reservedBytes(id:)`, because `entries(prefix:)` carries no byte count                                                 |
| `companion/native/Sources/NativeCore/SaveReceipts.swift`              | gains `DebtRow`, `DebtRelease`, `unresolvedDebt()` and `releaseDebt(scope:handle:)`; owns which receipts a human may release |
| `companion/native/Sources/NativeHelper/main.swift`                    | routes `debt.list` and `debt.release`                                                                                        |
| `companion/native/Tests/NativeCoreTests/ReceiptTests.swift`           | the listing, the release, and the three refusals                                                                             |
| `companion/src/cli.ts`                                                | `debt` and `debt --scope <scope> --release <handle>`                                                                         |
| `companion/test/cli.test.ts`                                          | the CLI integration check, and the poll budgets in Task 7                                                                    |
| `docs/superpowers/specs/2026-09-09-gmail-mcp-design.md`               | sections 4.7 and the qualification detail in 4.8                                                                             |
| `docs/superpowers/reviews/2026-09-19-spec-reconciliation-gauntlet.md` | the second gauntlet's record, appended to, never rewritten                                                                   |

---

### Task 1: The native helper can report and release charged save debt

A save that loses the exclusive rename keeps its 25 MiB reservation until `recoverStartup` collects
the temporary. Delete that temporary by hand and the collector can no longer check the device and
inode it recorded, so `discardTemporary` returns false, `recover` marks the receipt
`publication_unknown`, and the charge stays for ever. Every later save then answers `spool_budget`.
The comments in `SafeFiles.swift` call the remedy "owner repair"; no repair exists.

**Files:**

- Modify: `companion/native/Sources/NativeCore/SafeFiles.swift`
- Modify: `companion/native/Sources/NativeCore/Journal.swift`
- Modify: `companion/native/Sources/NativeCore/SaveReceipts.swift`
- Test: `companion/native/Tests/NativeCoreTests/ReceiptTests.swift`

**Interfaces:**

- Consumes: `Journal.entries(prefix:)`, `Journal.get(scope:key:)`, `Journal.release(id:)`,
  `SaveReceipt`, `NativeError.refused`, `SafeFiles.maximum`, and the private `reservation(_:_:)`
  and `validated(_:)` helpers, both reachable from their own file.
- Produces, all at file scope beside `SaveReceipt` rather than nested in a type:
  - `public enum TemporaryPresence: String, Codable, Sendable { case present, absent, unknown }`
  - `public func temporaryPresence(root id: String, path: String) -> TemporaryPresence` on `SafeFiles`
  - `public func reservedBytes(id: String) throws -> Int?` on `Journal`
  - `public struct DebtRow: Codable, Sendable` with `scope, handle, state, root, relative: String`,
    `bytes: Int`, `temporary: String`, `releasable: Bool`
  - `public enum DebtRelease: String, Codable, Sendable { case released, noSuchReceipt, notCharged }`
  - `public func unresolvedDebt() throws -> [DebtRow]`
  - `public func releaseDebt(scope: String, handle: String) throws -> DebtRelease`

**Two definitions this task turns on.** _Charged debt_ is a save receipt short of `acknowledged`
that still holds bytes in the `reservations` table. A receipt with no charge is history, not debt,
and `unresolvedDebt` does not list it. _Releasable_ is narrower still: state exactly
`publication_unknown`, and the temporary provably gone. Nothing else. Revision 1 conflated the two
and could not satisfy its own test, because releasing a charge leaves the receipt exactly where it
was and the listing kept returning it.

**And the release repairs accounting only.** The receipt goes on saying `publication_unknown`
afterwards, because nothing in this path learned what happened at the destination. Rewriting the
state would convert an honest unknown into a claim, which is the failure invariant 35 exists to
prevent.

- [x] **Step 1: Write the failing test for listing charged debt**

Revision 1 assumed a `harness()` with `markPublicationUnknown` and `createTemporary`, and admitted
in its own self-review that neither exists. They are not needed. `FileTests().fixture` is the
existing pattern, and the production route to a charged `publication_unknown` receipt is
reproducible with nothing but an occupied destination and one `removeItem`. Reproduce the defect;
do not simulate it.

```swift
func testUnresolvedDebtListsTheChargeAHandDeletedTemporaryLeaves() throws {
  try FileTests().fixture { files, root, priv in
    let journal = try Journal(path: priv.appendingPathComponent("debt.db").path)
    let saves = SaveReceipts(files: files, journal: journal)
    let bytes = Data("payload".utf8)

    // An occupied destination refuses the exclusive rename and leaves the temporary behind.
    try Data("occupied".utf8).write(to: root.appendingPathComponent("a.txt"))
    XCTAssertThrowsError(
      try saves.publish(
        scope: "s", handle: "h", root: "attachments", relative: "a.txt", bytes: bytes,
        sha256: SafeFiles.digest(bytes)))

    // The act that makes the debt permanent: tidying the temporary away by hand.
    let temp = try XCTUnwrap(
      FileManager.default.contentsOfDirectory(atPath: root.path).first {
        $0.hasPrefix(".gmail-mcp-")
      })
    try FileManager.default.removeItem(at: root.appendingPathComponent(temp))
    XCTAssertThrowsError(
      try saves.recover(scope: "s", handle: "h", root: "attachments", relative: "a.txt"))

    let debt = try saves.unresolvedDebt()
    XCTAssertEqual(debt.count, 1)
    XCTAssertEqual(debt[0].scope, "s")
    XCTAssertEqual(debt[0].handle, "h")
    XCTAssertEqual(debt[0].state, "publication_unknown")
    XCTAssertEqual(debt[0].bytes, SafeFiles.maximum)
    XCTAssertEqual(debt[0].temporary, "absent")
    XCTAssertTrue(debt[0].releasable)
  }
}
```

- [x] **Step 2: Run it and watch it fail**

Run: `swift test --package-path companion/native --filter ReceiptTests/testUnresolvedDebt`
Expected: FAIL, `value of type 'SaveReceipts' has no member 'unresolvedDebt'`

- [x] **Step 3: Add the presence probe to `SafeFiles.swift`**

`discardTemporary` already separates ENOENT from every other open failure, and this probe reuses
that shape rather than approximating it. Do not require `path == leaf`: `prepare` builds temporaries
inside the destination's parent directory, so a temporary legitimately carries a path. Validate the
parent with `validated`, exactly as `discardTemporary` does.

```swift
public enum TemporaryPresence: String, Codable, Sendable {
  case present, absent, unknown
}
```

```swift
/// Only ENOENT establishes absence. A permission error, a lost root, an I/O error and an
/// unparseable path are all `unknown`, because releaseDebt reads `absent` as permission to drop a
/// charge and must never be handed a guess. Failing open here would make every unreadable
/// temporary look collected.
public func temporaryPresence(root id: String, path: String) -> TemporaryPresence {
  guard let r = try? root(id, write: true) else { return .unknown }
  let leaf = (path as NSString).lastPathComponent
  let parent = (path as NSString).deletingLastPathComponent
  guard leaf.range(of: "^\\.gmail-mcp-[A-Fa-f0-9-]{36}$", options: .regularExpression) != nil
  else { return .unknown }
  if !parent.isEmpty, (try? validated(parent)) == nil { return .unknown }
  let fd = gm_open(r.fd, path, O_RDONLY | O_NONBLOCK, 0)
  if fd < 0 { return errno == ENOENT ? .absent : .unknown }
  close(fd)
  return .present
}
```

- [x] **Step 4: Add `reservedBytes` to `Journal.swift`**

`entries(prefix:)` selects `scope, key, request_hash, payload` and carries no byte count. The charge
lives in the `reservations` table under `reservation(scope, handle)`, which is
`"save:" + digest(scope + NUL + handle)` and cannot be inverted back to a handle.

```swift
public func reservedBytes(id: String) throws -> Int? {
  guard let value = try scalar("SELECT bytes FROM reservations WHERE id=?", [id]) else {
    return nil
  }
  guard let bytes = Int(value) else { throw NativeError.refused("journal_read") }
  return bytes
}
```

- [x] **Step 5: Implement `unresolvedDebt` in `SaveReceipts.swift`**

Declare `DebtRow` and `DebtRelease` at file scope beside `SaveReceipt`, not nested inside
`SaveReceipts`, so the helper spells the type `DebtRow`.

```swift
public struct DebtRow: Codable, Sendable {
  public let scope: String, handle: String, state: String, root: String, relative: String
  public let bytes: Int
  public let temporary: String   // TemporaryPresence.rawValue
  public let releasable: Bool
}
public enum DebtRelease: String, Codable, Sendable {
  case released, noSuchReceipt = "no_such_receipt", notCharged = "not_charged"
}
```

```swift
/// Charged debt: a receipt short of acknowledged that still holds bytes against the 25 MiB save
/// budget. `releasable` is computed here rather than in the CLI, because which receipts a human
/// may clear is an authority decision and belongs on this side of the boundary.
public func unresolvedDebt() throws -> [DebtRow] {
  var rows: [DebtRow] = []
  for item in try journal.entries(prefix: "save:") {
    let receipt = try JSONDecoder().decode(SaveReceipt.self, from: Data(item.record.payload.utf8))
    guard receipt.state != "acknowledged" else { continue }
    let scope = String(item.scope.dropFirst(5))
    guard let bytes = try journal.reservedBytes(id: reservation(scope, item.key)), bytes > 0
    else { continue }
    let presence =
      receipt.temporary.map { files.temporaryPresence(root: receipt.root, path: $0) } ?? .absent
    rows.append(
      DebtRow(
        scope: scope, handle: item.key, state: receipt.state, root: receipt.root,
        relative: receipt.relative, bytes: bytes, temporary: presence.rawValue,
        releasable: receipt.state == "publication_unknown" && presence == .absent))
  }
  return rows
}
```

- [x] **Step 6: Run it and watch it pass**

Run: `swift test --package-path companion/native --filter ReceiptTests/testUnresolvedDebt`
Expected: PASS, with `bytes` equal to 26,214,400. That is the same number the live machine holds,
which is the point: the fixture reproduces the production charge rather than a stand-in for it.

- [x] **Step 7: Write the failing tests for the release and its three refusals**

The refusals are the task. Each one names a different reason a human must not clear the charge.

```swift
func testReleaseDebtClearsTheChargeAndLeavesThePublicationTruthAlone() throws {
  try FileTests().fixture { files, root, priv in
    let journal = try Journal(path: priv.appendingPathComponent("release.db").path)
    let saves = SaveReceipts(files: files, journal: journal)
    let bytes = Data("payload".utf8)
    try Data("occupied".utf8).write(to: root.appendingPathComponent("a.txt"))
    XCTAssertThrowsError(
      try saves.publish(
        scope: "s", handle: "h", root: "attachments", relative: "a.txt", bytes: bytes,
        sha256: SafeFiles.digest(bytes)))
    let temp = try XCTUnwrap(
      FileManager.default.contentsOfDirectory(atPath: root.path).first {
        $0.hasPrefix(".gmail-mcp-")
      })
    try FileManager.default.removeItem(at: root.appendingPathComponent(temp))
    XCTAssertThrowsError(
      try saves.recover(scope: "s", handle: "h", root: "attachments", relative: "a.txt"))

    XCTAssertEqual(try saves.releaseDebt(scope: "s", handle: "h"), .released)
    XCTAssertTrue(try saves.unresolvedDebt().isEmpty)

    // Accounting was repaired. History was not: the receipt still says what it always said.
    let row = try XCTUnwrap(journal.get(scope: "save:s", key: "h"))
    let after = try JSONDecoder().decode(SaveReceipt.self, from: Data(row.payload.utf8))
    XCTAssertEqual(after.state, "publication_unknown")

    // A second release is not a second success.
    XCTAssertEqual(try saves.releaseDebt(scope: "s", handle: "h"), .notCharged)
    XCTAssertEqual(try saves.releaseDebt(scope: "s", handle: "absent"), .noSuchReceipt)
  }
}

func testReleaseDebtRefusesAReceiptTheCollectorCanStillHandle() throws {
  try FileTests().fixture { files, root, priv in
    let saves = SaveReceipts(
      files: files, journal: try Journal(path: priv.appendingPathComponent("collect.db").path))
    let bytes = Data("payload".utf8)
    try Data("occupied".utf8).write(to: root.appendingPathComponent("a.txt"))
    XCTAssertThrowsError(
      try saves.publish(
        scope: "s", handle: "h", root: "attachments", relative: "a.txt", bytes: bytes,
        sha256: SafeFiles.digest(bytes)))
    // No hand deletion and no recover: the temporary is still there, state is still verified.
    let debt = try saves.unresolvedDebt()
    XCTAssertEqual(debt.count, 1)
    XCTAssertEqual(debt[0].state, "verified")
    XCTAssertEqual(debt[0].temporary, "present")
    XCTAssertFalse(debt[0].releasable)
    XCTAssertThrowsError(try saves.releaseDebt(scope: "s", handle: "h")) { error in
      guard case NativeError.refused(let reason) = error else { return XCTFail("\(error)") }
      XCTAssertEqual(reason, "receipt_not_releasable")
    }
  }
}

func testReleaseDebtRefusesWhenSomethingElseNowHoldsTheTemporaryName() throws {
  try FileTests().fixture { files, root, priv in
    let saves = SaveReceipts(
      files: files, journal: try Journal(path: priv.appendingPathComponent("reused.db").path))
    let bytes = Data("payload".utf8)
    try Data("occupied".utf8).write(to: root.appendingPathComponent("a.txt"))
    XCTAssertThrowsError(
      try saves.publish(
        scope: "s", handle: "h", root: "attachments", relative: "a.txt", bytes: bytes,
        sha256: SafeFiles.digest(bytes)))
    let temp = try XCTUnwrap(
      FileManager.default.contentsOfDirectory(atPath: root.path).first {
        $0.hasPrefix(".gmail-mcp-")
      })
    try FileManager.default.removeItem(at: root.appendingPathComponent(temp))
    XCTAssertThrowsError(
      try saves.recover(scope: "s", handle: "h", root: "attachments", relative: "a.txt"))

    // Something else takes the name. The collector refuses it on device and inode, and so must
    // a human release: releasing here would drop the charge and leave a file nobody accounts for.
    try Data("not ours".utf8).write(to: root.appendingPathComponent(temp))
    XCTAssertThrowsError(try saves.releaseDebt(scope: "s", handle: "h")) { error in
      guard case NativeError.refused(let reason) = error else { return XCTFail("\(error)") }
      XCTAssertEqual(reason, "temporary_still_present")
    }
  }
}
```

- [x] **Step 8: Run all three and watch them fail**

Run: `swift test --package-path companion/native --filter ReceiptTests/testReleaseDebt`
Expected: FAIL, no member `releaseDebt`

- [x] **Step 9: Implement `releaseDebt`**

```swift
/// The owner may clear a charge in exactly one state: a publication_unknown receipt whose
/// temporary is provably gone. Everything else belongs to recoverStartup, which can still check
/// the device and inode it recorded. An unknown probe refuses, because unknown is not absent.
public func releaseDebt(scope: String, handle: String) throws -> DebtRelease {
  guard let row = try journal.get(scope: "save:" + scope, key: handle) else {
    return .noSuchReceipt
  }
  let receipt = try JSONDecoder().decode(SaveReceipt.self, from: Data(row.payload.utf8))
  guard receipt.state == "publication_unknown" else {
    throw NativeError.refused("receipt_not_releasable")
  }
  let presence =
    receipt.temporary.map { files.temporaryPresence(root: receipt.root, path: $0) } ?? .absent
  switch presence {
  case .present: throw NativeError.refused("temporary_still_present")
  case .unknown: throw NativeError.refused("temporary_unknown")
  case .absent: break
  }
  guard let bytes = try journal.reservedBytes(id: reservation(scope, handle)), bytes > 0 else {
    return .notCharged
  }
  // Accounting only. The receipt keeps saying publication_unknown, because this learned nothing
  // about the destination.
  try journal.release(id: reservation(scope, handle))
  return .released
}
```

- [x] **Step 10: Run the whole native suite**

Run: `swift test --package-path companion/native`
Expected: PASS, including the existing crash, race and restart tests.

- [x] **Step 11: Mutation-confirm all three predicates separately**

One mutation at a time. After each edit, print the mutated region with
`sed -n '/func releaseDebt/,/^  }/p' companion/native/Sources/NativeCore/SaveReceipts.swift` to
confirm it landed in `releaseDebt` and nowhere else, then restore before the next one.

| Mutation                                                      | Test that must go red                                   |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| `guard receipt.state == "publication_unknown" \|\| true else` | `testReleaseDebtRefusesAReceiptTheCollectorCanStill`    |
| `case .present: break` in place of the throw                  | `testReleaseDebtRefusesWhenSomethingElseNowHolds`       |
| `guard let bytes = ..., bytes >= 0 else` in `unresolvedDebt`  | `testReleaseDebtClearsTheChargeAndLeavesThePublication` |

The third one is the guard Revision 1 lacked. Without it the listing keeps returning a released
receipt with zero bytes, and `unresolvedDebt().isEmpty` can never be true.

- [x] **Step 12: Run both gates and commit**

```bash
npm run verify
npm run verify:native
git add companion/native/Sources companion/native/Tests
git commit -m "feat(native): let the owner see and release charged save debt

A save that loses the exclusive rename keeps its reservation until
recoverStartup collects the temporary. Delete that temporary by hand and
the collector can no longer verify what it would remove, so the receipt
becomes publication_unknown and the charge stays for ever: one file
removed by hand left 26,214,400 bytes held and every later save answered
spool_budget. The comments called the remedy owner repair and there was
none.

releaseDebt clears accounting in one state only, publication_unknown with
the temporary provably gone, and refuses an unknown probe as firmly as a
present file. The receipt still says publication_unknown afterwards,
because releasing a charge learns nothing about the destination."
```

---

### Task 2: `gmail-mcp-companion debt` exposes the repair to the owner

The native side is useless to the owner until the CLI drives it. This is the command a future reader
reaches for when a save answers `spool_budget`, so its output has to explain the state rather than
print a row.

**Files:**

- Modify: `companion/src/cli.ts`
- Modify: `companion/native/Sources/NativeHelper/main.swift`
- Test: `companion/test/cli.test.ts`

**Interfaces:**

- Consumes: `unresolvedDebt()` and `releaseDebt(scope:handle:)` from Task 1; `NativeProcess`, whose
  no-argument constructor spawns `native/.build/release/gmail-mcp-native` with no `--init`.
- Produces: helper operations `{ op: "debt.list" }` returning `{ rows: DebtRow[] }` and
  `{ op: "debt.release", scope, handle }` returning `{ outcome: String }`. One naming scheme,
  noun then action, at every layer. Revision 1 said `debt.list` in its file table and `debt` in its
  interface block and its code.

**Three facts from source that shape this task.**

The scope is not `"default"`. `Companion` computes it as
`hash([api.origin, owner.client_id, owner.user_id])`, a hex digest; the live machine's is
`<scope digest>`. Revision 1 hardcoded `"default"` in the release path, which would have failed against
every real reservation while reporting nothing wrong. `--scope` is required, and the listing prints
the whole command including it.

The helper takes an exclusive process lock. `main.swift` opens
`ProcessLock(path: stateDir + "/companion.lock")` before anything else, with the default `wait: true`,
so `flock(LOCK_EX)` **blocks** rather than failing. The companion spawns a fresh helper per tool call
and closes it in a `finally`, so `debt` normally acquires the lock at once; it waits only while a save
or stage is mid-flight, bounded by the six-minute call timeout. This is also the answer to whether
owner repair can race `recoverStartup`: it cannot, because every helper invocation takes the lock
before it reads a row. No new mechanism is needed, but every spawn in a test needs a timeout.

`npm run verify` does not build Swift. Adding a CLI test that needs the release binary would make the
TypeScript gate silently depend on a native build. The test therefore skips itself, loudly, when the
binary is absent, and Task 2 runs it for real with the binary present. The native suite remains the
authority for the behaviour; this test only proves the wiring.

- [x] **Step 1: Build the native binary**

Run: `cd companion && npm run build:native`
Expected: exit 0, and `companion/native/.build/release/gmail-mcp-native` exists.

- [x] **Step 2: Write the failing test**

`test/cli.test.ts` has no `runCli` and no `fakeNative`; it spawns the real CLI over stdio. Follow
that. The two assertions below hold whatever the machine's journal contains, which is what makes an
integration test against real state acceptable here. A hermetic version would need the helper's state
directory to be overridable, and that directory is resolved from `$HOME` inside `main.swift` as a
security boundary. Do not add an environment override to make a test easier.

```ts
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const nativeBinary = new URL("../native/.build/release/gmail-mcp-native", import.meta.url).pathname;

// Integration, not hermetic: this drives the real helper against the machine's own journal.
// npm run verify does not build Swift, so it skips rather than making the TS gate depend on it.
it.skipIf(!existsSync(nativeBinary))("debt lists charged debt and refuses a handle that is not there", () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  // The helper takes an exclusive lock, so a save in flight makes this wait. Never spawn it
  // without a timeout.
  const list = spawnSync(process.execPath, [cli, "debt"], { encoding: "utf8", timeout: 60_000 });
  expect(list.error).toBeUndefined();
  expect(list.status).toBe(0);
  // Either nothing is charged, or every row prints the exact command that clears it.
  expect(list.stdout).toMatch(/^No charged save debt\.\n$|--scope \S+ --release \S+/);

  const bogus = spawnSync(process.execPath, [cli, "debt", "--scope", "nosuchscope", "--release", "nosuchhandle"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(bogus.error).toBeUndefined();
  expect(bogus.stdout).toBe("No such receipt.\n");
});
```

- [x] **Step 3: Run it and watch it fail**

Run: `cd companion && npx vitest run test/cli.test.ts -t "debt lists charged debt"`
Expected: FAIL. The CLI throws `usage` for an unknown command, so stdout is empty and stderr carries
the usage line. Confirm the filter matched one test rather than zero: vitest prints `1 failed` and
names it. A run reporting `no tests found` means the `-t` string is wrong, which is how Revision 1
would have failed here, filtering on a name no test had.

- [x] **Step 4: Route both operations in the helper**

In `main.swift`, beside the existing `save.*` cases. The helper answers with `try reply(try json(value))`;
there is no `Response` type. `Command` already declares optional `scope` and `handle`, so no new
fields are needed.

```swift
case "debt.list":
  struct DebtReply: Encodable { let rows: [DebtRow] }
  try reply(try json(DebtReply(rows: try saves.unresolvedDebt())))
case "debt.release":
  struct ReleaseReply: Encodable { let outcome: String }
  try reply(
    try json(
      ReleaseReply(
        outcome: try saves.releaseDebt(
          scope: required(command.scope), handle: required(command.handle)).rawValue)))
```

- [x] **Step 5: Add the CLI command**

A refusal arrives as a rejected promise whose message is the native code, and the `catch` at the
bottom of `main()` would print "Companion command failed. Check configuration, permissions, login and
the native build." for `temporary_still_present`. That is the wrong sentence for the one case the
owner most needs to understand, so this branch handles its own refusals.

```ts
type DebtRow = {
  scope: string;
  handle: string;
  state: string;
  root: string;
  relative: string;
  bytes: number;
  temporary: string;
  releasable: boolean;
};

if (command === "debt") {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { release: { type: "string" }, scope: { type: "string" } },
  });
  const native = new NativeProcess();
  try {
    if (values.release !== undefined) {
      // The reservation id is a digest of scope and handle and cannot be inverted, so the scope
      // has to be named. It is never "default": it is a hash of origin, client and owner.
      if (!values.scope) throw new Error("usage");
      const { outcome } = (await native.call({ op: "debt.release", scope: values.scope, handle: values.release }))
        .meta as { outcome: string };
      process.stdout.write(
        { released: "Released.\n", no_such_receipt: "No such receipt.\n", not_charged: "Nothing charged.\n" }[
          outcome
        ] ?? `Unexpected outcome: ${outcome}\n`,
      );
      return;
    }
    const { rows } = (await native.call({ op: "debt.list" })).meta as { rows: DebtRow[] };
    if (rows.length === 0) {
      process.stdout.write("No charged save debt.\n");
      return;
    }
    for (const row of rows) {
      const remedy = row.releasable
        ? `run: gmail-mcp-companion debt --scope ${row.scope} --release ${row.handle}`
        : row.temporary === "present"
          ? "start the companion; the helper collects this safely on startup"
          : `not clearable: state ${row.state}, temporary ${row.temporary}`;
      process.stdout.write(
        `${row.handle}  ${row.state}  ${row.bytes} bytes  ${row.root}/${row.relative}\n  ${remedy}\n`,
      );
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "native_failed";
    if (!/^[a-z_]+$/.test(code)) throw error;
    process.stdout.write(`Refused: ${code}\n`);
    process.exitCode = 1;
  } finally {
    native.close();
  }
  return;
}
```

Add `debt [--scope SCOPE --release HANDLE]` to the usage string in the `catch` at the bottom of
`main()`.

- [x] **Step 6: Run the test and watch it pass**

Run: `cd companion && npx vitest run test/cli.test.ts`
Expected: PASS, both tests, neither skipped.

- [x] **Step 7: Prove the refusal reaches the owner as a sentence**

The refusal path is the one the generic handler used to swallow, so exercise it by hand once:

Run: `node companion/src/cli.ts debt --scope nosuchscope --release nosuchhandle`
Expected: `No such receipt.` and exit 0, not the usage line.

- [x] **Step 8: Run both gates and commit**

```bash
npm run verify
npm run verify:native
git add companion/src companion/test companion/native/Sources
git commit -m "feat(companion): a debt command, because spool_budget needs a way out

When a save answers spool_budget the owner has no way to see what is
charged or clear it. debt lists every charged receipt with the remedy that
fits it: a restart where the helper can still collect the temporary
safely, a release where it cannot, and a plain refusal where neither is
safe.

--scope is required. The reservation id is a digest of scope and handle
and cannot be inverted, and the scope is a hash of origin, client and
owner rather than a constant, so a default here would have been wrong
against every real reservation while reporting nothing wrong."
```

---

### Task 3: Repair the live machine, with the owner's authorization for that one act

Tasks 1 and 2 are ordinary work. This one mutates the owner's real journal, so it is a task of its
own and does not start without the owner saying to start it. **Do not begin this task on the
strength of Plan 7 being approved.** Approval of a plan is not authorization for a specific
irreversible act against live data.

The state below was read from the live journal on 2026-09-19 and is the preflight: if what the
command prints disagrees with it, stop and report rather than releasing anything.

The digests and the destination appear here as placeholders. This repository is public, and the
scope is `sha256(origin + NUL + client_id + NUL + user_id)`, a stable identifier derived from the
owner's Google `sub`, while the destination is a filename out of their mailbox. Neither grants
access, and publishing them would still be publishing personal data for no gain. The executor reads
the real values out of `debt` and compares them against what the owner confirms, which is what the
preflight is for; the shapes below are what makes the comparison checkable.

| Field       | Value                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| reservation | `save:<reservation digest>`                                                   |
| bytes       | 26,214,400                                                                    |
| scope       | `<scope digest>`                                                              |
| handle      | `<handle>`                                                                    |
| state       | `publication_unknown`                                                         |
| temporary   | `.gmail-mcp-8198FF28-3AFB-4F65-9781-AF6151DA3028`, absent from the write root |
| destination | `attachments/<owner attachment>.pdf`                                          |

Two other save records exist and neither holds a reservation: `<handle A>` is `prepared` and
`<handle B>` is `acknowledged`. Exactly one row should appear.

**Files:** none. This task changes owner data and the plan's execution record, not the repository.

- [x] **Step 1: Confirm the owner has authorized this run**

Ask, and wait. Name the reservation, the byte count and the fact that the receipt stays
`publication_unknown` afterwards. If the answer has not arrived, stop here; Tasks 4 to 8 do not
depend on this one.

- [x] **Step 2: Quit the companion, then read the debt**

The helper's lock is exclusive and its waiter blocks, so a save in flight makes this command wait
rather than fail. Quit the MCP client's companion connection first.

Run: `node companion/src/cli.ts debt`
Expected: exactly one row, matching every field of the table above, whose remedy line reads
`run: gmail-mcp-companion debt --scope <scope digest> --release <handle>`.

Stop if more than one row appears, if the byte count differs, if the state is not
`publication_unknown`, or if the temporary is anything but absent. Any of those means the machine
moved since the preflight was taken, and the preflight is what authorizes the release.

- [x] **Step 3: Release, using the scope and handle the listing printed**

Copy them from the output; do not retype them from this document, and do not pass
`<reservation digest>`, which is the reservation id rather than the handle.

Run: `node companion/src/cli.ts debt --scope <scope> --release <handle>`
Expected: `Released.`

Run: `node companion/src/cli.ts debt`
Expected: `No charged save debt.`

- [x] **Step 4: Prove the repair with a save, then clean up after it**

`Released.` is a claim; a save is the evidence. Use a disposable destination and remove it
afterwards, because the write root is the owner's own Downloads folder.

Restart the companion, then run `save_attachment` with `root: "attachments"` and
`path: "plan7-repair-proof.pdf"`, a name nothing else uses.
Expected: a published, acknowledged receipt rather than `spool_budget`.

Then delete `~/Downloads/Gmail MCP/plan7-repair-proof.pdf` through the Finder or `rm`, and run
`node companion/src/cli.ts debt` once more. Expected: `No charged save debt.` A completed save
releases its own reservation, so deleting its destination afterwards leaves nothing charged. Confirm
that rather than assuming it.

- [x] **Step 5: Record the result in the execution record**

Both outcomes are worth recording. Write the preflight as read, the outcome of the release, the
save's receipt state, and the final listing. If any step refused, record the refusal and what it
proves; a refusal here is the guard working.

---

### Task 4: Section 4.8 documents the qualification architecture, not only its gates

The reconciliation added the five external gates and stopped, because describing RunIdentity,
evidence-graph integrity and qualification epochs from memory would have been fiction. Read the
source first, then write only what it says.

**Files:**

- Read: `scripts/qualification/` in full, and `worker/src/build-identity.ts`
- Modify: `docs/superpowers/specs/2026-09-09-gmail-mcp-design.md`, section 4.8

This task carries no draft prose on purpose. Writing that section from memory is how the document
became a palimpsest, and a plan that supplied the words would invite the executor to skip the
reading. The deliverable is checkable even so: Step 3 requires a file and symbol behind every
sentence, and a sentence without one is deleted.

- [x] **Step 1: Read the qualification source and list what exists**

Run: `ls scripts/qualification && grep -rn "identitySha256\|RunIdentity\|epoch" scripts/qualification | head -40`

Write down, in the plan's execution record, the actual names: the identity a run binds, the field an
observation carries, how evidence is verified, and what an epoch changes. Do not proceed on memory.

- [x] **Step 2: Extend 4.8 with what you found**

Cover, and only where the source supports it: how a build identity is derived and what it hashes;
what `identitySha256` binds an observation to; how the evidence graph is checked before release; what
a qualification epoch is and what replacing one does to work already in flight; and which components
must carry evidence for release to be possible.

- [x] **Step 3: Check every claim against a file**

For each sentence, name the file and symbol that makes it true, in the execution record. Delete any
sentence you cannot anchor. A design document describing machinery nobody can find is worse than one
that is silent.

- [x] **Step 4: Run stop-slop, then the gate, then commit**

```bash
npm run verify
git add docs/superpowers/specs/2026-09-09-gmail-mcp-design.md
git commit -m "docs(spec): describe the qualification architecture from source"
```

---

### Task 5: The testing matrix describes the gauntlet, not the pre-implementation plan

Section 4.7 predates the gauntlet and reads like a list of intentions. It should say how the system
is verified and point at the canonical evidence, without scattering test counts that go stale the
next time anyone adds a test.

**Files:**

- Modify: `docs/superpowers/specs/2026-09-09-gmail-mcp-design.md`, section 4.7

- [x] **Step 1: Rewrite 4.7 around method rather than inventory**

Name the four suites and what each runs against: the Worker suite inside workerd with real D1, R2 and
KV emulation; the shared package under Node; the companion suite; the native Swift suite. State the
three rules the gauntlet converged on, which are already in CLAUDE.md and are the useful part: an
assertion must not be vacuous, the named guard must actually be reached, and a mutation must have
changed the region intended.

- [x] **Step 2: Replace counts with a pointer, and name both gates**

Delete any fixed test count. Say that `npm run verify` covers format, lint, typecheck and the
TypeScript suites, that `npm run verify:native` covers `swift test` and the release build, and that
the first does not include the second. Point at
`docs/superpowers/reviews/2026-09-17-full-project-gauntlet.md` for the invariant matrix, the
load-bearing predicate table and the findings.

- [x] **Step 3: Keep the four things the matrix got right**

The 25 MiB round trips stay as functional exercises with their 4.8 caveat. The fake-Gmail adapter,
the elicitation resume and the media-to-resumable boundary at 5 MB stay, because each names a real
case. Do not lose them in the rewrite.

- [x] **Step 4: Run stop-slop, then the gate, then commit**

```bash
npm run verify
git add docs/superpowers/specs/2026-09-09-gmail-mcp-design.md
git commit -m "docs(spec): 4.7 describes how the system is verified now"
```

---

### Task 6: A second gauntlet over the reconciled document

Step 9 of the review that prompted the reconciliation. The first gauntlet audited the implementation;
this one audits the document that now claims to describe it. It runs after Tasks 4 and 5, because
auditing a section about to be rewritten wastes the pass.

**Files:**

- Create: `docs/superpowers/reviews/2026-09-19-spec-reconciliation-gauntlet.md`

**What "probe" means here.** A probe is a read: running the suite, reading source, `sqlite3` against
a local journal, `curl` against a public endpoint, `wrangler tail` observing traffic the owner
generated. A probe never sends mail, never deploys, never revokes, never restores, never triggers a
destructive native test, and never generates target-specific qualification evidence. Any of those is
a separate act with its own authorization, like Task 3. Where a claim can only be settled by one of
them, the finding is `not_verified` with the reason, which is a legitimate outcome.

- [x] **Step 1: Take the baseline**

Record the commit, the output of `npm run verify` and `npm run verify:native`, and the spec's current
revision line. A gauntlet without a baseline cannot tell a finding from a change made during the run.

- [x] **Step 2: Sweep every normative claim in the spec against source or a probe**

For each claim, record the file and symbol, or the probe and its output, or `not_verified` with the
reason. The 2026-09-19 pass verified six claims this way: the `search_threads` ceiling of 50, the
998-byte subject cap, the 500-recipient cap, malformed addresses refused before policy, the label
tools refusing TRASH, and `+overwrite` having no emitter. Extend that; do not repeat it.

- [x] **Step 3: Check the document against itself**

The first reconciliation existed because sections contradicted each other: OAuth state in KV in one
place and D1 in another, a journal heading denied three lines later, two definitions of
`requestState`. Look for the same shape in the sections the reconciliation did not touch.

- [x] **Step 4: Classify every finding before looking at the answer**

Stop-ship, medium or precision, with the expected terminal state written before the check runs, as
the first gauntlet did for its external gates. A finding classified after the result is a finding
shaped by it.

- [x] **Step 5: Append the record, run stop-slop, then the gate, then commit**

Append to the new review file; never rewrite an earlier review.

```bash
npm run verify
git add docs/superpowers/reviews/2026-09-19-spec-reconciliation-gauntlet.md
git commit -m "docs(review): second gauntlet over the reconciled architecture"
```

---

### Task 7: The companion CLI test races the CLI's own startup

Reproduced and captured on the eighth full-suite run while this plan was being gauntleted:

```
FAIL test/cli.test.ts > launches the CLI directly in Node and lists tools without accessing credentials
AssertionError: expected false to be true
 ❯ test/cli.test.ts:25:56
    await expect.poll(() => stdout.includes('"id":1')).toBe(true);
Caused by: Error: Matcher did not succeed in time.
```

The earlier guess in CLAUDE.md, that host state from `init` and `login` had leaked in, is wrong, and
the capture kills it: the failure is the **first** poll, waiting for the `initialize` reply, in a test
whose own name says it runs without credentials. Nothing has read a config by then. The test spawns
`node src/cli.ts serve`, which makes Node type-strip `cli.ts` and its imports on every run, then waits
on `expect.poll`'s default budget of one second.

**The measurement, taken 2026-09-19 on this machine.** Spawn to first `initialize` reply, which is the
boundary the poll actually waits on:

| Condition                  | n   | min   | median | p95   | max   |
| -------------------------- | --- | ----- | ------ | ----- | ----- |
| idle                       | 10  | 205ms | 253ms  | 513ms | 513ms |
| during `worker` vitest run | 12  | 379ms | 464ms  | 694ms | 694ms |

Against a 1000ms budget, the loaded p95 leaves a factor of 1.4. That is not a margin, and a full
`npm run verify` is busier than one worker suite. The test is timing the machine.

**Files:**

- Modify: `companion/test/cli.test.ts`

- [x] **Step 1: Reproduce the measurement before changing anything**

Revision 1's command was `/usr/bin/time -p node src/cli.ts serve </dev/null >/dev/null 2>&1`, which
sends `/usr/bin/time`'s own report to `/dev/null` and measures process exit rather than the reply the
test waits for. Measure the right boundary instead. Write this to the scratchpad, not the repository:

```js
import { spawn } from "node:child_process";
const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const samples = [];
for (let i = 0; i < Number(process.argv[2] ?? 20); i++) {
  const t0 = performance.now();
  const child = spawn(process.execPath, [cli, "serve"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  const first = new Promise((res) =>
    child.stdout.on("data", (d) => {
      out += d.toString();
      if (out.includes('"id":1')) res(performance.now() - t0);
    }),
  );
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "m", version: "1" } },
    }) + "\n",
  );
  samples.push(await first);
  child.kill();
}
samples.sort((a, b) => a - b);
const q = (p) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))].toFixed(0);
console.log(
  `n=${samples.length} min=${samples[0].toFixed(0)} median=${q(0.5)} p95=${q(0.95)} max=${samples.at(-1).toFixed(0)}`,
);
```

Take 20 idle samples, then 20 more while `cd worker && npx vitest run` is in flight.

Expected: a loaded p95 within a small factor of 1000ms, as the table shows. If the loaded p95 comes
back under about 250ms, this diagnosis is wrong: record that in the execution record and stop rather
than applying the change below.

- [x] **Step 2: Give both polls a budget that reflects a process start**

Both need it, not only the one that failed; the second is merely luckier, because the process is warm
by then.

```ts
await expect.poll(() => stdout.includes('"id":1'), { timeout: 15_000, interval: 50 }).toBe(true);
...
await expect.poll(() => stdout.includes('"id":2'), { timeout: 15_000, interval: 50 }).toBe(true);
```

This is not loosening a check. The assertion is unchanged and a reply that never arrives still fails;
what changes is that the test stops asserting a deadline it was never trying to measure. Fifteen
seconds still catches a genuine hang.

- [x] **Step 3: Make the failure diagnosable when it does fail**

The capture cost eight runs because the assertion prints `expected false to be true` and discards
everything the child said. Include it:

```ts
await expect
  .poll(() => stdout.includes('"id":1'), { timeout: 15_000, interval: 50 })
  .toBe(true)
  .catch(() => {
    throw new Error(`no initialize reply.\nstdout: ${stdout}\nstderr: ${stderr}`);
  });
```

- [x] **Step 4: Run the loop on exit codes, not on grep**

Revision 1 parsed vitest's presentation text for `"[0-9] failed"`, which misses a crash with a
different message and reads `grep`'s own exit status rather than the run's. Use the process status:

```bash
cd companion
set -euo pipefail
for i in $(seq 1 40); do
  echo "run $i/40"
  npx vitest run
done
echo "40 clean runs"
```

Expected: the final line prints. `set -e` stops at the first non-zero exit, and the run number says
which. Anything else means the timeout was not the cause, and the execution record says so rather
than the timeout being raised again.

- [x] **Step 5: Run the gate and commit**

```bash
npm run verify
git add companion/test/cli.test.ts
git commit -m "test(companion): stop timing a cold Node start with a one-second poll"
```

---

### Task 8: Decide what the recovery-suite timeouts are

Two recovery tests failed on timeouts at 18.5s and 29.2s during a run in which only markdown had
changed, and a re-run was clean. CLAUDE.md already records that contention, not regression, is the
usual cause, and that anything above about 600ms locally deserves a look. This task answers whether
these two are contention or are genuinely near their ceiling.

Two observations cannot answer that. A single isolated run against a single loaded run gives a ratio
with no distribution behind it, and the six-to-nine figure in CLAUDE.md came from a different test on
CI hardware. Collect samples.

**Files:**

- Read: `worker/test/recovery-barrier-ladder.test.ts`, `worker/test/recovery-transport-matrix.test.ts`
- Modify: `CLAUDE.md`, and `worker/test/*` only if Step 3 finds a real ceiling

- [x] **Step 1: Ten isolated samples**

```bash
cd worker
for i in $(seq 1 10); do
  npx vitest run test/recovery-barrier-ladder.test.ts test/recovery-transport-matrix.test.ts \
    --reporter=verbose 2>&1 | grep -E "^ *✓|✗.*recovery-(barrier|transport)"
done
```

Record every per-test duration. Ten runs, both files, so about twenty samples per test.

- [x] **Step 2: Ten loaded samples**

```bash
cd worker
for i in $(seq 1 10); do
  npx vitest run --reporter=verbose 2>&1 | grep -E "recovery-(barrier|transport)"
done
```

Record the same durations under the full suite.

- [x] **Step 3: Compute the distribution and decide**

For each of the two tests, report n, median, p95 and max in both conditions, and the loaded-to-isolated
ratio at the median and at p95. Then decide:

- Loaded p95 comfortably under the configured timeout and the ratio in the range CLAUDE.md documents:
  contention. The finding closes with the measurement and no code changes.
- Isolated p95 already near the timeout: a real ceiling. Cut the cost the way the settlement sweep was
  cut, hoisting expensive setup out of the loop first, and only then consider a timeout with the real
  reason written beside it.
- The two tests disagree: decide them separately and say so.

Do not raise a timeout to make a run green. That converts a measurement into a wish.

- [x] **Step 4: Put the numbers and the conclusion in different places**

The full table goes in this plan's execution record, which is where a measurement belongs: it is dated
evidence about one machine on one day. Only the reusable conclusion goes to CLAUDE.md, in the form the
other entries take, symptom first. If the verdict is contention with no code change, CLAUDE.md gains
one paragraph and `worker/test` gains nothing.

- [x] **Step 5: Run the gate and commit**

```bash
npm run verify
git add CLAUDE.md docs/superpowers/plans/2026-09-19-gmail-mcp-plan-7-repair-and-reconciliation.md
git commit -m "test(recovery): measure the two slow files and record the verdict"
```

---

## Defect ledger

Revision 1 was audited twice before anyone executed it. Both passes are recorded, including where a
reviewer was wrong, because the rates are the useful part.

**Pass 1, the author's self-gauntlet.** Nine inferred APIs checked against source. Four held:
`new NativeProcess()` defaults to no `--init`; `Command` already declares optional `scope` and
`handle`; `journal.entries(prefix:)` yields `(scope, key, record)` with the payload the receipt
decodes from; `reservation(scope, handle)` is reachable inside `SaveReceipts`. Five were wrong:
`item.record.bytes` does not exist and the charge lives in the `reservations` table;
`(error as? NativeError)?.reason` does not exist because `NativeError` is an enum with no properties;
`<reservation digest>` is the reservation id and is not invertible to a handle; `runCli` and `fakeNative` do not
exist in `test/cli.test.ts`; and the helper answers with `reply(try json(value))` rather than a
`Response` type. Five of nine inferred APIs wrong.

**Pass 2, the external review.** Nine stop-ships and twelve mediums. Seventeen adopted as written,
two adopted with the remedy replaced, and both replacements came from source:

- The tri-state temporary probe is right, and the reviewer's design is reasonable, but
  `discardTemporary` already separates ENOENT from every other open failure. The probe copies that
  shape instead of inventing one.
- Requiring `path == leaf` would break every temporary in a subdirectory, and `prepare` builds
  exactly those: `(parent.isEmpty ? "" : parent + "/") + ".gmail-mcp-" + UUID()`. The fix is
  `validated(parent)`, which is what `discardTemporary` calls.

The review also asked for a concurrency statement between owner repair and `recoverStartup`. There is
nothing to add: `main.swift` takes an exclusive `ProcessLock` before either runs, so they cannot
overlap. That is now written down in Task 2 rather than built.

**Pass 3, reading the live machine and measuring the flake.** Four defects neither pass found:

| Defect                                                                                                                                                                                                                  | How it was found                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `ProcessLock` defaults to `wait: true`, so `debt` blocks rather than failing while a save is in flight; every test spawn needs a timeout                                                                                | reading `Auth.swift:9` and `main.swift:51`    |
| The global constraint named `swift build --package-path native`, which does not resolve from the repository root, and missed that `npm run verify:native` already exists and runs both halves                           | reading the root `package.json`               |
| Revision 1's Task 1 invented two test helpers it admitted did not exist; the production route to the defect is reproducible with the existing `FileTests().fixture` and one `removeItem`, so the helpers are not needed | tracing `publish` into `recover` line by line |
| A `releaseDebt` refusal would have surfaced to the owner as "Companion command failed. Check configuration, permissions, login and the native build."                                                                   | reading `main().catch` in `cli.ts`            |

And the numbers that turned two guesses into measurements: the live reservation belongs to handle
`<handle>` under scope `<scope digest>`, confirmed by recomputing
`sha256(scope + NUL + handle)` for all three save records and matching `<reservation digest>`; and the CLI
spawn-to-`initialize` boundary sits at a 694ms loaded p95 against a 1000ms budget.

**Self-review of Revision 2.** Spec coverage: Tasks 4, 5 and 6 close the three documentation items;
Tasks 1 to 3 close the repair gap the code comments promise; Tasks 7 and 8 close the two
intermittents. Nothing here touches the five external gates in 4.8. Placeholders: every code step
carries its code, and Task 4's deliberate absence of prose is argued at the task rather than left
unexplained. Type consistency: `DebtRow` has the same eight fields at its Swift definition, in the
Swift tests, in the helper reply and in the TypeScript type; `releaseDebt` returns `DebtRelease` in
Swift, crosses the wire as `outcome: String`, and is read as `outcome` in the CLI;
`temporaryPresence(root:path:)` is spelled identically at its definition and both call sites;
`debt.list` and `debt.release` are the only operation names anywhere in this document.

**Standing weakness.** Task 4 is the least checkable task here, and deliberately so. Its output cannot
be shown in advance without inviting the executor to copy it instead of reading the source. Step 3 is
what keeps it honest, and a reviewer should read Task 4's execution record before the diff.

---

## Execution record

Executed inline on 2026-09-19 from `acffbbc`, on branch `plan7-repair`.

### Task 1: the native repair

Commit `7b99a9e`. `npm run verify` exit 0, `npm run verify:native` exit 0, 26 native tests.

The listing test failed first with `value of type 'SaveReceipts' has no member 'unresolvedDebt'`, as
predicted. `releaseDebt` was written in the same edit as `unresolvedDebt`, which would have let its
three tests pass the moment they were written, so it was removed to the scratchpad, the tests were
run red against the missing member, and it was restored. That round trip is the only reason those
three tests count as evidence.

The fixture reproduces the production charge rather than standing in for it: `bytes` comes back as
`SafeFiles.maximum`, 26,214,400, the same number the live machine held.

Mutation results, each restored before the next:

| Mutation                                                               | Test                                         | Result                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| `guard receipt.state == "publication_unknown" \|\| true`               | `…RefusesAReceiptTheCollectorCanStillHandle` | RED: got `temporary_still_present`, wanted `receipt_not_releasable` |
| `case .present: break`                                                 | `…RefusesWhenSomethingElseNowHoldsThe…`      | RED: `XCTAssertThrowsError failed: did not throw an error`          |
| `let bytes = try journal.reservedBytes(…) ?? 0`, revision 1's own line | `…ClearsTheChargeAndLeavesThePublication…`   | RED at line 106, `XCTAssertTrue failed`                             |

The third mutation is the one worth keeping. Line 106 is `unresolvedDebt().isEmpty`, the assertion
the external review said Revision 1 could never satisfy. Restoring Revision 1's line reproduces
exactly that failure, so the claim is now demonstrated rather than argued.

`swift format lint` reports nothing new; its four existing warnings are the deliberate snake_case
wire fields.

### Task 2: the CLI

Commit `882fbf5`. `npm run verify` exit 0 with 24 companion tests, `npm run verify:native` exit 0.

The test failed first on `expect(list.status).toBe(0)` returning 1, because `debt` was an unknown
command and `main().catch` sets the exit code. The filter matched one test, not zero.

The refusal path was exercised by hand, which is the point of the branch's own `catch`:

```
$ node companion/src/cli.ts debt --scope nosuchscope --release nosuchhandle
No such receipt.
exit=0
```

And the live listing, before any repair, matched the Task 3 preflight in every field:

```
<handle>  publication_unknown  26214400 bytes  attachments/<owner attachment>.pdf
  run: gmail-mcp-companion debt --scope <scope digest> --release <handle>
```

### Task 3: the live repair

Authorized by the owner on 2026-09-19 after the preflight was shown. The preflight was re-read
immediately before the release and still matched, so the release went ahead.

```
$ node companion/src/cli.ts debt --scope <scope digest> --release <handle>
Released.
$ node companion/src/cli.ts debt
No charged save debt.
$ sqlite3 journal.sqlite "SELECT id,bytes FROM reservations"
(no rows)
```

The receipt still reads `publication_unknown`, which is the whole point: accounting was repaired and
publication truth was left alone.

**The proof.** `Released.` is a claim, so a full save was driven through the helper's own stdio
protocol to a disposable path. That exercises the exact operation that was failing, because
`spool_budget` came from `journal.reserve` inside `save.prepare`:

```
prepare: {"state":"prepared","relative":"plan7-repair-proof.pdf","temporary":".gmail-mcp-692A8803-…"}
publish: {"state":"published","file":{"size":20,"sha256":"45c15da4…","inode":193311833}}
ack    : {"state":"acknowledged", …}
```

No staging handle was minted for this, because the Worker side is not what the repair touched.

**A consequence the plan did not predict.** Step 4 said to delete the proof file afterwards, and
deleting it turns its `acknowledged` receipt into `publication_unknown` on the next helper start.
Measured, not reasoned about: after `rm`, the journal reads

```
sh_plan7RepairProof0000000000000000000000000|publication_unknown
```

That is invariant 35 holding. An established publication never becomes permission to write to that
path again, and `recover` cannot verify a destination that is gone. The record carries no
reservation, so `debt` correctly stays silent and nothing is charged. The cost is one inert row, and
the general fact is worth knowing: **deleting a file the companion saved condemns its receipt.**
Anyone writing a future cleanup step should expect that rather than discover it.

### Task 7: the companion CLI flake

Commit `8a84cfe`. `npm run verify` exit 0.

The measurement did not justify the change, and reproducing the failure did. Spawn to the
`initialize` reply, measured at the boundary the poll waits on:

| Condition                                      | n   | min   | median | p95   | max   |
| ---------------------------------------------- | --- | ----- | ------ | ----- | ----- |
| external, idle                                 | 20  | 188ms | 190ms  | 225ms | 225ms |
| external, during the worker suite              | 20  | 201ms | 233ms  | 355ms | 355ms |
| external, during `npm run verify`              | 20  | 199ms | 226ms  | 423ms | 423ms |
| in-harness, companion suite alone              | 20  | 214ms | 259ms  | 311ms | 311ms |
| in-harness, worker and qualification alongside | 15  | 261ms | 350ms  | 528ms | 528ms |

Not one of those 95 samples crossed the one-second budget. On the plan's own terms that is close to
the stop condition, so the change was not applied on the strength of it. Instead the original budget
was restored and forty suites were run with the worker and qualification suites alongside:

```
FAIL at run 12
failures: 1 / 40 (1s budget, under load)
```

The capture is the original one, line for line: `test/cli.test.ts:26`, the first poll,
`Matcher did not succeed in time`. So the body of the distribution is comfortable, its tail crosses
the budget at roughly one run in forty, and 95 samples were not enough to see it. A budget sitting
inside the tail of its own metric is the defect, and the fix removes a deadline the test never
meant to assert. Forty runs under the same load afterwards are clean.

The lesson is about method rather than about this test. A rare tail is not refuted by a hundred
samples of the body; reproduce the failure, or say you could not.

### Task 8: the recovery-suite timeouts

**Verdict: contention. No code change.** With one caveat worth more than the verdict.

Isolated, the two files are nowhere near their ceilings. Ten runs of the two files alone:

| Test                                           | n   | median | p95    | max    | ceiling  |
| ---------------------------------------------- | --- | ------ | ------ | ------ | -------- |
| `rolls the settlement back at every statement` | 10  | 988ms  | 1329ms | 1329ms | 30,000ms |
| `provider-commit` ladder rung                  | 10  | 608ms  | 958ms  | 958ms  | 5,000ms  |
| `resumable: partial-json`                      | 10  | 436ms  | 829ms  | 829ms  | 5,000ms  |

Ten runs of the full worker suite with the default reporter, which is the condition `npm run verify`
creates: **0 failures**.

Ten runs of the full worker suite with `--reporter=verbose` piped to `grep`, on a machine at load
average 15: **4 failures**, and the numbers finally match the ones that opened this task.

| Test                       | isolated median | loaded median | loaded max | ceiling  |
| -------------------------- | --------------- | ------------- | ---------- | -------- |
| settlement statement sweep | 988ms           | 2816ms        | 29,683ms   | 30,000ms |
| `resumable: partial-json`  | 436ms           | 1254ms        | 14,640ms   | 5,000ms  |
| `resumable: lost-body`     | 430ms           | 1586ms        | 14,388ms   | 5,000ms  |
| `provider-commit` rung     | 608ms           | 2073ms        | 9,606ms    | 5,000ms  |

The median ratio is 2.9 to 3.7, inside the range CLAUDE.md already documents for contention, so the
original 18.5s and 29.2s are explained: 29,683ms against a 30,000ms ceiling is the settlement sweep
consuming 99 percent of its budget, and the two `resumable:` cases are the ones that actually went
over.

No timeout was raised. The rule is cost first and ceiling second, the isolated cost is under a
second, and the condition that turns these red is not the condition the gate runs in. Raising a
ceiling on the strength of a contaminated measurement is the wish this task exists to refuse.

**The caveat, and the reason this task was worth running.** The instrument was part of the load.
The same ten runs pass with the default reporter and fail four times out of ten with
`--reporter=verbose` piped to `grep`, because 651 streamed lines through a pipe are themselves
enough pressure to push these tests over. Anyone measuring this suite must not measure it that way,
and a red run obtained that way is not evidence of a regression.

### Task 4: section 4.8, the qualification architecture

Commit `8cbfdae`. `npm run verify` exit 0.

Step 1's deliverable, the names read out of the source before anything was written:

| Thing               | Where                                                     | What it is                                                                                                                             |
| ------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| build identity      | `build-id.ts` `computeBuildId`                            | sorted, length-prefixed SHA-256 over `worker/src/`, `shared/src/`, `worker/migrations/` and eight named manifests                      |
| identity template   | `build-id.ts` `identitySource`                            | `worker/src/build-identity.ts` is normalised to `unqualified` before hashing and refused if edited                                     |
| config substitution | `build-id.ts` `canonicalConfig`                           | replaces `worker/wrangler.jsonc`, drops `vars.BUILD_ID`, throws on `/SECRET\|TOKEN\|PASSWORD\|KEKS\|HMAC/i`                            |
| run identity        | `contracts.ts` `RunIdentity`                              | version 2; a `recovery-mode` run needs root, mode, epoch and expiry, a `release-component` run needs all four null                     |
| what a run targets  | `contracts.ts` `Snapshot`, `Target`, `snapshotOf`         | snapshot pins four build ids and `compatibilityVersion` 3; target adds `userId`, `accountId`, `credentialVersion`                      |
| observation binding | `contracts.ts` `Observation`, `identityHash`              | `sha256("gmail-mcp/plan6/v2/<domain>\n" + canonicalize(value))`, over the Worker's own RFC 8785 canonicaliser                          |
| graph integrity     | `contracts-validation.ts` `EvidenceVerifier.validateCase` | recomputes `preparationRoot`; refuses a row whose `identitySha256` is not the run's, and a source whose hash is not the row's          |
| mode evidence       | `contracts.ts` `assertModeReports`                        | proof case must be `requiredProof(mode)`, pass, three attempts, three observations; nine `CommonCases` once each, sharing one snapshot |
| release             | `assess-release.ts` `assessRelease`                       | read-only; two modes, nine components, no reused `runId` or epoch, no null epoch; `implementation` hard-coded `not_run`                |
| version-1 evidence  | `evidence.ts` `loadEnableEvidence`                        | rejects: "version-1 evidence cannot enable recovery; v2 admission required"                                                            |

Step 3 killed one sentence. The draft said replacing a qualification epoch "parks the affected
recovery at `manual`", carried over from CLAUDE.md invariant 26. `qualificationFence` does no such
thing on its own: it is a D1 assertion binding `c.epoch=?` from the lease, and a mismatch fails the
assertion. Parking takes two more steps, in `recovery-cron.ts`: the pass reports `suspended`, and
`recoverDeliveries` computes `manual = suspended || next >= r.deadline` and writes `state='manual'`
while nulling the session key. `dueRecoveries` selects `r.state='active'` only, so nothing picks it
up again. The section now describes all three steps.

That is the value of the rule. The claim was true at the outcome and wrong at the mechanism, and
only naming a file and symbol per sentence exposed the difference.

### Task 5: section 4.7, the testing matrix

Commit `5deefc7`. `npm run verify` exit 0.

Rewritten around the four suites, the two gates and the three rules, with every normative
requirement kept: the Message-ID preservation gate still governs whether 3.5's reconciliation is
enabled, the ten fault-injection checkpoints are still enumerated, the OAuth and web adversarial
classes are still listed, and the 25 MiB round trips still carry their 4.8 caveat. What went is the
unit inventory's provenance notes and its to-do-list cadence.

The draft's closing line claimed three stale test counts had been deleted from the section. Checked
against `git show HEAD:...`: the old 4.7 contained no test count at all. Corrected before the
commit and recorded in the gauntlet, because the rule about verifying a claim applies to one's own
sentences first.

### Task 6: the second gauntlet

Commit `be48995`. Record in
`docs/superpowers/reviews/2026-09-19-spec-reconciliation-gauntlet.md`.

Eleven claims swept, all eleven predicted to hold, eight did. Two stop-ships, both in 2.8 and both
misdescribing a permission boundary: the section claimed a real RFC 5322 parser where
`recipients.ts` is a deliberately restricted grammar that prefers false negatives, and it stated
`+tag` stripping flat where the code scopes it, together with local-part case folding, to
`gmail.com` and `googlemail.com` alone. One precision finding: 2.5's destructive list missed three
tools that carry `destructiveHint: true`. All four fixed in the document; no code changed.

## Closing

Eight tasks, eight commits, both gates green at each. The repair strand ran with the owner's
explicit authorization for the one act that touched live data, and the companion answers saves
again. The flake strand turned two intermittents into a reproduced failure and a measured verdict.
The documentation strand closed the three items the reconciliation left open and found four more
while closing them.

Nothing here closed any of the five external gates in 4.8, and nothing should have.

## End-to-end run, 2026-09-19

Driven at the owner's request after the eight tasks closed, against the real helper, the real CLI
and the real journal, with the deployed Worker answering `/healthz` with `ready`. Twenty-six
assertions, all passing on the final run. It found two defects on the way there, and both were in
this plan's own work.

**Phase A, the companion MCP surface over stdio.** `initialize`, `tools/list` returning exactly
`list_roots`, `save_attachment` and `stage_file`, and a `list_roots` call reporting `attachments`
as writable.

**Phase B, the debt lifecycle.** An occupied destination refuses the exclusive rename and leaves
the temporary; the destination is untouched; running `debt` collects the temporary and reports
nothing charged; a later save is admitted; failing again and removing the temporary by hand
condemns the receipt; the retained charge then refuses every later save with `spool_budget`; `debt`
prints the row with the exact release command including the scope; a wrong scope finds no receipt;
the release succeeds; a second release answers `Nothing charged.`; the receipt still reads
`publication_unknown`; and a fresh save prepares, publishes, acknowledges and leaves nothing
charged.

### E1. `debt` can never show a collectable temporary, and its remedy said otherwise

The first draft of the run asserted a row in state `verified` with `temporary: present` and the
remedy "start the companion". It got an empty listing instead, and the reason is structural:
answering `debt` spawns a helper, and `main.swift` calls `recoverStartup()` before the command loop
begins. The collection happens before the listing prints. Every collectable temporary is already
collected by the time the owner reads the output.

So the only row that can reach a listing with `temporary: present` is one the collector **refused**,
which needs the temporary to exist while failing to match the device and inode recorded at
creation. Reproduced by swapping the inode at the temporary's path:

```
debt.list: {"rows":[{"releasable":false,"scope":"plan7probe","handle":"sh_probe","bytes":26214400,
            "state":"verified","root":"attachments","temporary":"present"}]}
```

For that row, "start the companion; the helper collects this safely on startup" is advice that has
already been taken and has already failed. The text now says what is true: the helper ran with the
listing and left it, the temporary does not match the identity recorded at creation, nothing may
remove it safely, and the owner should report it rather than delete anything by hand. A native test
pins both halves, the collected case and the refused one.

### E2. `--release` without `--scope` printed `Refused: usage`

The guard was inside the branch's own `catch`, which matches a native error code against
`/^[a-z_]+$/`. "usage" matches, so a mistyped command was rendered as a refusal from the helper.
The check now sits outside the try, so it reaches `main()`'s handler and prints the usage line on
stderr. The companion CLI test asserts the empty stdout, the usage line and the exit code.

### An open finding, not fixed here

The refused-temporary row from E1 holds a charge that nothing can clear. `releaseDebt` accepts only
`publication_unknown`, and that row is `verified`, so the owner has no command for it: the same
class of problem this plan exists to end, reintroduced at a different state. Widening release
authority is a security-relevant change to a permission boundary and it owes its own design gate,
so it is recorded here rather than done in the middle of an end-to-end run. Reaching the state
needs a deliberate act, because it means creating a file at a path named by a UUID, which is why it
is a finding rather than an emergency.

### What the run touched

Two files were created under `~/Downloads/Gmail MCP` and both were removed; the owner's
`<owner attachment>.pdf` is the only file left there. The journal records the run created under the
scopes `plan7e2e` and `plan7probe` were deleted afterwards, which is the one hand-edit of owner
data in this plan and is recorded because the rule against hand-editing that journal is what caused
the original defect. No reservation was deleted by hand; every charge the run created was cleared
by `debt --release` or by the collector.

### Task 8's verdict, confirmed in the wild

The gate run immediately after this end-to-end failed with ten failures, every one of them
`Test timed out in 5000ms`: one companion case and nine qualification cases, all of them tests that
spawn a process. Nothing in the diff touched qualification. `uptime` read a load average of 38 with
an external `tar -tf` at 94 percent CPU, from something outside this work. Waiting for the machine
to fall below a load average of 8 and re-running gave exit 0 with 851 tests.

That is the contention verdict from Task 8 happening again, on a different set of tests, within an
hour of being written down. It is also why the entry in CLAUDE.md is worth its space: without it,
ten red tests across two workspaces reads as a regression in whatever was last edited.
