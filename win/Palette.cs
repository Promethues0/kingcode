namespace KingCode;

/// <summary>
/// KingCode 原生侧配色 —— 苔径晨雾大地色系。
/// 与 web-brand/client.js 的 P 常量块、mac/Sources/Palette.swift 同源；
/// 改色三处一起改，并跑 web-brand/tools/check-contrast.js 复验。
/// </summary>
internal static class Palette
{
    private static Color Hex(uint v) =>
        Color.FromArgb((int)((v >> 16) & 0xFF), (int)((v >> 8) & 0xFF), (int)(v & 0xFF));

    // 亮色
    internal static readonly Color Ink = Hex(0x262B24);      // 墨绿黑
    internal static readonly Color Muted = Hex(0x6A6B61);    // 岩灰
    internal static readonly Color Surface = Hex(0xFCFBF7);  // 纸底（浅）
    internal static readonly Color Paper = Hex(0xF1EFE7);    // 纸底
    internal static readonly Color Accent = Hex(0x8F5127);   // 深赭
    internal static readonly Color Accent2 = Hex(0xB97B45);  // 深赭渐变亮端
    internal static readonly Color Danger = Hex(0x963C4A);

    // 暗色（夜径）
    internal static readonly Color DarkBase = Hex(0x191C18);
    internal static readonly Color DarkText = Hex(0xEDEBE1);
    internal static readonly Color DarkText3 = Hex(0x94958A);
    internal static readonly Color DarkAccent = Hex(0xC08850);
    internal static readonly Color DarkAccent2 = Hex(0xD19A62);
    internal static readonly Color DarkDanger = Hex(0xCE7280);

    /// <summary>系统是否处于深色模式（读注册表的 AppsUseLightTheme）。</summary>
    internal static bool IsDarkMode()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            // 值缺失（部分 LTSC/精简版没有这个键）时按浅色处理
            return key?.GetValue("AppsUseLightTheme") is int v && v == 0;
        }
        catch
        {
            return false;
        }
    }

    internal static Color WindowBackground => IsDarkMode() ? DarkBase : Surface;
    internal static Color Label => IsDarkMode() ? DarkText : Ink;
    internal static Color SecondaryLabel => IsDarkMode() ? DarkText3 : Muted;
    internal static Color MarkStart => IsDarkMode() ? DarkAccent : Accent;
    internal static Color MarkEnd => IsDarkMode() ? DarkAccent2 : Accent2;
    internal static Color ErrorColor => IsDarkMode() ? DarkDanger : Danger;
}
