import AppKit

// Finder places the app and Applications icons over the empty middle row.
let width = 660, height = 420
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width * 2,
    pixelsHigh: height * 2, bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0)!
bitmap.size = NSSize(width: width, height: height)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> NSColor {
    NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: 1)
}
let ink = color(31, 40, 47)
// Light-theme --color-accent: oklch(54% 0.16 248), clipped to sRGB.
let accent = color(0, 114, 198)
color(246, 248, 250).setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: width, height: height)).fill()
accent.setFill()
NSBezierPath(rect: NSRect(x: 0, y: height - 5, width: width, height: 5)).fill()
func text(_ value: String, _ y: CGFloat, _ size: CGFloat, _ weight: NSFont.Weight, _ tint: NSColor) {
    let style = NSMutableParagraphStyle()
    style.alignment = .center
    (value as NSString).draw(in: NSRect(x: 30, y: y, width: 600, height: size * 1.6), withAttributes: [
        .font: NSFont.systemFont(ofSize: size, weight: weight),
        .foregroundColor: tint, .paragraphStyle: style
    ])
}
text("Flutrace", 326, 34, .bold, ink)
text("Network inspector for Flutter.", 300, 14, .regular, color(87, 102, 114))
text("Drag Flutrace into Applications", 253, 17, .medium, ink)
let arrow = NSBezierPath()
arrow.move(to: NSPoint(x: 302, y: 175))
arrow.line(to: NSPoint(x: 356, y: 175))
arrow.move(to: NSPoint(x: 343, y: 188))
arrow.line(to: NSPoint(x: 356, y: 175))
arrow.line(to: NSPoint(x: 343, y: 162))
arrow.lineWidth = 3
arrow.lineCapStyle = .round
arrow.lineJoinStyle = .round
accent.setStroke()
arrow.stroke()
NSGraphicsContext.restoreGraphicsState()
let destination = CommandLine.arguments.dropFirst().first ?? "src-tauri/dmg/background.png"
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: destination))
