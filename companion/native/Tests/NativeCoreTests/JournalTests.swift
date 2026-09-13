import Foundation
import XCTest

@testable import NativeCore

final class JournalTests: XCTestCase {
  func testRestartAndKeyBinding() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let db = dir.appendingPathComponent("journal.sqlite")
    do {
      let j = try Journal(path: db.path)
      try j.put(scope: "owner1", key: "key", requestHash: "source1", payload: "verified")
      XCTAssertThrowsError(
        try j.put(scope: "owner1", key: "key", requestHash: "source2", payload: "wrong"))
    }
    let j = try Journal(path: db.path)
    XCTAssertEqual(try j.get(scope: "owner1", key: "key")?.payload, "verified")
    XCTAssertNil(try j.get(scope: "owner2", key: "key"))
  }
  func testBudgetReservationDoesNotOverbook() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let a = try Journal(path: dir.appendingPathComponent("j.db").path)
    let b = try Journal(path: dir.appendingPathComponent("j.db").path)
    try a.reserve(id: "one", bytes: 100, maximum: 100, count: 1)
    XCTAssertThrowsError(try b.reserve(id: "two", bytes: 1, maximum: 100, count: 1))
    try a.release(id: "one")
    try b.reserve(id: "two", bytes: 1, maximum: 100, count: 1)
  }
}
