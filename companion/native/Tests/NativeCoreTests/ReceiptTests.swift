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
}
