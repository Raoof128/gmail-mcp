import Darwin
import Foundation
import NativeCore

struct Command: Decodable {
  let op: String
  let scope: String?
  let key: String?
  let requestHash: String?
  let root: String?
  let path: String?
  let transfer_id: String?
  let mime: String?
  let handle: String?
  let sha256: String?
  let epoch: String?
  let payload: String?
}
func required(_ value: String?) throws -> String {
  guard let value, !value.isEmpty, value.utf8.count <= 4096 else {
    throw NativeError.refused("command_field")
  }
  return value
}
func json<T: Encodable>(_ value: T) throws -> Data { try JSONEncoder().encode(value) }
func reply(_ data: Data, body: Data = Data()) throws {
  try FileHandle.standardOutput.write(contentsOf: NativeFrame.encode(metadata: data, body: body))
}
func object(_ value: [String: Any]) throws -> Data {
  try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
}
struct Snapshot: Codable {
  var state: String
  let transfer_id: String
  let root: String
  let path: String
  let mime: String
  let created_at: Double
  var file: FileResult?
}
func run() throws {
  umask(0o077)
  guard
    ProcessInfo.processInfo.isOperatingSystemAtLeast(
      OperatingSystemVersion(majorVersion: 26, minorVersion: 6, patchVersion: 0))
  else { throw NativeError.refused("unsupported_macos") }
  let home = FileManager.default.homeDirectoryForCurrentUser.path
  let configDir = try PrivateState.directory(home + "/.config/gmail-mcp")
  let stateDir = try PrivateState.directory(home + "/Library/Application Support/gmail-mcp")
  let snapshots = try PrivateState.directory(stateDir + "/snapshots")
  let processLock = try ProcessLock(path: stateDir + "/companion.lock")
  defer { withExtendedLifetime(processLock) {} }
  if CommandLine.arguments.dropFirst().elementsEqual(["--init"]) {
    guard let frame = try NativeFrame.read(.standardInput), frame.body.isEmpty else {
      throw NativeError.refused("configuration_invalid")
    }
    let config = try JSONDecoder().decode(CompanionConfiguration.self, from: frame.metadata)
    try config.validate()
    for grant in config.roots.values where grant.write {
      if !FileManager.default.fileExists(atPath: grant.path) {
        try FileManager.default.createDirectory(
          atPath: grant.path, withIntermediateDirectories: true,
          attributes: [.posixPermissions: 0o700])
      }
    }
    _ = try SafeFiles(roots: config.roots, privateURL: URL(fileURLWithPath: stateDir))
    _ = try SafeFiles(roots: config.roots, privateURL: URL(fileURLWithPath: configDir))
    let target = configDir + "/config.json"
    let fd = open(target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW_ANY, 0o600)
    guard fd >= 0 else { throw NativeError.refused("configuration_exists") }
    defer { close(fd) }
    try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: json(config))
    try FileHandle(fileDescriptor: fd, closeOnDealloc: false).synchronize()
    _ = try PrivateState.directory(configDir)
    try reply(object(["ok": true]))
    return
  }
  guard CommandLine.arguments.count == 1 else { throw NativeError.refused("arguments") }
  let config = try PrivateState.readConfig(configDir + "/config.json")
  let files = try SafeFiles(roots: config.roots, privateURL: URL(fileURLWithPath: snapshots))
  _ = try SafeFiles(roots: config.roots, privateURL: URL(fileURLWithPath: stateDir))
  _ = try SafeFiles(roots: config.roots, privateURL: URL(fileURLWithPath: configDir))
  let journal = try Journal(path: stateDir + "/journal.sqlite")
  let auth = AuthState(journal: journal, store: KeychainCredentials())
  let account = SafeFiles.digest(Data((config.origin + "\u{0}" + config.client_id).utf8))
  let saves = SaveReceipts(files: files, journal: journal)
  try saves.recoverStartup()
  // The permanent process lock proves an earlier helper no longer owns these copies.
  let snapshotRows = try journal.entries(prefix: "snapshot:")
  var retainedIDs = Set<String>()
  for item in snapshotRows {
    var record = try JSONDecoder().decode(Snapshot.self, from: Data(item.record.payload.utf8))
    guard record.transfer_id.range(of: "^tr_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
    else { throw NativeError.refused("journal_integrity") }
    retainedIDs.insert(record.transfer_id)
    let target = snapshots + "/" + record.transfer_id
    if record.state == "preparing" || record.created_at + 900 <= Date().timeIntervalSince1970
      || (record.state == "ready" && !FileManager.default.fileExists(atPath: target))
    {
      guard unlink(target) == 0 || errno == ENOENT else {
        throw NativeError.refused("snapshot_cleanup")
      }
      record.state = record.state == "preparing" ? "failed" : "expired"
      try journal.put(
        scope: item.scope, key: item.key, requestHash: item.record.requestHash,
        payload: String(decoding: json(record), as: UTF8.self))
      try journal.release(id: record.transfer_id)
    }
    if ["expired", "failed", "released"].contains(record.state) {
      try journal.purgeRetained(
        scope: item.scope, key: item.key, now: Int(Date().timeIntervalSince1970))
    }
  }
  for id in try journal.snapshotReservations() where !retainedIDs.contains(id) {
    guard id.range(of: "^tr_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
      throw NativeError.refused("journal_integrity")
    }
    guard unlink(snapshots + "/" + id) == 0 || errno == ENOENT else {
      throw NativeError.refused("snapshot_cleanup")
    }
    try journal.release(id: id)
  }
  _ = try PrivateState.directory(snapshots)
  for item in try journal.entries(prefix: "transfer:") {
    try journal.purgeRetained(
      scope: item.scope, key: item.key, now: Int(Date().timeIntervalSince1970))
  }
  for item in try journal.entries(prefix: "save:") {
    let receipt = try JSONDecoder().decode(SaveReceipt.self, from: Data(item.record.payload.utf8))
    if receipt.state == "acknowledged" {
      try journal.purgeRetained(
        scope: item.scope, key: item.key, now: Int(Date().timeIntervalSince1970))
    }
  }
  while let frame = try NativeFrame.read(.standardInput) {
    do {
      let command = try JSONDecoder().decode(Command.self, from: frame.metadata)
      if command.op != "save.publish" && command.op != "auth.commit" && !frame.body.isEmpty {
        throw NativeError.refused("unexpected_body")
      }
      switch command.op {
      case "config": try reply(object(["origin": config.origin, "client_id": config.client_id]))
      case "roots":
        try reply(
          object([
            "roots": config.roots.sorted(by: { $0.key < $1.key }).map {
              ["id": $0.key, "read": $0.value.read, "write": $0.value.write] as [String: Any]
            }
          ]))
      case "auth.begin":
        try reply(
          object(["epoch": try auth.epoch(account: account)]),
          body: auth.read(account: account) ?? Data())
      case "auth.commit":
        try auth.commit(account: account, epoch: required(command.epoch), data: frame.body)
        try reply(object(["ok": true]))
      case "auth.logout":
        try auth.logout(account: account)
        try reply(object(["ok": true]))
      case "journal.get":
        let record = try journal.get(
          scope: "transfer:" + required(command.scope), key: required(command.key))
        try reply(
          object(record.map { ["requestHash": $0.requestHash, "payload": $0.payload] } ?? [:]))
      case "journal.put":
        try journal.put(
          scope: "transfer:" + required(command.scope), key: required(command.key),
          requestHash: required(command.requestHash), payload: required(command.payload))
        try reply(object(["ok": true]))
      case "snapshot.prepare":
        let scope = "snapshot:" + (try required(command.scope))
        let key = try required(command.key)
        let hash = try required(command.requestHash)
        if let old = try journal.get(scope: scope, key: key) {
          guard old.requestHash == hash else { throw NativeError.refused("idempotency_conflict") }
          try reply(Data(old.payload.utf8))
          continue
        }
        let id = try required(command.transfer_id)
        let root = try required(command.root)
        let path = try required(command.path)
        let mime = try required(command.mime)
        guard id.range(of: "^tr_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
          throw NativeError.refused("transfer_id")
        }
        try PrivateState.freeSpace(snapshots)
        try journal.reserve(id: id, bytes: SafeFiles.maximum, maximum: 100 * 1024 * 1024, count: 4)
        var record = Snapshot(
          state: "preparing", transfer_id: id, root: root, path: path, mime: mime,
          created_at: Date().timeIntervalSince1970, file: nil)
        try journal.put(
          scope: scope, key: key, requestHash: hash,
          payload: String(decoding: json(record), as: UTF8.self))
        do {
          record.file = try files.snapshot(root: root, relative: path, id: id)
          record.state = "ready"
        } catch {
          record.state = "failed"
          try journal.put(
            scope: scope, key: key, requestHash: hash,
            payload: String(decoding: json(record), as: UTF8.self))
          try journal.release(id: id)
          throw error
        }
        try journal.put(
          scope: scope, key: key, requestHash: hash,
          payload: String(decoding: json(record), as: UTF8.self))
        try reply(json(record))
      case "snapshot.read", "snapshot.check":
        guard
          let old = try journal.get(
            scope: "snapshot:" + required(command.scope), key: required(command.key))
        else { throw NativeError.refused("snapshot_missing") }
        let record = try JSONDecoder().decode(Snapshot.self, from: Data(old.payload.utf8))
        guard record.state == "ready", let file = record.file,
          record.created_at + 900 > Date().timeIntervalSince1970
        else { throw NativeError.refused("snapshot_expired") }
        let fd = open(file.path, O_RDONLY | O_NOFOLLOW_ANY | O_NONBLOCK)
        guard fd >= 0 else { throw NativeError.refused("snapshot_missing") }
        defer { close(fd) }
        var st = stat()
        guard fstat(fd, &st) == 0, UInt64(st.st_dev) == file.device,
          UInt64(st.st_ino) == file.inode, st.st_size == file.size, st.st_nlink == 1
        else { throw NativeError.refused("snapshot_changed") }
        let data =
          try FileHandle(fileDescriptor: fd, closeOnDealloc: false).read(
            upToCount: SafeFiles.maximum + 1) ?? Data()
        guard data.count == file.size, SafeFiles.digest(data) == file.sha256 else {
          throw NativeError.refused("snapshot_changed")
        }
        try reply(object(["ok": true]), body: command.op == "snapshot.read" ? data : Data())
      case "snapshot.release":
        let scope = "snapshot:" + (try required(command.scope))
        let key = try required(command.key)
        guard let old = try journal.get(scope: scope, key: key) else {
          throw NativeError.refused("snapshot_missing")
        }
        var record = try JSONDecoder().decode(Snapshot.self, from: Data(old.payload.utf8))
        if let file = record.file {
          guard unlink(file.path) == 0 || errno == ENOENT else {
            throw NativeError.refused("snapshot_cleanup")
          }
        }
        record.state = "released"
        try journal.put(
          scope: scope, key: key, requestHash: old.requestHash,
          payload: String(decoding: json(record), as: UTF8.self))
        try journal.release(id: record.transfer_id)
        try reply(object(["ok": true]))
      case "save.prepare":
        let root = try required(command.root)
        guard let grant = config.roots[root], grant.write else {
          throw NativeError.refused("root_permission")
        }
        try PrivateState.freeSpace(grant.path)
        try reply(
          json(
            saves.prepare(
              scope: required(command.scope), handle: required(command.handle), root: root,
              relative: required(command.path))))
      case "save.publish":
        try reply(
          json(
            saves.publish(
              scope: required(command.scope), handle: required(command.handle),
              root: required(command.root), relative: required(command.path), bytes: frame.body,
              sha256: required(command.sha256))))
      case "save.ack":
        try reply(
          json(
            saves.acknowledge(
              scope: required(command.scope), handle: required(command.handle),
              root: required(command.root), relative: required(command.path))))
      default: throw NativeError.refused("unknown_command")
      }
    } catch {
      let code: String
      if case NativeError.refused(let value) = error {
        code = value
      } else {
        code = "native_operation_failed"
      }
      try reply(object(["error": code]))
    }
  }
}
do { try run() } catch {
  // Never print input, paths, tokens, or framework error descriptions.
  try? reply(object(["error": "native_startup_failed"]))
  exit(1)
}
