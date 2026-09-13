import Foundation
import XCTest

@testable import NativeCore

final class FrameTests: XCTestCase {
  func testBoundedFramesRoundTripAndRejectTruncation() throws {
    let meta = Data("{\"op\":\"roots\"}".utf8)
    let encoded = try NativeFrame.encode(metadata: meta, body: Data("bytes".utf8))
    let frame = try NativeFrame.decode(encoded)
    XCTAssertEqual(frame.metadata, meta)
    XCTAssertEqual(frame.body, Data("bytes".utf8))
    XCTAssertThrowsError(try NativeFrame.decode(encoded.dropLast()))
    XCTAssertThrowsError(
      try NativeFrame.encode(metadata: Data(repeating: 0, count: 65537), body: Data()))
  }
}
