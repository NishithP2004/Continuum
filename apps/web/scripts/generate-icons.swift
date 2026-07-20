#!/usr/bin/env swift
import AppKit
import Foundation

struct Icon {
    let source: String
    let output: String
    let size: Int
    let background: NSColor?
}

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let publicDirectory = root.appendingPathComponent("public")
let icons = [
    Icon(source: "continuum-mark.svg", output: "continuum-192.png", size: 192, background: nil),
    Icon(source: "continuum-mark.svg", output: "continuum-512.png", size: 512, background: nil),
    Icon(source: "continuum-mark.svg", output: "continuum-apple-touch.png", size: 180, background: .white),
    Icon(source: "continuum-maskable.svg", output: "continuum-maskable-512.png", size: 512, background: nil)
]

for icon in icons {
    let sourceURL = publicDirectory.appendingPathComponent(icon.source)
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
    image.draw(in: NSRect(x: 0, y: 0, width: icon.size, height: icon.size), from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    guard let data = bitmap.representation(using: .png, properties: [:]) else { fatalError("Could not encode \(icon.output)") }
    try data.write(to: publicDirectory.appendingPathComponent(icon.output), options: .atomic)
}
