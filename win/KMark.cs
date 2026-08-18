using System.Drawing.Drawing2D;

namespace KingCode;

/// <summary>
/// K 字标的矢量绘制 —— 与 mac/Sources/KMark.swift、web-brand 的 SVG 同一份几何：
/// 32×32 设计栅格里的竖笔 + 上下两撇，圆角笔帽，下撇取深赭亮端。
/// </summary>
internal static class KMark
{
    /// <summary>在给定矩形内居中绘制 K（按短边等比缩放）。</summary>
    internal static void Draw(Graphics g, RectangleF rect, Color from, Color to)
    {
        var side = Math.Min(rect.Width, rect.Height);
        if (side <= 0) return;
        var scale = side / 32f;
        var ox = rect.X + (rect.Width - side) / 2f;
        var oy = rect.Y + (rect.Height - side) / 2f;
        PointF P(float x, float y) => new(ox + x * scale, oy + y * scale);

        var old = g.SmoothingMode;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        // 渐变沿对角铺满整个标记，三笔共用一条 —— 与 SVG 版的
        // gradientUnits="userSpaceOnUse" 等价。
        using var brush = new LinearGradientBrush(
            new RectangleF(ox + 7 * scale, oy + 5 * scale, 16 * scale, 22 * scale),
            from, to, LinearGradientMode.ForwardDiagonal);
        using var pen = new Pen(brush, 4 * scale)
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round,
            LineJoin = LineJoin.Round,
        };

        g.DrawLine(pen, P(9, 7), P(9, 25));         // 竖笔
        g.DrawLine(pen, P(12, 16), P(21.5f, 6.2f)); // 上撇
        g.DrawLine(pen, P(12, 16), P(21.5f, 25.8f));// 下撇

        g.SmoothingMode = old;
    }
}
