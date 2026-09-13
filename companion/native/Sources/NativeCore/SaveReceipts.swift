import Foundation

public struct SaveReceipt: Codable, Sendable {
  public var state: String
  public let root: String
  public let relative: String
  public var file: FileResult?
  public var temporary: String?
  public var created: FileResult?
}
/// The caller holds the process lock through preparation, GET, publication and ACK.
public final class SaveReceipts {
  private let files: SafeFiles
  private let journal: Journal
  public init(files: SafeFiles, journal: Journal) {
    self.files = files
    self.journal = journal
  }
  private func requestHash(root: String, relative: String) -> String {
    SafeFiles.digest(Data((root + "\u{0}" + relative).utf8))
  }
  private func reservation(_ scope: String, _ handle: String) -> String {
    "save:" + SafeFiles.digest(Data((scope + "\u{0}" + handle).utf8))
  }
  private func persist(scope: String, handle: String, receipt: SaveReceipt) throws {
    try journal.put(
      scope: "save:" + scope, key: handle,
      requestHash: requestHash(root: receipt.root, relative: receipt.relative),
      payload: String(decoding: JSONEncoder().encode(receipt), as: UTF8.self))
  }
  public func recover(scope: String, handle: String, root: String, relative: String) throws
    -> SaveReceipt?
  {
    guard let row = try journal.get(scope: "save:" + scope, key: handle) else { return nil }
    guard row.requestHash == requestHash(root: root, relative: relative) else {
      throw NativeError.refused("idempotency_conflict")
    }
    var receipt = try JSONDecoder().decode(SaveReceipt.self, from: Data(row.payload.utf8))
    if let file = receipt.file {
      do {
        try files.verify(root: root, relative: relative, expected: file)
        if receipt.state != "acknowledged" {
          receipt.state = "published"
          try persist(scope: scope, handle: handle, receipt: receipt)
        }
        try journal.release(id: reservation(scope, handle))
        return receipt
      } catch {
        // An established publication can never turn into permission to replace the destination.
        if receipt.state == "published" || receipt.state == "acknowledged"
          || receipt.state == "publication_unknown"
        {
          receipt.state = "publication_unknown"
          try persist(scope: scope, handle: handle, receipt: receipt)
          throw NativeError.refused("publication_unknown")
        }
      }
    }
    // Before publication, remove only the inode recorded at creation. A file created
    // just before a crash without that identity remains charged for owner repair.
    let discarded =
      try receipt.temporary.map {
        try files.discardTemporary(root: root, path: $0, expected: receipt.created)
      } ?? false
    if receipt.file != nil && !discarded {
      receipt.state = "publication_unknown"
      try persist(scope: scope, handle: handle, receipt: receipt)
      throw NativeError.refused("publication_unknown")
    }
    receipt.state = "prepared"
    receipt.created = nil
    receipt.file = nil
    try persist(scope: scope, handle: handle, receipt: receipt)
    try journal.release(id: reservation(scope, handle))
    return receipt
  }
  public func prepare(scope: String, handle: String, root: String, relative: String) throws
    -> SaveReceipt
  {
    let old = try recover(scope: scope, handle: handle, root: root, relative: relative)
    if let old, old.state != "prepared" { return old }
    try journal.reserve(
      id: reservation(scope, handle), bytes: SafeFiles.maximum, maximum: SafeFiles.maximum,
      count: 1, kind: "save")
    let parent = (relative as NSString).deletingLastPathComponent
    let receipt =
      old
      ?? SaveReceipt(
        state: "prepared", root: root, relative: relative, file: nil,
        temporary: (parent.isEmpty ? "" : parent + "/") + ".gmail-mcp-" + UUID().uuidString,
        created: nil)
    try persist(scope: scope, handle: handle, receipt: receipt)
    return receipt
  }
  public func publish(
    scope: String, handle: String, root: String, relative: String, bytes: Data, sha256: String,
    afterPublish: (() throws -> Void)? = nil
  ) throws -> SaveReceipt {
    var receipt = try prepare(scope: scope, handle: handle, root: root, relative: relative)
    if receipt.state != "prepared" { return receipt }
    let file = try files.save(
      root: root, relative: relative, bytes: bytes, sha256: sha256,
      beforePublish: { file in
        receipt.file = file
        receipt.state = "verified"
        try self.persist(scope: scope, handle: handle, receipt: receipt)
      }, temporary: receipt.temporary,
      afterCreate: { file in
        receipt.created = file
        try self.persist(scope: scope, handle: handle, receipt: receipt)
      })
    try afterPublish?()
    receipt.file = file
    receipt.state = "published"
    try persist(scope: scope, handle: handle, receipt: receipt)
    try journal.release(id: reservation(scope, handle))
    return receipt
  }
  public func acknowledge(scope: String, handle: String, root: String, relative: String) throws
    -> SaveReceipt
  {
    guard var receipt = try recover(scope: scope, handle: handle, root: root, relative: relative),
      receipt.state == "published" || receipt.state == "acknowledged"
    else { throw NativeError.refused("publication_unknown") }
    receipt.state = "acknowledged"
    try persist(scope: scope, handle: handle, receipt: receipt)
    return receipt
  }
  public func recoverStartup() throws {
    for item in try journal.entries(prefix: "save:") {
      let receipt = try JSONDecoder().decode(SaveReceipt.self, from: Data(item.record.payload.utf8))
      // Preserve unknown records and reservations; never free them on an unsuccessful inspection.
      _ = try? recover(
        scope: String(item.scope.dropFirst(5)), handle: item.key, root: receipt.root,
        relative: receipt.relative)
    }
  }
}
