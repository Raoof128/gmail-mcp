import Foundation
import XCTest

@testable import NativeCore

private final class MemoryCredentials: CredentialStore {
  var refuseDelete = false
  var values: [String: Data] = [:]
  func read(account: String) throws -> Data? { values[account] }
  func write(account: String, data: Data) throws { values[account] = data }
  func delete(account: String) throws {
    if refuseDelete { throw NativeError.refused("simulated") }
    values.removeValue(forKey: account)
  }
}
final class AuthTests: XCTestCase {
  func testLogoutEpochRejectsAnOlderLoginCommit() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = MemoryCredentials()
    let journal = try Journal(path: dir.appendingPathComponent("j.db").path)
    let auth = AuthState(journal: journal, store: store)
    let epoch = try auth.epoch(account: "test")
    try auth.commit(account: "test", epoch: epoch, data: Data("test-only".utf8))
    try auth.logout(account: "test")
    XCTAssertNil(try store.read(account: "test"))
    XCTAssertThrowsError(try auth.commit(account: "test", epoch: epoch, data: Data("old".utf8)))
    XCTAssertNil(try store.read(account: "test"))
  }
  func testLogoutFenceSurvivesCredentialDeletionFailure() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = MemoryCredentials()
    let journal = try Journal(path: dir.appendingPathComponent("j.db").path)
    let auth = AuthState(journal: journal, store: store)
    try auth.commit(account: "test", epoch: auth.epoch(account: "test"), data: Data("test".utf8))
    store.refuseDelete = true
    XCTAssertThrowsError(try auth.logout(account: "test"))
    XCTAssertNil(try auth.read(account: "test"))
  }
  func testStableLockExcludesAnotherDescriptor() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let path = dir.appendingPathComponent("auth.lock").path
    var first: ProcessLock? = try ProcessLock(path: path, wait: false)
    XCTAssertThrowsError(try ProcessLock(path: path, wait: false))
    first = nil
    let next = try ProcessLock(path: path, wait: false)
    withExtendedLifetime(next) {}
    XCTAssertNil(first)
  }
}
