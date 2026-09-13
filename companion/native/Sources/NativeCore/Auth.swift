import Darwin
import Foundation
import Security

/// Keep the descriptor alive for the entire read/refresh/write transaction.
/// The lock inode is permanent; unlinking it would permit two independent locks.
public final class ProcessLock {
  private let fd: Int32
  public init(path: String, wait: Bool = true) throws {
    let physical =
      try physicalPath((path as NSString).deletingLastPathComponent) + "/"
      + (path as NSString).lastPathComponent
    fd = open(physical, O_RDWR | O_CREAT | O_NOFOLLOW_ANY, 0o600)
    guard fd >= 0 else { throw NativeError.system("lock_open", errno) }
    var st = stat()
    guard fstat(fd, &st) == 0, st.st_mode & S_IFMT == S_IFREG, st.st_uid == getuid(),
      st.st_nlink == 1, st.st_mode & 0o077 == 0
    else {
      close(fd)
      throw NativeError.refused("lock_permissions")
    }
    guard flock(fd, LOCK_EX | (wait ? 0 : LOCK_NB)) == 0 else {
      close(fd)
      throw NativeError.refused("lock_busy")
    }
  }
  deinit {
    flock(fd, LOCK_UN)
    close(fd)
  }
}
public protocol CredentialStore {
  func read(account: String) throws -> Data?
  func write(account: String, data: Data) throws
  func delete(account: String) throws
}
/// Uses Security.framework directly: credential bytes never enter process arguments.
public final class KeychainCredentials: CredentialStore {
  private let service = "app.gmail-mcp.companion.oauth.v1"
  public init() {}
  private func query(_ account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false,
    ]
  }
  public func read(account: String) throws -> Data? {
    var q = query(account)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var value: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &value)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = value as? Data else {
      throw NativeError.refused("keychain_read")
    }
    return data
  }
  public func write(account: String, data: Data) throws {
    guard data.count <= 65536 else { throw NativeError.refused("credential_size") }
    let q = query(account)
    let status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var add = q
      add[kSecValueData as String] = data
      add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else {
        throw NativeError.refused("keychain_write")
      }
    } else if status != errSecSuccess {
      throw NativeError.refused("keychain_write")
    }
  }
  public func delete(account: String) throws {
    let status = SecItemDelete(query(account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw NativeError.refused("keychain_delete")
    }
  }
}
/// Caller holds the permanent auth lock while using this state, including HTTP refresh.
public final class AuthState {
  private let journal: Journal
  private let store: any CredentialStore
  public init(journal: Journal, store: any CredentialStore) {
    self.journal = journal
    self.store = store
  }
  public func epoch(account: String) throws -> String {
    if let old = try journal.get(scope: "auth_epoch", key: account) { return old.payload }
    let value = UUID().uuidString
    try journal.put(scope: "auth_epoch", key: account, requestHash: account, payload: value)
    return value
  }
  private struct BoundCredential: Codable {
    let epoch: String
    let data: Data
  }
  public func read(account: String) throws -> Data? {
    guard let data = try store.read(account: account) else { return nil }
    let bound = try JSONDecoder().decode(BoundCredential.self, from: data)
    guard bound.epoch == (try epoch(account: account)) else { return nil }
    return bound.data
  }
  public func commit(account: String, epoch expected: String, data: Data) throws {
    guard try epoch(account: account) == expected else {
      throw NativeError.refused("auth_epoch_changed")
    }
    try store.write(
      account: account, data: JSONEncoder().encode(BoundCredential(epoch: expected, data: data)))
  }
  public func logout(account: String) throws {
    // Persist the fence first; failed credential deletion cannot permit an older login.
    try journal.put(
      scope: "auth_epoch", key: account, requestHash: account, payload: UUID().uuidString)
    try store.delete(account: account)
  }
}
