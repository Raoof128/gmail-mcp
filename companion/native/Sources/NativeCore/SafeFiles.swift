import CNative
import CryptoKit
import Darwin
import Foundation

public enum NativeError: Error {
  case refused(String)
  case system(String, Int32)
}
public struct RootGrant: Codable, Sendable {
  public let path: String
  public let read: Bool
  public let write: Bool
  public init(path: String, read: Bool, write: Bool) {
    self.path = path
    self.read = read
    self.write = write
  }
}
public struct FileResult: Codable, Sendable {
  public let path: String
  public let size: Int
  public let sha256: String
  public let device: UInt64
  public let inode: UInt64
}
func physicalPath(_ path: String) throws -> String {
  guard let resolved = realpath(path, nil) else { throw NativeError.system("realpath", errno) }
  defer { free(resolved) }
  return String(cString: resolved)
}
private final class Root {
  let fd: Int32
  let grant: RootGrant
  let path: String
  let dev: dev_t
  let ino: ino_t
  init(_ grant: RootGrant) throws {
    self.grant = grant
    self.path = try physicalPath(grant.path)
    fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY)
    guard fd >= 0 else { throw NativeError.system("root_open", errno) }
    var st = stat()
    guard fstat(fd, &st) == 0 else {
      close(fd)
      throw NativeError.system("root_stat", errno)
    }
    var volume = statfs()
    guard fstatfs(fd, &volume) == 0, volume.f_flags & UInt32(MNT_LOCAL) != 0, st.st_uid == getuid(),
      st.st_mode & 0o022 == 0
    else {
      close(fd)
      throw NativeError.refused("unsupported_root")
    }
    let type = withUnsafePointer(to: &volume.f_fstypename) { pointer in
      pointer.withMemoryRebound(to: CChar.self, capacity: 16) { String(cString: $0) }
    }
    guard type == "apfs" || type == "hfs" else {
      close(fd)
      throw NativeError.refused("unsupported_volume")
    }
    dev = st.st_dev
    ino = st.st_ino
  }
  deinit { close(fd) }
  func check() throws {
    var st = stat()
    guard lstat(path, &st) == 0, st.st_dev == dev, st.st_ino == ino, st.st_mode & S_IFMT == S_IFDIR
    else { throw NativeError.refused("root_changed") }
  }
}
public final class SafeFiles {
  private let roots: [String: Root]
  private let privateURL: URL
  private static func ancestry(_ path: String) throws -> Set<String> {
    var value = path
    var result = Set<String>()
    while true {
      var st = stat()
      guard lstat(value, &st) == 0 else { throw NativeError.refused("ancestry") }
      result.insert("\(st.st_dev):\(st.st_ino)")
      if value == "/" { return result }
      value = (value as NSString).deletingLastPathComponent
    }
  }
  public static let maximum = 25 * 1024 * 1024
  public init(roots: [String: RootGrant], privateURL: URL) throws {
    self.privateURL = URL(fileURLWithPath: try physicalPath(privateURL.path))
    var opened: [String: Root] = [:]
    for (id, grant) in roots {
      let root = try Root(grant)
      let privateAncestors = try Self.ancestry(self.privateURL.path)
      let rootAncestors = try Self.ancestry(root.path)
      var privateStat = stat()
      guard lstat(self.privateURL.path, &privateStat) == 0 else {
        throw NativeError.refused("private_stat")
      }
      guard !privateAncestors.contains("\(root.dev):\(root.ino)"),
        !rootAncestors.contains("\(privateStat.st_dev):\(privateStat.st_ino)")
      else { throw NativeError.refused("private_overlap") }
      let a = URL(fileURLWithPath: root.path).pathComponents
      let b = self.privateURL.pathComponents
      guard !a.starts(with: b), !b.starts(with: a) else {
        throw NativeError.refused("private_overlap")
      }
      for old in opened.values {
        let c = URL(fileURLWithPath: old.path).pathComponents
        guard !a.starts(with: c), !c.starts(with: a), !(root.dev == old.dev && root.ino == old.ino)
        else { throw NativeError.refused("root_overlap") }
      }
      opened[id] = root
    }
    self.roots = opened
  }
  public static func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
  private func validated(_ path: String) throws -> String {
    let parts = path.split(separator: "/", omittingEmptySubsequences: false)
    guard !path.hasPrefix("/"), !path.contains("\\"), path.utf8.count <= 1024, parts.count <= 16,
      path == path.precomposedStringWithCanonicalMapping,
      parts.allSatisfy({
        !$0.isEmpty && $0 != "." && $0 != ".." && !$0.hasPrefix(".gmail-mcp-")
          && $0.utf8.count <= 255
      }),
      !path.unicodeScalars.contains(where: {
        CharacterSet.controlCharacters.contains($0) || $0.properties.generalCategory == .format
      })
    else { throw NativeError.refused("invalid_path") }
    return path
  }
  private func root(_ id: String, write: Bool) throws -> Root {
    guard let r = roots[id], write ? r.grant.write : r.grant.read else {
      throw NativeError.refused("root_permission")
    }
    try r.check()
    return r
  }
  public func snapshot(root id: String, relative: String, id snapshotID: String) throws
    -> FileResult
  {
    let r = try root(id, write: false)
    let path = try validated(relative)
    guard snapshotID.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else {
      throw NativeError.refused("snapshot_id")
    }
    let fd = gm_open(r.fd, path, O_RDONLY | O_NONBLOCK, 0)
    guard fd >= 0 else { throw NativeError.system("source_open", errno) }
    defer { close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0, st.st_mode & S_IFMT == S_IFREG, st.st_nlink == 1, st.st_dev == r.dev,
      st.st_size >= 0, st.st_size <= Self.maximum
    else { throw NativeError.refused("source_type_or_size") }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
    let data = try handle.read(upToCount: Self.maximum + 1) ?? Data()
    guard data.count == st.st_size else { throw NativeError.refused("source_changed") }
    var after = stat()
    guard fstat(fd, &after) == 0, after.st_size == st.st_size,
      after.st_mtimespec.tv_sec == st.st_mtimespec.tv_sec,
      after.st_mtimespec.tv_nsec == st.st_mtimespec.tv_nsec
    else { throw NativeError.refused("source_changed") }
    let target = privateURL.appendingPathComponent(snapshotID)
    let dest = open(target.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW_ANY, 0o600)
    guard dest >= 0 else { throw NativeError.system("snapshot_create", errno) }
    var keep = false
    defer {
      close(dest)
      if !keep { unlink(target.path) }
    }
    try FileHandle(fileDescriptor: dest, closeOnDealloc: false).write(contentsOf: data)
    guard gm_sync(dest) == 0 else { throw NativeError.system("snapshot_sync", errno) }
    var saved = stat()
    guard fstat(dest, &saved) == 0 else { throw NativeError.system("snapshot_stat", errno) }
    let directory = open(privateURL.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY)
    guard directory >= 0 else { throw NativeError.refused("snapshot_directory") }
    defer { close(directory) }
    guard fsync(directory) == 0 else { throw NativeError.refused("snapshot_directory_sync") }
    keep = true
    return FileResult(
      path: target.path, size: data.count, sha256: Self.digest(data), device: UInt64(saved.st_dev),
      inode: UInt64(saved.st_ino))
  }
  public func save(
    root id: String, relative: String, bytes: Data, sha256: String,
    beforePublish: ((FileResult) throws -> Void)? = nil, temporary: String? = nil,
    afterCreate: ((FileResult) throws -> Void)? = nil
  ) throws -> FileResult {
    guard bytes.count <= Self.maximum, Self.digest(bytes) == sha256 else {
      throw NativeError.refused("digest_or_size")
    }
    let r = try root(id, write: true)
    let path = try validated(relative)
    let parent = (path as NSString).deletingLastPathComponent
    let temp =
      temporary ?? ((parent.isEmpty ? "" : parent + "/") + ".gmail-mcp-" + UUID().uuidString)
    guard (temp as NSString).deletingLastPathComponent == parent,
      (temp as NSString).lastPathComponent.range(
        of: "^\\.gmail-mcp-[A-Fa-f0-9-]{36}$", options: .regularExpression) != nil
    else { throw NativeError.refused("temporary_path") }
    let fd = gm_open(r.fd, temp, O_WRONLY | O_CREAT | O_EXCL, 0o600)
    guard fd >= 0 else { throw NativeError.system("temporary_create", errno) }
    var published = false
    defer {
      close(fd)
      if !published { gm_remove(r.fd, temp) }
    }
    var created = stat()
    guard fstat(fd, &created) == 0 else { throw NativeError.refused("temporary_stat") }
    try afterCreate?(
      FileResult(
        path: temp, size: bytes.count, sha256: sha256, device: UInt64(created.st_dev),
        inode: UInt64(created.st_ino)))
    try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: bytes)
    guard gm_sync(fd) == 0 else { throw NativeError.system("file_sync", errno) }
    var st = stat()
    guard fstat(fd, &st) == 0 else { throw NativeError.system("temporary_stat", errno) }
    try beforePublish?(
      FileResult(
        path: path, size: bytes.count, sha256: sha256, device: UInt64(st.st_dev),
        inode: UInt64(st.st_ino)))
    try r.check()
    guard gm_publish(r.fd, temp, path) == 0 else { throw NativeError.system("publish", errno) }
    published = true
    let parentFD = parent.isEmpty ? dup(r.fd) : gm_open(r.fd, parent, O_RDONLY | O_DIRECTORY, 0)
    guard parentFD >= 0 else { throw NativeError.system("parent_open", errno) }
    defer { close(parentFD) }
    guard fsync(parentFD) == 0 else { throw NativeError.system("directory_sync", errno) }
    return FileResult(
      path: path, size: bytes.count, sha256: sha256, device: UInt64(st.st_dev),
      inode: UInt64(st.st_ino))
  }
  public func verify(root id: String, relative: String, expected: FileResult) throws {
    let r = try root(id, write: true)
    let path = try validated(relative)
    let fd = gm_open(r.fd, path, O_RDONLY | O_NONBLOCK, 0)
    guard fd >= 0 else { throw NativeError.refused("publication_unknown") }
    defer { close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0, st.st_mode & S_IFMT == S_IFREG, st.st_nlink == 1,
      UInt64(st.st_dev) == expected.device, UInt64(st.st_ino) == expected.inode,
      st.st_size == expected.size
    else { throw NativeError.refused("publication_unknown") }
    let bytes =
      try FileHandle(fileDescriptor: fd, closeOnDealloc: false).read(upToCount: Self.maximum + 1)
      ?? Data()
    guard bytes.count == expected.size, Self.digest(bytes) == expected.sha256 else {
      throw NativeError.refused("publication_unknown")
    }
    try r.check()
    let parent = (path as NSString).deletingLastPathComponent
    let directory = parent.isEmpty ? dup(r.fd) : gm_open(r.fd, parent, O_RDONLY | O_DIRECTORY, 0)
    guard directory >= 0 else { throw NativeError.refused("publication_unknown") }
    defer { close(directory) }
    guard fsync(directory) == 0 else { throw NativeError.refused("publication_unknown") }
  }

  public func discardTemporary(root id: String, path: String, expected: FileResult?) throws -> Bool
  {
    let r = try root(id, write: true)
    let leaf = (path as NSString).lastPathComponent
    let parent = (path as NSString).deletingLastPathComponent
    guard leaf.range(of: "^\\.gmail-mcp-[A-Fa-f0-9-]{36}$", options: .regularExpression) != nil
    else { throw NativeError.refused("temporary_path") }
    if !parent.isEmpty { _ = try validated(parent) }
    let fd = gm_open(r.fd, path, O_RDONLY | O_NONBLOCK, 0)
    if fd < 0 {
      if errno == ENOENT { return false }
      throw NativeError.refused("publication_unknown")
    }
    defer { close(fd) }
    var st = stat()
    guard let expected, fstat(fd, &st) == 0, UInt64(st.st_dev) == expected.device,
      UInt64(st.st_ino) == expected.inode, st.st_mode & S_IFMT == S_IFREG, st.st_nlink == 1
    else { throw NativeError.refused("publication_unknown") }
    guard gm_remove(r.fd, path) == 0 else { throw NativeError.refused("temporary_cleanup") }
    let directory = parent.isEmpty ? dup(r.fd) : gm_open(r.fd, parent, O_RDONLY | O_DIRECTORY, 0)
    guard directory >= 0 else { throw NativeError.refused("temporary_cleanup") }
    defer { close(directory) }
    guard fsync(directory) == 0 else { throw NativeError.refused("temporary_cleanup") }
    return true
  }

}
