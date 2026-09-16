import Darwin
import Foundation
import XCTest

@testable import NativeCore

final class RaceTests: XCTestCase {
  func testRootReplacementBeforePublicationRefuses() throws {
    try FileTests().fixture { files, root, _ in
      let data = Data("verified".utf8)
      XCTAssertThrowsError(
        try files.save(
          root: "attachments", relative: "result", bytes: data,
          sha256: SafeFiles.digest(data),
          beforePublish: { _ in
            try FileManager.default.moveItem(at: root, to: root.appendingPathExtension("moved"))
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
          }))
      XCTAssertFalse(
        FileManager.default.fileExists(atPath: root.appendingPathComponent("result").path))
    }
  }
  func testTemporaryReplacementNeverReturnsVerifiedReceipt() throws {
    try FileTests().fixture { files, root, _ in
      let data = Data("verified".utf8)
      let temporary = ".gmail-mcp-11111111-1111-4111-8111-111111111111"
      XCTAssertThrowsError(
        try files.save(
          root: "attachments", relative: "result", bytes: data,
          sha256: SafeFiles.digest(data),
          beforePublish: { _ in
            let path = root.appendingPathComponent(temporary)
            try FileManager.default.removeItem(at: path)
            try Data("replaced".utf8).write(to: path)
          }, temporary: temporary))
      XCTAssertEqual(
        try Data(contentsOf: root.appendingPathComponent(temporary)), Data("replaced".utf8))
    }
  }
  func testTemporaryModificationNeverReturnsVerifiedReceipt() throws {
    try FileTests().fixture { files, root, _ in
      let data = Data("verified".utf8)
      let temporary = ".gmail-mcp-11111111-1111-4111-8111-111111111111"
      XCTAssertThrowsError(
        try files.save(
          root: "attachments", relative: "result", bytes: data,
          sha256: SafeFiles.digest(data),
          beforePublish: { _ in
            try Data("changed!".utf8).write(to: root.appendingPathComponent(temporary))
          }, temporary: temporary))
    }
  }
  func testParentSymlinkSwapCannotPublishOutsideRoot() throws {
    try FileTests().fixture { files, root, priv in
      let parent = root.appendingPathComponent("parent")
      try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false)
      let data = Data("verified".utf8)
      XCTAssertThrowsError(
        try files.save(
          root: "attachments", relative: "parent/result", bytes: data,
          sha256: SafeFiles.digest(data),
          beforePublish: { _ in
            try FileManager.default.moveItem(at: parent, to: root.appendingPathComponent("old"))
            try FileManager.default.createSymbolicLink(at: parent, withDestinationURL: priv)
          }))
      XCTAssertFalse(
        FileManager.default.fileExists(atPath: priv.appendingPathComponent("result").path))
    }
  }
  func testHardlinkedSourceAndChangedPublishedFileRefuse() throws {
    try FileTests().fixture { files, root, _ in
      let data = Data("verified".utf8)
      let source = root.appendingPathComponent("source")
      try data.write(to: source)
      XCTAssertEqual(link(source.path, root.appendingPathComponent("linked").path), 0)
      XCTAssertThrowsError(
        try files.snapshot(root: "attachments", relative: "source", id: "snapshot"))
      let saved = try files.save(
        root: "attachments", relative: "published", bytes: data, sha256: SafeFiles.digest(data))
      try Data("changed".utf8).write(to: root.appendingPathComponent("published"))
      XCTAssertThrowsError(
        try files.verify(root: "attachments", relative: "published", expected: saved))
    }
  }
}
