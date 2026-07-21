#!/usr/bin/env swift
import AppKit
import Foundation

struct Icon {
    let output: String
    let size: Int
    let background: NSColor?
    let artworkScale: CGFloat
}

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let publicDirectory = root.appendingPathComponent("public")
let repositoryRoot = root.deletingLastPathComponent().deletingLastPathComponent()
let sourceURL = repositoryRoot.appendingPathComponent("assets/branding/continuum-app-icon-master.png")
let icons = [
    Icon(output: "continuum-192.png", size: 192, background: nil, artworkScale: 1),
    Icon(output: "continuum-512.png", size: 512, background: nil, artworkScale: 1),
    Icon(output: "continuum-apple-touch.png", size: 180, background: .white, artworkScale: 1),
    Icon(output: "continuum-maskable-512.png", size: 512, background: .white, artworkScale: 0.66)
]

for icon in icons {
    guard let image = NSImage(contentsOf: sourceURL),
          let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: icon.size,
            pixelsHigh: icon.size,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
          ) else {
        fatalError("Could not render \(sourceURL.path)")
    }
    bitmap.size = NSSize(width: icon.size, height: icon.size)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    icon.background?.setFill()
    if icon.background != nil { NSRect(x: 0, y: 0, width: icon.size, height: icon.size).fill() }
    let artworkSize = CGFloat(icon.size) * icon.artworkScale
    let inset = (CGFloat(icon.size) - artworkSize) / 2
    image.draw(
      in: NSRect(x: inset, y: inset, width: artworkSize, height: artworkSize),
      from: .zero,
      operation: .sourceOver,
      fraction: 1
    )
    NSGraphicsContext.restoreGraphicsState()
    guard let data = bitmap.representation(using: .png, properties: [:]) else { fatalError("Could not encode \(icon.output)") }
    try data.write(to: publicDirectory.appendingPathComponent(icon.output), options: .atomic)
}
