// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "ContinuumApp",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "ContinuumApp", targets: ["ContinuumApp"]),
        .executable(
            name: "ContinuumFoundationModelBridge",
            targets: ["ContinuumFoundationModelBridge"]
        )
    ],
    targets: [
        .executableTarget(
            name: "ContinuumApp",
            path: "Sources/ContinuumApp"
        ),
        .executableTarget(
            name: "ContinuumFoundationModelBridge",
            path: "Sources/ContinuumFoundationModelBridge"
        ),
        .testTarget(
            name: "ContinuumAppTests",
            dependencies: ["ContinuumApp"],
            path: "Tests/ContinuumAppTests"
        )
    ]
)
