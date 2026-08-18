namespace KingCode;

/// <summary>
/// 启动页：引擎装配插件树要几秒，这几秒必须有品牌在场；
/// 失败时要给得出日志入口，而不是把人晾在白屏上。
/// </summary>
internal sealed class LaunchPanel : Panel
{
    private readonly Label _status = new();
    private readonly Label _detail = new();
    private readonly Button _logButton = new();
    private readonly MarkBox _mark = new();

    internal string LogPath { get; set; } = string.Empty;

    internal LaunchPanel()
    {
        DoubleBuffered = true;
        BackColor = Palette.WindowBackground;

        _mark.Size = new Size(64, 64);
        _mark.BackColor = Color.Transparent;

        _status.AutoSize = true;
        _status.Font = new Font(SystemFonts.MessageBoxFont!.FontFamily, 12F, FontStyle.Regular);
        _status.ForeColor = Palette.Label;
        _status.TextAlign = ContentAlignment.MiddleCenter;

        _detail.AutoSize = false;
        _detail.Size = new Size(560, 110);
        _detail.Font = new Font(FontFamily.GenericMonospace, 8.5F);
        _detail.ForeColor = Palette.SecondaryLabel;
        _detail.TextAlign = ContentAlignment.TopCenter;
        _detail.Visible = false;

        _logButton.Text = "打开日志";
        _logButton.AutoSize = true;
        _logButton.Visible = false;
        _logButton.Click += (_, _) =>
        {
            if (string.IsNullOrEmpty(LogPath) || !File.Exists(LogPath)) return;
            // 在资源管理器里选中该文件；UseShellExecute 必须为 true 才能走 shell
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = $"/select,\"{LogPath}\"",
                UseShellExecute = true,
            });
        };

        Controls.AddRange(new Control[] { _mark, _status, _detail, _logButton });
        Resize += (_, _) => Relayout();
        Relayout();
    }

    private void Relayout()
    {
        var cx = Width / 2;
        var cy = Height / 2;
        _mark.Location = new Point(cx - _mark.Width / 2, cy - 96);
        _status.Location = new Point(cx - _status.Width / 2, _mark.Bottom + 20);
        _detail.Location = new Point(cx - _detail.Width / 2, _status.Bottom + 14);
        _logButton.Location = new Point(cx - _logButton.Width / 2, _detail.Bottom + 8);
    }

    internal void ShowStarting(string text)
    {
        _status.Text = text;
        _status.ForeColor = Palette.Label;
        _detail.Visible = false;
        _logButton.Visible = false;
        Relayout();
    }

    internal void ShowFailure(string text)
    {
        _status.Text = "引擎没能起来";
        _status.ForeColor = Palette.ErrorColor;
        _detail.Text = text;
        _detail.Visible = true;
        _logButton.Visible = File.Exists(LogPath);
        Relayout();
    }

    /// <summary>只负责画 K 的一小块，与应用图标同一份几何。</summary>
    private sealed class MarkBox : Control
    {
        internal MarkBox() => SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                                       | ControlStyles.SupportsTransparentBackColor, true);

        protected override void OnPaint(PaintEventArgs e) =>
            KMark.Draw(e.Graphics, ClientRectangle, Palette.MarkStart, Palette.MarkEnd);
    }
}
