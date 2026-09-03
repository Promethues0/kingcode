using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace KingCode;

/// <summary>KingCode 主窗口：WebView2 承载引擎的 Web UI，外加启动页与菜单。</summary>
internal sealed class MainForm : Form
{
    private readonly WebView2 _webView = new();
    private readonly LaunchPanel _launch = new();
    private readonly ServerController _server;
    private bool _configured;   // CoreWebView2InitializationCompleted 可能触发两次

    internal MainForm(ServerController server)
    {
        _server = server;

        Text = "KingCode";
        // ApplicationIcon 只管 exe 在资源管理器/任务栏上的图标；
        // 窗口标题栏与 Alt+Tab 用的是 Form.Icon，必须另外设，否则是 WinForms 内置图标。
        try
        {
            var icoPath = Path.Combine(AppContext.BaseDirectory, "assets", "KingCode.ico");
            Icon = File.Exists(icoPath)
                ? new Icon(icoPath)
                : Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? Icon;
        }
        catch { /* 图标拿不到不影响使用 */ }

        ClientSize = new Size(1180, 780);
        MinimumSize = new Size(760, 560);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Palette.WindowBackground;

        _webView.Dock = DockStyle.Fill;
        _webView.Visible = false;
        _webView.DefaultBackgroundColor = Palette.WindowBackground;
        _webView.CoreWebView2InitializationCompleted += OnCoreReady;
        _webView.NavigationCompleted += OnNavigationCompleted;

        _launch.Dock = DockStyle.Fill;
        _launch.LogPath = _server.LogPath;

        Controls.Add(_webView);
        Controls.Add(_launch);
        _launch.BringToFront();

        BuildMenu();
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        _launch.ShowStarting("正在连接 KingCode 引擎…");

        // WebView2 Runtime 缺失时给人话，而不是让 EnsureCoreWebView2Async 抛一堆栈。
        // 注意：.NET 版在缺失时**抛 WebView2RuntimeNotFoundException**，不是返回 null。
        try
        {
            CoreWebView2Environment.GetAvailableBrowserVersionString();
        }
        catch (WebView2RuntimeNotFoundException)
        {
            _launch.ShowFailure(
                "缺少 WebView2 运行时。\n" +
                "Windows 11 自带；Windows 10 少数机器需要手动安装。\n" +
                "下载： https://developer.microsoft.com/microsoft-edge/webview2/");
            return;
        }
        catch (Exception ex)
        {
            _launch.ShowFailure($"检测 WebView2 运行时失败：{ex.Message}");
            return;
        }

        try
        {
            // 必须显式指定用户数据目录：.NET 平台默认把它建在 exe 旁边
            // （<exe 全路径>.WebView2），一旦应用装进 Program Files 就会因权限
            // 失败并在启动时抛运行时错误。
            var udf = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "KingCode", "WebView2");
            Directory.CreateDirectory(udf);
            var env = await CoreWebView2Environment.CreateAsync(null, udf);
            await _webView.EnsureCoreWebView2Async(env);
        }
        catch (Exception ex)
        {
            _launch.ShowFailure($"WebView2 初始化失败：{ex.Message}");
            return;
        }

        _server.StateChanged += OnServerState;
        await _server.StartAsync();
    }

    private void OnServerState(ServerController.State state)
    {
        // 引擎的轮询在后台线程，回到 UI 线程再动控件
        if (InvokeRequired)
        {
            BeginInvoke(() => OnServerState(state));
            return;
        }
        switch (state.Phase)
        {
            case ServerController.Phase.Starting:
                _launch.ShowStarting(state.Message);
                break;
            case ServerController.Phase.Ready:
                // 首次加载走带 token 的地址去换会话 cookie（alpha.2 起 loopback 也要）；
                // 附着到别人起的引擎时拿不到 token，退回裸地址靠已持久化的 cookie。
                _webView.Source = _server.AuthenticatedUrl ?? _server.Url;
                break;
            case ServerController.Phase.Failed:
                _launch.ShowFailure(state.Message);
                break;
        }
    }

    private void OnCoreReady(object? sender, CoreWebView2InitializationCompletedEventArgs e)
    {
        // 官方注明：初始化成功上报后，若紧接着的导航失败，本事件可能再触发一次
        if (!e.IsSuccess || _configured) return;
        _configured = true;

        var settings = _webView.CoreWebView2.Settings;
        settings.AreDefaultContextMenusEnabled = false;  // 不要浏览器右键菜单
        settings.AreDevToolsEnabled = false;
        settings.IsStatusBarEnabled = false;
        // 关掉浏览器专属快捷键（Ctrl+P 打印、Ctrl+F 页内查找、F12 等），
        // 但 Ctrl+C/V/A/Z 这些编辑键不受影响，仍然可用。
        settings.AreBrowserAcceleratorKeysEnabled = false;

        // 页面要开新窗口时（外链）交给系统默认浏览器，不在客户端里跑丢
        _webView.CoreWebView2.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            OpenExternally(args.Uri);
        };
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess)
        {
            _launch.ShowFailure($"页面加载失败：{e.WebErrorStatus}");
            return;
        }
        if (!_launch.Visible) return;
        _webView.Visible = true;
        _launch.Visible = false;
    }

    private static void OpenExternally(string url)
    {
        try
        {
            // .NET 5+ 的 UseShellExecute 默认是 false，而只有走 shell 才能把
            // http(s) 交给默认浏览器 —— 这里必须显式打开。
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true,
            });
        }
        catch { /* 打不开就算了，不该为此打断主流程 */ }
    }

    // ── 菜单 ───────────────────────────────────────────────────────────────

    private void BuildMenu()
    {
        var strip = new MenuStrip();

        var engine = new ToolStripMenuItem("引擎(&E)");
        engine.DropDownItems.Add("重新载入(&R)", null, async (_, _) => await ReloadAsync());
        engine.DropDownItems.Add(new ToolStripSeparator());
        engine.DropDownItems.Add("在浏览器中打开(&B)", null, (_, _) => OpenExternally(_server.Url.ToString()));
        engine.DropDownItems.Add("显示引擎日志(&L)", null, (_, _) =>
        {
            if (!File.Exists(_server.LogPath)) return;
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = $"/select,\"{_server.LogPath}\"",
                UseShellExecute = true,
            });
        });
        engine.DropDownItems.Add(new ToolStripSeparator());
        engine.DropDownItems.Add("退出(&Q)", null, (_, _) => Close());

        strip.Items.Add(engine);
        MainMenuStrip = strip;
        Controls.Add(strip);
    }

    /// <summary>
    /// 真正重取的重载。WebView2 **没有** Reload(ignoreCache) 这种重载，
    /// 而引擎的插件 bundle 路径 /plugins/&lt;id&gt;/client.js 不带版本号——
    /// 直接 Reload 会一直看到旧的品牌层。所以先清磁盘缓存再重载。
    /// </summary>
    private async Task ReloadAsync()
    {
        if (_webView.CoreWebView2 is null) return;
        try
        {
            await _webView.CoreWebView2.Profile.ClearBrowsingDataAsync(
                CoreWebView2BrowsingDataKinds.DiskCache);
        }
        catch { /* 清不掉也要照常重载 */ }
        _webView.CoreWebView2.Reload();
    }
}
