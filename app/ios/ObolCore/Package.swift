// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ObolCore",
    platforms: [
        .iOS(.v15),
        .macOS(.v13)
    ],
    products: [
        .library(name: "ObolCore", targets: ["ObolCore"])
    ],
    targets: [
        .target(
            name: "ObolCore",
            path: "Sources/ObolCore"
        )
    ],
    swiftLanguageVersions: [.v5]
)
