// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "StudentCore",
    platforms: [.macOS(.v14), .iOS(.v18)],
    products: [.library(name: "StudentCore", targets: ["StudentCore"])],
    targets: [
        .target(name: "StudentCore", path: "StudentApp", exclude: ["Resources", "Assets.xcassets", "Theme.swift", "SuperErrorLogApp.swift", "NotebookUI"], sources: ["Domain", "Web", "RecognitionClient.swift", "PairingStore.swift"]),
        .testTarget(name: "StudentCoreTests", dependencies: ["StudentCore"], path: "Tests")
    ]
)
