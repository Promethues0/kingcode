namespace KingCode;

/// <summary>
/// KingCode 原生侧配色 —— 字节蓝（Arco Design 色阶）。
/// 与 web-brand/client.js 的 P 常量块、mac/Sources/Palette.swift 同源；
/// 改色三处一起改，并跑 web-brand/tools/check-contrast.js 复验。
/// </summary>
internal static class Palette
{
    private static Color Hex(uint v) =>
        Color.FromArgb((int)((v >> 16) & 0xFF), (int)((v >> 8) & 0xFF), (int)(v & 0xFF));

    // 亮色
    internal static readonly Color Ink = Hex(0x1D2129);      // Arco gray-9
    internal static readonly Color Muted = Hex(0x666F7A);    // 三级文字
    internal static readonly Color Surface = Hex(0xFFFFFF);  // 最外层
    internal static readonly Color Paper = Hex(0xF2F3F5);    // Arco gray-2
    internal static readonly Color Accent = Hex(0x165DFF);   // Arco primary
    internal static readonly Color Accent2 = Hex(0x4080FF);  // Arco blue-5
    internal static readonly Color Danger = Hex(0xA1151E);

    // 暗色（夜径）
    internal static readonly Color DarkBase = Hex(0x17171A);
    internal static readonly Color DarkText = Hex(0xF6F6F6);
    internal static readonly Color DarkText3 = Hex(0x929293);
    internal static readonly Color DarkAccent = Hex(0x4080FF);
    internal static readonly Color DarkAccent2 = Hex(0x6AA1FF);
    internal static readonly Color DarkDanger = Hex(0xFBACA3);

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
