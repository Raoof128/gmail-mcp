import CSQLite
import Darwin
import Foundation

public struct JournalRecord: Codable, Sendable {
  public let requestHash: String
  public let payload: String
}
public final class Journal {
  private var db: OpaquePointer?
  public init(path inputPath: String) throws {
    let path =
      try physicalPath((inputPath as NSString).deletingLastPathComponent) + "/"
      + (inputPath as NSString).lastPathComponent
    guard
      sqlite3_open_v2(
        path, &db,
        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW,
        nil) == SQLITE_OK
    else { throw NativeError.refused("journal_open") }
    guard chmod(path, 0o600) == 0 else {
      sqlite3_close(db)
      throw NativeError.system("journal_permissions", errno)
    }
    sqlite3_busy_timeout(db, 30_000)
    do {
      try execute("PRAGMA journal_mode=WAL")
      try execute("PRAGMA synchronous=FULL")
      try execute("PRAGMA fullfsync=ON")
      try execute("PRAGMA checkpoint_fullfsync=ON")
      try execute("PRAGMA foreign_keys=ON")
      try execute(
        "CREATE TABLE IF NOT EXISTS records(scope TEXT NOT NULL,key TEXT NOT NULL,request_hash TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(scope,key))"
      )
      try execute(
        "CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,bytes INTEGER NOT NULL CHECK(bytes>=0))"
      )
      guard try scalar("PRAGMA synchronous") == "2", try scalar("PRAGMA fullfsync") == "1",
        try scalar("PRAGMA journal_mode") == "wal",
        try scalar("PRAGMA checkpoint_fullfsync") == "1", try scalar("PRAGMA foreign_keys") == "1",
        try scalar("PRAGMA quick_check") == "ok"
      else { throw NativeError.refused("journal_integrity") }
      let directory = open(
        (path as NSString).deletingLastPathComponent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY)
      guard directory >= 0 else { throw NativeError.refused("journal_directory") }
      defer { close(directory) }
      guard fsync(directory) == 0 else { throw NativeError.refused("journal_directory_sync") }
    } catch {
      sqlite3_close(db)
      db = nil
      throw error
    }
  }
  deinit { sqlite3_close(db) }
  private func prepared(_ sql: String, _ values: [String]) throws -> OpaquePointer {
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
      throw NativeError.refused("journal_prepare")
    }
    let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    for (i, value) in values.enumerated() {
      guard
        sqlite3_bind_text(stmt, Int32(i + 1), value, Int32(value.utf8.count), transient)
          == SQLITE_OK
      else {
        sqlite3_finalize(stmt)
        throw NativeError.refused("journal_bind")
      }
    }
    return stmt
  }
  private func execute(_ sql: String, _ values: [String] = []) throws {
    let stmt = try prepared(sql, values)
    defer { sqlite3_finalize(stmt) }
    var result = sqlite3_step(stmt)
    while result == SQLITE_ROW { result = sqlite3_step(stmt) }
    guard result == SQLITE_DONE else { throw NativeError.refused("journal_write") }
  }
  private func scalar(_ sql: String, _ values: [String] = []) throws -> String? {
    let stmt = try prepared(sql, values)
    defer { sqlite3_finalize(stmt) }
    let result = sqlite3_step(stmt)
    if result == SQLITE_DONE { return nil }
    guard result == SQLITE_ROW else { throw NativeError.refused("journal_read") }
    guard let text = sqlite3_column_text(stmt, 0) else { return nil }
    return String(cString: text)
  }
  public func get(scope: String, key: String) throws -> JournalRecord? {
    guard !scope.contains("\0"), !key.contains("\0") else {
      throw NativeError.refused("journal_key")
    }
    let stmt = try prepared(
      "SELECT request_hash,payload FROM records WHERE scope=? AND key=?", [scope, key])
    defer { sqlite3_finalize(stmt) }
    let result = sqlite3_step(stmt)
    if result == SQLITE_DONE { return nil }
    guard result == SQLITE_ROW, let hash = sqlite3_column_text(stmt, 0),
      let payload = sqlite3_column_text(stmt, 1)
    else { throw NativeError.refused("journal_read") }
    return JournalRecord(requestHash: String(cString: hash), payload: String(cString: payload))
  }
  public func put(scope: String, key: String, requestHash: String, payload: String) throws {
    guard !scope.contains("\0"), !key.contains("\0"), !requestHash.contains("\0"),
      !payload.contains("\0")
    else { throw NativeError.refused("journal_key") }
    guard scope.utf8.count <= 1024, key.utf8.count <= 1024, payload.utf8.count <= 65536 else {
      throw NativeError.refused("journal_size")
    }
    try execute("BEGIN IMMEDIATE")
    do {
      if let old = try get(scope: scope, key: key) {
        guard old.requestHash == requestHash else {
          throw NativeError.refused("idempotency_conflict")
        }
      } else {
        guard Int(try scalar("SELECT count(*) FROM records") ?? "1000")! < 1000 else {
          throw NativeError.refused("receipt_budget")
        }
      }
      guard
        Int(
          try scalar(
            "SELECT coalesce(sum(length(CAST(payload AS BLOB))+length(CAST(scope AS BLOB))+length(CAST(key AS BLOB))+256),0) FROM records"
          ) ?? "0")! + payload.utf8.count + scope.utf8.count + key.utf8.count + 256 <= 16 * 1024
          * 1024
      else { throw NativeError.refused("receipt_budget") }
      try execute(
        "INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET payload=excluded.payload",
        [scope, key, requestHash, payload, String(Int(Date().timeIntervalSince1970))])
      try execute("COMMIT")
    } catch {
      try? execute("ROLLBACK")
      throw error
    }
  }
  public func reserve(id: String, bytes: Int, maximum: Int, count: Int, kind: String = "snapshot")
    throws
  {
    guard bytes >= 0, bytes <= maximum else { throw NativeError.refused("spool_budget") }
    try execute("BEGIN IMMEDIATE")
    do {
      if let old = try scalar("SELECT bytes FROM reservations WHERE id=?", [id]) {
        guard old == String(bytes) else { throw NativeError.refused("reservation_conflict") }
      } else {
        let used = Int(
          try scalar(
            "SELECT coalesce(sum(bytes),0) FROM reservations WHERE (id LIKE 'save:%') = CAST(? AS INTEGER)",
            [kind == "save" ? "1" : "0"]) ?? "0")!
        let n = Int(
          try scalar(
            "SELECT count(*) FROM reservations WHERE (id LIKE 'save:%') = CAST(? AS INTEGER)",
            [kind == "save" ? "1" : "0"]) ?? "0")!
        guard used + bytes <= maximum, n < count else { throw NativeError.refused("spool_budget") }
        try execute("INSERT INTO reservations VALUES(?,?)", [id, String(bytes)])
      }
      try execute("COMMIT")
    } catch {
      try? execute("ROLLBACK")
      throw error
    }
  }
  public func release(id: String) throws {
    try execute("DELETE FROM reservations WHERE id=?", [id])
  }
  public func entries(prefix: String) throws -> [(
    scope: String, key: String, record: JournalRecord
  )] {
    let stmt = try prepared(
      "SELECT scope,key,request_hash,payload FROM records WHERE substr(scope,1,?)=?",
      [String(prefix.count), prefix])
    defer { sqlite3_finalize(stmt) }
    var out: [(scope: String, key: String, record: JournalRecord)] = []
    while true {
      let result = sqlite3_step(stmt)
      if result == SQLITE_DONE { return out }
      guard result == SQLITE_ROW else { throw NativeError.refused("journal_read") }
      let fields = (0..<4).map { String(cString: sqlite3_column_text(stmt, Int32($0))!) }
      out.append(
        (
          scope: fields[0], key: fields[1],
          record: JournalRecord(requestHash: fields[2], payload: fields[3])
        ))
    }
  }

  public func snapshotReservations() throws -> [String] {
    let stmt = try prepared("SELECT id FROM reservations WHERE id NOT LIKE 'save:%'", [])
    defer { sqlite3_finalize(stmt) }
    var out: [String] = []
    while true {
      let result = sqlite3_step(stmt)
      if result == SQLITE_DONE { return out }
      guard result == SQLITE_ROW, let value = sqlite3_column_text(stmt, 0) else {
        throw NativeError.refused("journal_read")
      }
      out.append(String(cString: value))
    }
  }
  public func purgeRetained(scope: String, key: String, now: Int) throws {
    guard !scope.hasPrefix("auth_") else { throw NativeError.refused("retention_scope") }
    try execute(
      "DELETE FROM records WHERE scope=? AND key=? AND created_at<=CAST(? AS INTEGER)",
      [scope, key, String(now - 7 * 86400)])
  }

}
