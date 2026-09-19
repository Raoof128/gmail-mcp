import Foundation
import XCTest

@testable import NativeCore

final class ReceiptTests: XCTestCase {
  func testSaveBudgetIsDurableAndReleasedAfterSafeRecovery() throws {
    try FileTests().fixture { files, _, priv in
      let journal = try Journal(path: priv.appendingPathComponent("budget.db").path)
      let saves = SaveReceipts(files: files, journal: journal)
      _ = try saves.prepare(scope: "owner", handle: "one", root: "attachments", relative: "one.txt")
      XCTAssertThrowsError(
        try saves.prepare(scope: "owner", handle: "two", root: "attachments", relative: "two.txt"))
      _ = try saves.recover(scope: "owner", handle: "one", root: "attachments", relative: "one.txt")
      _ = try saves.prepare(scope: "owner", handle: "two", root: "attachments", relative: "two.txt")
    }
  }

  func testCrashAfterRenameRecoversIdentityWithoutOverwriting() throws {
    try FileTests().fixture { files, root, priv in
      let j = try Journal(path: priv.appendingPathComponent("receipts.db").path)
      let saves = SaveReceipts(files: files, journal: j)
      let bytes = Data("verified".utf8)
      XCTAssertThrowsError(
        try saves.publish(
          scope: "owner", handle: "handle", root: "attachments", relative: "a.txt", bytes: bytes,
          sha256: SafeFiles.digest(bytes), afterPublish: { throw NativeError.refused("crash") }))
      let result = try saves.recover(
        scope: "owner", handle: "handle", root: "attachments", relative: "a.txt")
      XCTAssertEqual(result?.state, "published")
      XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("a.txt")), bytes)
    }
  }
  func testChangedDestinationDoesNotBecomeAcknowledgable() throws {
    try FileTests().fixture { files, root, priv in
      let saves = SaveReceipts(
        files: files, journal: try Journal(path: priv.appendingPathComponent("r.db").path))
      let bytes = Data("verified".utf8)
      XCTAssertThrowsError(
        try saves.publish(
          scope: "owner", handle: "handle", root: "attachments", relative: "a.txt", bytes: bytes,
          sha256: SafeFiles.digest(bytes), afterPublish: { throw NativeError.refused("crash") }))
      try Data("different".utf8).write(to: root.appendingPathComponent("a.txt"))
      XCTAssertThrowsError(
        try saves.recover(scope: "owner", handle: "handle", root: "attachments", relative: "a.txt"))
      XCTAssertThrowsError(
        try saves.recover(scope: "owner", handle: "handle", root: "attachments", relative: "b.txt"))
    }
  }

  /// The production route to a permanently charged receipt, reproduced rather than simulated. An
  /// occupied destination refuses the exclusive rename and leaves the temporary behind; removing
  /// that temporary by hand is what stops recoverStartup from ever clearing the charge.
  func testUnresolvedDebtListsTheChargeAHandDeletedTemporaryLeaves() throws {
    try FileTests().fixture { files, root, priv in
      let journal = try Journal(path: priv.appendingPathComponent("debt.db").path)
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

  /// Releasing repairs accounting and nothing else. The receipt still says publication_unknown
  /// afterwards, because dropping a charge learns nothing about the destination.
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

      let row = try XCTUnwrap(journal.get(scope: "save:s", key: "h"))
      let after = try JSONDecoder().decode(SaveReceipt.self, from: Data(row.payload.utf8))
      XCTAssertEqual(after.state, "publication_unknown")

      // A second release is not a second success, and an absent receipt says so plainly.
      XCTAssertEqual(try saves.releaseDebt(scope: "s", handle: "h"), .notCharged)
      XCTAssertEqual(try saves.releaseDebt(scope: "s", handle: "absent"), .noSuchReceipt)
    }
  }

  /// The collector can still check the device and inode it recorded here, so the charge is its
  /// job and not a human's. The listing says so rather than offering a release.
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

  /// Something else takes the temporary's name after the receipt is condemned. The collector
  /// refuses it on device and inode, and so must a human release: dropping the charge here would
  /// leave a file nobody accounts for.
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

      try Data("not ours".utf8).write(to: root.appendingPathComponent(temp))
      XCTAssertThrowsError(try saves.releaseDebt(scope: "s", handle: "h")) { error in
        guard case NativeError.refused(let reason) = error else { return XCTFail("\(error)") }
        XCTAssertEqual(reason, "temporary_still_present")
      }
    }
  }

  /// The only way a temporary survives to be listed. recoverStartup runs on every helper start,
  /// including the one that answers `debt`, so a collectable temporary is collected before any
  /// listing prints. What reaches a listing is a temporary the collector refused: one whose inode
  /// no longer matches the identity recorded at creation. Found by an end-to-end run, not by
  /// reasoning: the first draft of that run asserted a collectable row and got an empty listing.
  func testACollectedTemporaryLeavesNoDebtAndARefusedOneRemains() throws {
    try FileTests().fixture { files, root, priv in
      let saves = SaveReceipts(
        files: files, journal: try Journal(path: priv.appendingPathComponent("collected.db").path))
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

      // Our own temporary: the collector verifies device and inode, removes it, and frees the
      // charge, so nothing is left to list.
      try saves.recoverStartup()
      XCTAssertTrue(try saves.unresolvedDebt().isEmpty)
      XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(temp).path))

      // Now the case that does survive. Re-run the failure, then swap the inode at the temporary's
      // path so the collector refuses it on every pass.
      XCTAssertThrowsError(
        try saves.publish(
          scope: "s", handle: "h2", root: "attachments", relative: "a.txt", bytes: bytes,
          sha256: SafeFiles.digest(bytes)))
      let temp2 = try XCTUnwrap(
        FileManager.default.contentsOfDirectory(atPath: root.path).first {
          $0.hasPrefix(".gmail-mcp-")
        })
      try FileManager.default.removeItem(at: root.appendingPathComponent(temp2))
      try Data("not ours".utf8).write(to: root.appendingPathComponent(temp2))

      try saves.recoverStartup()
      let debt = try saves.unresolvedDebt()
      XCTAssertEqual(debt.count, 1)
      XCTAssertEqual(debt[0].state, "verified")
      XCTAssertEqual(debt[0].temporary, "present")
      XCTAssertFalse(debt[0].releasable)

      // And it stays: a second collection pass changes nothing, so telling the owner to start the
      // companion would be advice that has already been taken.
      try saves.recoverStartup()
      XCTAssertEqual(try saves.unresolvedDebt().count, 1)
    }
  }
}
