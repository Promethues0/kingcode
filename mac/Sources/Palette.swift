// KingCode 原生客户端配色 —— 字节蓝（Arco Design 色阶）。
// 与 web-brand/client.js 顶部的 P 常量块同源；改色两边一起改，
// 并跑 `node web-brand/tools/check-contrast.js` 复验。
import AppKit

enum Palette {
    static func hex(_ v: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255,
                green: CGFloat((v >> 8) & 0xFF) / 255,
                blue: CGFloat(v & 0xFF) / 255,
                alpha: 1)
    }

    // 亮色
    static let ink = hex(0x1D2129)      // Arco gray-9
    static let muted = hex(0x666F7A)    // 三级文字
    static let surface = hex(0xFFFFFF)  // 最外层
    static let paper = hex(0xF2F3F5)    // Arco gray-2
    static let accent = hex(0x165DFF)   // Arco primary
    static let accent2 = hex(0x4080FF)  // Arco blue-5
    static let danger = hex(0xA1151E)

    // 暗色（夜径）
    static let dBase = hex(0x17171A)
    static let dText = hex(0xF6F6F6)
    static let dText3 = hex(0x929293)
    static let dAccent = hex(0x4080FF)
    static let dAccent2 = hex(0x6AA1FF)
    static let dDanger = hex(0xFBACA3)

    /// 跟随系统外观取值。
    static func dyn(light: NSColor, dark: NSColor) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return isDark ? dark : light
        }
    }

    static var windowBackground: NSColor { dyn(light: surface, dark: dBase) }
    static var label: NSColor { dyn(light: ink, dark: dText) }
    static var secondaryLabel: NSColor { dyn(light: muted, dark: dText3) }
    static var markStart: NSColor { dyn(light: accent, dark: dAccent) }
    static var markEnd: NSColor { dyn(light: accent2, dark: dAccent2) }
    static var errorColor: NSColor { dyn(light: danger, dark: dDanger) }
}
