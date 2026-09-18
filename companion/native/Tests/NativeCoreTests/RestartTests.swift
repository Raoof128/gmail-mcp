import Foundation
import XCTest

@testable import NativeCore

/// Restarts that begin from each surviving combination of temporary file, published file and receipt.
/// Recovery has to be decided by the receipt and the verified identity behind it, never by the bare
/// existence of a file at the destination.
final class RestartTests: XCTestCase {
  private let bytes = Data("restart payload".utf8)
  private var digest: String { SafeFiles.digest(bytes) }

  private func saves(_ files: SafeFiles, _ priv: URL, _ name: String) throws -> SaveReceipts {
    SaveReceipts(files: files, journal: try Journal(path: priv.appendingPathComponent(name).path))
  }

  /// A failure between writing the temporary file and renaming it leaves nothing published, so
  /// recovery must hand back a retryable state rather than condemning the transfer. The exclusive
  /// rename supplies the failure without any test-only hook: an occupied destination refuses it while
  /// the temporary file is still intact. Recording the receipt as published before the rename would
  /// turn this into a permanent publication_unknown instead.
  func testFailureBeforeRenameStaysRetryable() throws {
    try FileTests().fixture { files, root, priv in
      let saves = try self.saves(files, priv, "retryable.db")
      let occupied = root.appendingPathComponent("a.txt")
      try Data("occupied".utf8).write(to: occupied)

      XCTAssertThrowsError(
        try saves.publish(
          scope: "owner", handle: "h", root: "attachments", relative: "a.txt", bytes: self.bytes,
          sha256: self.digest))
      XCTAssertEqual(try Data(contentsOf: occupied), Data("occupied".utf8))

      let recovered = try saves.recover(
        scope: "owner", handle: "h", root: "attachments", relative: "a.txt")
      XCTAssertEqual(recovered?.state, "prepared")

      // The temporary file is gone and the destination is untouched, so nothing is left charged.
      let leftovers = try FileManager.default.contentsOfDirectory(atPath: root.path)
        .filter { $0.hasPrefix(".gmail-mcp-") }
      XCTAssertEqual(leftovers, [])

      // Once the obstruction is removed the retry completes, which is the point of staying retryable.
      try FileManager.default.removeItem(at: occupied)
      let receipt = try saves.publish(
        scope: "owner", handle: "h", root: "attachments", relative: "a.txt", bytes: self.bytes,
        sha256: self.digest)
      XCTAssertEqual(receipt.state, "published")
      XCTAssertEqual(try Data(contentsOf: occupied), self.bytes)
    }
  }

  /// A publication that completed is established. If the destination later stops matching, the only
  /// honest answer is that its state is unknown; it must never quietly become permission to write
  /// there again.
  func testPublishedReceiptWithReplacedDestinationNeverReturnsToPrepared() throws {
    try FileTests().fixture { files, root, priv in
      let saves = try self.saves(files, priv, "replaced.db")
      let receipt = try saves.publish(
        scope: "owner", handle: "h", root: "attachments", relative: "a.txt", bytes: self.bytes,
        sha256: self.digest)
      XCTAssertEqual(receipt.state, "published")

      try Data("someone else wrote here".utf8).write(to: root.appendingPathComponent("a.txt"))

      for _ in 0..<2 {
        XCTAssertThrowsError(
          try saves.recover(scope: "owner", handle: "h", root: "attachments", relative: "a.txt")
        ) { error in
          guard case NativeError.refused(let reason) = error else { return XCTFail("wrong error") }
          XCTAssertEqual(reason, "publication_unknown")
        }
      }
      // And it stays refused rather than republishing over whatever is there now.
      XCTAssertThrowsError(
        try saves.publish(
          scope: "owner", handle: "h", root: "attachments", relative: "a.txt", bytes: self.bytes,
          sha256: self.digest))
      XCTAssertEqual(
        try Data(contentsOf: root.appendingPathComponent("a.txt")),
        Data("someone else wrote here".utf8))
    }
  }

  /// The same rule after the worker has been told the transfer is done. An acknowledged receipt whose
  /// destination has been removed must not reopen the transfer.
  func testAcknowledgedReceiptWithMissingDestinationNeverReturnsToPrepared() throws {
    try FileTests().fixture { files, root, priv in
      let saves = try self.saves(files, priv, "acked.db")
      _ = try saves.publish(
        scope: "owner", handle: "h", root: "attachments", relative: "a.txt", bytes: self.bytes,
        sha256: self.digest)
      let acked = try saves.acknowledge(
        scope: "owner", handle: "h", root: "attachments", relative: "a.txt")
      XCTAssertEqual(acked.state, "acknowledged")

      try FileManager.default.removeItem(at: root.appendingPathComponent("a.txt"))
      XCTAssertThrowsError(
        try saves.recover(scope: "owner", handle: "h", root: "attachments", relative: "a.txt")
      ) { error in
        guard case NativeError.refused(let reason) = error else { return XCTFail("wrong error") }
        XCTAssertEqual(reason, "publication_unknown")
      }
      XCTAssertThrowsError(
        try saves.acknowledge(scope: "owner", handle: "h", root: "attachments", relative: "a.txt"))
    }
  }

  /// A file at the destination with no receipt behind it proves nothing. The transfer is still owed,
  /// and the exclusive rename is what stops it from being overwritten.
  func testDestinationFileWithoutAReceiptIsNotTreatedAsSuccess() throws {
    try FileTests().fixture { files, root, priv in
      let saves = try self.saves(files, priv, "orphan.db")
      try Data("pre-existing content".utf8).write(to: root.appendingPathComponent("a.txt"))

      XCTAssertNil(
        try saves.recover(scope: "owner", handle: "h", root: "attachments", relative: "a.txt"))
      XCTAssertThrowsError(
        try saves.publish(
          scope: "owner", handle: "h", root: "attachments", relative: "a.txt", bytes: self.bytes,
          sha256: self.digest))
      XCTAssertEqual(
        try Data(contentsOf: root.appendingPathComponent("a.txt")),
        Data("pre-existing content".utf8))
    }
  }
}
