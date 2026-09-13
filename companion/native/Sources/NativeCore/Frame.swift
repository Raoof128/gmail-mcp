import Foundation

public struct NativeFrame {
  public let metadata: Data
  public let body: Data
  private static func number(_ data: Data, _ offset: Int) -> Int {
    data.dropFirst(offset).prefix(4).reduce(0) { ($0 << 8) | Int($1) }
  }
  public static func encode(metadata: Data, body: Data) throws -> Data {
    guard metadata.count <= 65536, body.count <= SafeFiles.maximum else {
      throw NativeError.refused("frame_size")
    }
    var out = Data()
    for n in [metadata.count, body.count] {
      for shift in [24, 16, 8, 0] { out.append(UInt8((n >> shift) & 255)) }
    }
    out.append(metadata)
    out.append(body)
    return out
  }
  public static func decode(_ data: Data) throws -> NativeFrame {
    guard data.count >= 8 else { throw NativeError.refused("frame_truncated") }
    let m = number(data, 0)
    let b = number(data, 4)
    guard m <= 65536, b <= SafeFiles.maximum, data.count == 8 + m + b else {
      throw NativeError.refused("frame_size")
    }
    return NativeFrame(
      metadata: Data(data.dropFirst(8).prefix(m)), body: Data(data.dropFirst(8 + m)))
  }
  private static func exact(_ handle: FileHandle, _ count: Int) throws -> Data {
    var out = Data()
    while out.count < count {
      guard let part = try handle.read(upToCount: count - out.count), !part.isEmpty else {
        throw NativeError.refused("frame_truncated")
      }
      out.append(part)
    }
    return out
  }
  public static func read(_ handle: FileHandle) throws -> NativeFrame? {
    guard let first = try handle.read(upToCount: 1), !first.isEmpty else { return nil }
    var header = first
    header.append(try exact(handle, 7))
    let m = number(header, 0)
    let b = number(header, 4)
    guard m <= 65536, b <= SafeFiles.maximum else { throw NativeError.refused("frame_size") }
    return NativeFrame(metadata: try exact(handle, m), body: try exact(handle, b))
  }
}
