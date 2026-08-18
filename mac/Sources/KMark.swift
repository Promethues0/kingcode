// K 字标的矢量绘制 —— 应用图标与启动页共用同一份几何。
// 与 web-brand 的 K_MARK（SVG）保持同形：竖笔 + 上下两撇，下撇取深赭亮端。
import AppKit

enum KMark {
    /// 在 32×32 设计栅格里描出 K 的三笔，调用方自行缩放。
    /// - Parameters:
    ///   - rect: 目标矩形（按短边等比缩放并居中）。
    ///   - stemColor: 竖笔与上撇的颜色。
    ///   - armColor: 下撇的颜色（品牌口音色）。
    static func draw(in rect: NSRect, stemColor: NSColor, armColor: NSColor) {
        let side = min(rect.width, rect.height)
        let scale = side / 32
        let ox = rect.minX + (rect.width - side) / 2
        let oy = rect.minY + (rect.height - side) / 2
        // 设计栅格是「Y 轴向下」的 SVG 坐标，这里翻成 AppKit 的向上坐标
        func pt(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
            NSPoint(x: ox + x * scale, y: oy + (32 - y) * scale)
        }

        let stemWidth: CGFloat = 4 * scale
        let stem = NSBezierPath(roundedRect: NSRect(x: ox + 7 * scale,
                                                    y: oy + (32 - 26) * scale,
                                                    width: stemWidth,
                                                    height: 20 * scale),
                                xRadius: 1.8 * scale, yRadius: 1.8 * scale)
        stemColor.setFill()
        stem.fill()

        let upper = NSBezierPath()
        upper.move(to: pt(12, 16))
        upper.line(to: pt(22, 5.6))
        upper.lineWidth = 4 * scale
        upper.lineCapStyle = .round
        stemColor.setStroke()
        upper.stroke()

        let lower = NSBezierPath()
        lower.move(to: pt(12, 16))
        lower.line(to: pt(22, 26.4))
        lower.lineWidth = 4 * scale
        lower.lineCapStyle = .round
        armColor.setStroke()
        lower.stroke()
    }

    /// 生成一张应用图标位图：墨绿黑圆角底 + 纸色 K + 深赭下撇。
    static func iconImage(size: CGFloat) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size))
        image.lockFocus()
        let rect = NSRect(x: 0, y: 0, width: size, height: size)
        // macOS 图标惯例：四周留白，圆角方底
        let inset = size * 0.06
        let body = rect.insetBy(dx: inset, dy: inset)
        let ground = NSBezierPath(roundedRect: body,
                                  xRadius: body.width * 0.2237,
                                  yRadius: body.width * 0.2237)
        Palette.ink.setFill()
        ground.fill()
        // K 占内部约 62%，居中偏视觉重心
        let markSide = body.width * 0.62
        let markRect = NSRect(x: body.midX - markSide / 2,
                              y: body.midY - markSide / 2,
                              width: markSide, height: markSide)
        draw(in: markRect, stemColor: Palette.paper, armColor: Palette.accent2)
        image.unlockFocus()
        return image
    }

    /// 把各尺寸 PNG 写进 iconset 目录，供 iconutil 打包。
    static func writeIconset(to dir: URL) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let specs: [(name: String, px: CGFloat)] = [
            ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
            ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
            ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
            ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
            ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
        ]
        for spec in specs {
            let image = iconImage(size: spec.px)
            guard let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else {
                throw NSError(domain: "KingCode", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "无法生成 \(spec.name)"])
            }
            try png.write(to: dir.appendingPathComponent(spec.name))
        }
    }
}
