import Foundation
import XCTest

@testable import NativeCore

final class FileTests: XCTestCase {
  func fixture(_ run: (SafeFiles, URL, URL) throws -> Void) throws {
    let base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: base) }
    let root = base.appendingPathComponent("root")
    let priv = base.appendingPathComponent("private")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: priv, withIntermediateDirectories: true)
    let files = try SafeFiles(
      roots: ["attachments": RootGrant(path: root.path, read: true, write: true)], privateURL: priv)
    try run(files, root, priv)
  }
  func testExclusivePublicationAndDigest() throws {
    try fixture { files, root, _ in
      let data = Data("verified".utf8)
      let result = try files.save(
        root: "attachments", relative: "result.txt", bytes: data, sha256: SafeFiles.digest(data))
      XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("result.txt")), data)
      XCTAssertEqual(result.size, data.count)
      XCTAssertThrowsError(
        try files.save(
          root: "attachments", relative: "result.txt", bytes: Data("changed".utf8),
          sha256: SafeFiles.digest(Data("changed".utf8))))
      XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("result.txt")), data)
    }
  }
  func testTraversalAndSymlinkCannotPublish() throws {
    try fixture { files, root, priv in
      try FileManager.default.createSymbolicLink(
        at: root.appendingPathComponent("hop"), withDestinationURL: priv)
      for path in ["../escape", "hop/escape", "/absolute"] {
        XCTAssertThrowsError(
          try files.save(
            root: "attachments", relative: path, bytes: Data(), sha256: SafeFiles.digest(Data())))
      }
      XCTAssertFalse(
        FileManager.default.fileExists(atPath: priv.appendingPathComponent("escape").path))
    }
  }
  func testSnapshotRejectsSymlinkAndCapturesOriginalBytes() throws {
    try fixture { files, root, _ in
      let source = root.appendingPathComponent("source.txt")
      try Data("old".utf8).write(to: source)
      let snapshot = try files.snapshot(root: "attachments", relative: "source.txt", id: "snapshot")
      try Data("new".utf8).write(to: source)
      XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: snapshot.path)), Data("old".utf8))
      try FileManager.default.createSymbolicLink(
        at: root.appendingPathComponent("link"), withDestinationURL: source)
      XCTAssertThrowsError(try files.snapshot(root: "attachments", relative: "link", id: "bad"))
    }
  }
  func testPrivateOverlapRefused() throws {
    try fixture { _, root, priv in
      XCTAssertThrowsError(
        try SafeFiles(
          roots: ["bad": RootGrant(path: priv.path, read: true, write: false)], privateURL: priv))
      XCTAssertThrowsError(
        try SafeFiles(
          roots: [
            "bad": RootGrant(path: root.deletingLastPathComponent().path, read: true, write: true)
          ], privateURL: priv))
    }
  }
}
