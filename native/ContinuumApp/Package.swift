// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "ContinuumApp",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "ContinuumApp", targets: ["ContinuumApp"])
    ],
    targets: [
        .executableTarget(
            name: "ContinuumApp",
            path: "Sources/ContinuumApp"
        ),
        .testTarget(
            name: "ContinuumAppTests",
            dependencies: ["ContinuumApp"],
            path: "Tests/ContinuumAppTests"
        )
    ]
)
