// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "GmailNative", platforms: [.macOS("26.6")],
  products: [.executable(name: "gmail-mcp-native", targets: ["NativeHelper"])],
  targets: [
    .target(name: "CNative", publicHeadersPath: "include"),
    .systemLibrary(name: "CSQLite", pkgConfig: "sqlite3"),
    .target(name: "NativeCore", dependencies: ["CNative", "CSQLite"]),
    .executableTarget(name: "NativeHelper", dependencies: ["NativeCore"]),
    .testTarget(name: "NativeCoreTests", dependencies: ["NativeCore"]),
  ])
