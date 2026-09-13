import Darwin
import Foundation

public struct CompanionConfiguration: Codable {
  public let origin: String
  public let client_id: String
  public let roots: [String: RootGrant]
  public func validate() throws {
    guard let url = URLComponents(string: origin), url.scheme == "https", url.host != nil,
      url.user == nil, url.password == nil, url.path.isEmpty, url.query == nil, url.fragment == nil,
      !client_id.isEmpty, client_id.utf8.count <= 1024, roots.count <= 16,
      roots.keys.allSatisfy({
        $0.range(of: "^[a-z][a-z0-9_-]{0,63}$", options: .regularExpression) != nil
      })
    else { throw NativeError.refused("configuration_invalid") }
  }
}
public enum PrivateState {
  public static func directory(_ path: String) throws -> String {
    var st = stat()
    if lstat(path, &st) != 0 {
      guard errno == ENOENT else { throw NativeError.refused("private_directory") }
      try FileManager.default.createDirectory(
        atPath: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    guard lstat(path, &st) == 0, st.st_mode & S_IFMT == S_IFDIR else {
      throw NativeError.refused("private_symlink")
    }
    let physical = try physicalPath(path)
    guard lstat(physical, &st) == 0, st.st_mode & S_IFMT == S_IFDIR, st.st_uid == getuid(),
      st.st_mode & 0o077 == 0
    else { throw NativeError.refused("private_permissions") }
    let fd = open(physical, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY)
    guard fd >= 0 else { throw NativeError.refused("private_directory") }
    defer { close(fd) }
    guard fsync(fd) == 0 else { throw NativeError.refused("private_sync") }
    return physical
  }
  public static func freeSpace(_ path: String) throws {
    var volume = statfs()
    guard statfs(path, &volume) == 0, volume.f_flags & UInt32(MNT_LOCAL) != 0,
      UInt64(volume.f_bavail) * UInt64(volume.f_bsize) >= UInt64(125 * 1024 * 1024)
    else { throw NativeError.refused("space_or_volume") }
  }
  public static func readConfig(_ path: String) throws -> CompanionConfiguration {
    let fd = open(path, O_RDONLY | O_NOFOLLOW_ANY | O_NONBLOCK)
    guard fd >= 0 else { throw NativeError.refused("run_init") }
    defer { close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0, st.st_mode & S_IFMT == S_IFREG, st.st_nlink == 1,
      st.st_uid == getuid(), st.st_mode & 0o077 == 0, st.st_size <= 65536
    else { throw NativeError.refused("configuration_permissions") }
    let data =
      try FileHandle(fileDescriptor: fd, closeOnDealloc: false).read(upToCount: 65537) ?? Data()
    let config = try JSONDecoder().decode(CompanionConfiguration.self, from: data)
    try config.validate()
    return config
  }
}
