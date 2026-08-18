// KingCode 原生客户端配色 —— 苔径晨雾大地色系。
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
    static let ink = hex(0x262B24)      // 墨绿黑
    static let muted = hex(0x6A6B61)    // 岩灰
    static let surface = hex(0xFCFBF7)  // 纸底（浅）
    static let paper = hex(0xF1EFE7)    // 纸底
    static let accent = hex(0x8F5127)   // 深赭
    static let accent2 = hex(0xB97B45)  // 深赭渐变亮端
    static let danger = hex(0x963C4A)

    // 暗色（夜径）
    static let dBase = hex(0x191C18)
    static let dText = hex(0xEDEBE1)
    static let dText3 = hex(0x94958A)
    static let dAccent = hex(0xC08850)
    static let dAccent2 = hex(0xD19A62)
    static let dDanger = hex(0xCE7280)

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
