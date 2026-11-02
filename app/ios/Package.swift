// swift-tools-version:5.9
// ObolNativeRuntime: the shared native store/sync/transport/security Core.
//
// This package compiles the ACTUAL files under `App/App/Core` exactly once,
// depending on the local ObolCore package for the pure financial models and
// engine. The App target links this product plus ObolCore and never compiles
// either Core a second time.
import PackageDescription

let package = Package(
    name: "ObolNativeRuntime",
    platforms: [
        .iOS(.v16),
        .macOS(.v13)
    ],
    products: [
        .library(name: "ObolNativeRuntime", targets: ["ObolNativeRuntime"])
    ],
    dependencies: [
        .package(path: "ObolCore")
    ],
    targets: [
        .target(
            name: "ObolNativeRuntime",
            dependencies: [
                .product(name: "ObolCore", package: "ObolCore")
            ],
            path: "App/App/Core",
            linkerSettings: [
                .linkedLibrary("sqlite3")
            ]
        ),
        .testTarget(
            name: "FinanceParityTests",
            dependencies: [
                .target(name: "ObolNativeRuntime"),
                .product(name: "ObolCore", package: "ObolCore")
            ],
            path: "Tests/FinanceParityTests",
            linkerSettings: [
                .linkedLibrary("sqlite3")
            ]
        )
    ],
    swiftLanguageVersions: [.v5]
)
