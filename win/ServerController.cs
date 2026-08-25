using System.Diagnostics;
using System.Net.Http;

namespace KingCode;

/// <summary>
/// dsh 引擎的生命周期：探活 → 需要时才拉起 → 退出时只收自己拉起的那个。
/// 与 mac/Sources/ServerController.swift 同一口径。
/// </summary>
internal sealed class ServerController : IDisposable
{
    internal enum Phase { Starting, Ready, Failed }

    internal readonly record struct State(Phase Phase, string Message);

    private static readonly HttpClient Probe = new() { Timeout = TimeSpan.FromSeconds(2) };

    private readonly int _port;
    private readonly JobObject _job;
    private Process? _process;

    internal event Action<State>? StateChanged;

    internal ServerController(int port, JobObject job)
    {
        _port = port;
        _job = job;
        var dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "KingCode");
        Directory.CreateDirectory(dir);
        LogPath = Path.Combine(dir, "engine.log");
    }

    internal Uri Url => new($"http://127.0.0.1:{_port}");
    internal string LogPath { get; }

    // ── 工具链解析 ─────────────────────────────────────────────────────────

    /// <summary>
    /// 进程 PATH 是启动那一刻的快照——用户装完 Node 不重启本应用就读不到。
    /// 所以把注册表里的机器级/用户级 PATH 也并进来。
    /// </summary>
    private static IEnumerable<string> SearchPath()
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var target in new[]
                 {
                     EnvironmentVariableTarget.Process,
                     EnvironmentVariableTarget.User,
                     EnvironmentVariableTarget.Machine,
                 })
        {
            string? raw = null;
            try { raw = Environment.GetEnvironmentVariable("PATH", target); }
            catch { /* 读注册表可能被策略拦，忽略 */ }
            if (string.IsNullOrWhiteSpace(raw)) continue;
            foreach (var part in raw.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                if (seen.Add(part)) yield return part;
        }
    }

    private static string? FirstFile(IEnumerable<string> candidates) =>
        candidates.FirstOrDefault(p => !string.IsNullOrWhiteSpace(p) && File.Exists(p));

    /// <summary>定位 node.exe。允许用 KINGCODE_NODE 直接指定，绕过一切猜测。</summary>
    internal static string? FindNode()
    {
        var explicitPath = Environment.GetEnvironmentVariable("KINGCODE_NODE");
        if (!string.IsNullOrWhiteSpace(explicitPath) && File.Exists(explicitPath)) return explicitPath;

        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var candidates = new List<string>
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
            // nvm-windows 的当前版本符号链接
            Path.Combine(Environment.GetEnvironmentVariable("NVM_SYMLINK") ?? "", "node.exe"),
            // fnm：只认这个稳定别名，不要缓存 fnm_multishells\<pid>_<ts>（shell 一退就失效）
            Path.Combine(appData, "fnm", "aliases", "default", "node.exe"),
            Path.Combine(localAppData, "Volta", "bin", "node.exe"),
        };
        candidates.AddRange(SearchPath().Select(dir => Path.Combine(dir, "node.exe")));
        return FirstFile(candidates);
    }

    /// <summary>
    /// 定位 dsh 的入口脚本。**直接喂给 node，不碰 dsh.cmd**：
    /// Windows 上根本没有 npm.exe/dsh.exe，用 .cmd 会隐式起一层 cmd.exe，
    /// 进程树平白多一层（kill 直接子进程就留孤儿），还会撞上 cmd.exe 的
    /// 参数解析问题（BatBadBut）。
    /// </summary>
    internal static string? FindDshEntry()
    {
        var explicitPath = Environment.GetEnvironmentVariable("KINGCODE_DSH_ENTRY");
        if (!string.IsNullOrWhiteSpace(explicitPath) && File.Exists(explicitPath)) return explicitPath;

        const string tail = @"node_modules\@deepseek-ai\dsh\lib\bin.js";
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var roots = new List<string>
        {
            // npm 全局默认 prefix；注意 prefix 可被 .npmrc / npm_config_prefix 改掉，
            // 所以后面还会扫 PATH 兜底。
            Path.Combine(appData, "npm"),
            Environment.GetEnvironmentVariable("npm_config_prefix") ?? "",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"),
        };
        // PATH 里出现 dsh.cmd 的目录，往往就是 npm 全局 bin 目录
        roots.AddRange(SearchPath().Where(d => File.Exists(Path.Combine(d, "dsh.cmd"))));

        return FirstFile(roots.Where(r => !string.IsNullOrWhiteSpace(r))
                              .Select(r => Path.Combine(r, tail)));
    }

    // ── 探活与启动 ─────────────────────────────────────────────────────────

    private async Task<bool> IsUpAsync()
    {
        try
        {
            using var response = await Probe.GetAsync(Url, HttpCompletionOption.ResponseHeadersRead);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    internal async Task StartAsync()
    {
        StateChanged?.Invoke(new State(Phase.Starting, "正在连接 KingCode 引擎…"));

        if (await IsUpAsync())
        {
            // 已经有人在跑（终端里手动起的），附着上去，退出时不动它
            StateChanged?.Invoke(new State(Phase.Ready, string.Empty));
            return;
        }

        var node = FindNode();
        if (node is null)
        {
            StateChanged?.Invoke(new State(Phase.Failed,
                "找不到 node.exe。请先安装 Node.js（KingCode 需要它来运行 dsh 引擎）。\n" +
                "若已安装但仍报此错，可设环境变量 KINGCODE_NODE 指向 node.exe 后重启本应用。"));
            return;
        }

        var entry = FindDshEntry();
        if (entry is null)
        {
            StateChanged?.Invoke(new State(Phase.Failed,
                "找不到 dsh 引擎。请先安装：npm install -g @deepseek-ai/dsh\n" +
                "若装在非默认位置，可设 KINGCODE_DSH_ENTRY 指向 dsh 的 lib\\bin.js。"));
            return;
        }

        StateChanged?.Invoke(new State(Phase.Starting, "正在启动 KingCode 引擎…"));

        var info = new ProcessStartInfo
        {
            FileName = node,
            // CreateNoWindow 必须与 UseShellExecute=false 成对；单设无效。
            // 刻意不设 WindowStyle：它在 .NET 8 前后行为不同，设了等于埋跨版本差异。
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            // 显式给工作目录：Volta/fnm 的 node.exe 是 shim，会按 cwd 现场解析
            // 真实版本，不指定的话跑到哪个 Node 版本会飘。
            WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        };
        // KingCode 自己的 harness home。dsh 默认的 %USERPROFILE%\.dsh 跨产品共用：同机
        // 另一个 dsh 产品的领域预设装在 $DSH_HOME\.agent-presets 下、默认预设写在
        // settings.yaml 里，共用会让预设选择器列出别人的预设、新会话开在别人的预设上。
        // 路径与 profile\setup.ps1、bin/kingcode.js 一致。UseShellExecute=false 时
        // info.Environment 已预置本进程的环境；用户显式设了的不覆盖。
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("DSH_HOME")))
        {
            info.Environment["DSH_HOME"] = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".kingcode");
        }
        // 用 ArgumentList 而不是拼 Arguments 字符串，避免路径含空格/引号时的转义问题
        info.ArgumentList.Add(entry);
        info.ArgumentList.Add("--profile");
        info.ArgumentList.Add("kingcode");
        info.ArgumentList.Add("--port");
        info.ArgumentList.Add(_port.ToString());

        try
        {
            var process = new Process { StartInfo = info, EnableRaisingEvents = true };
            var log = new StreamWriter(new FileStream(LogPath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
            {
                AutoFlush = true,
            };
            process.OutputDataReceived += (_, e) => { if (e.Data is not null) log.WriteLine(e.Data); };
            process.ErrorDataReceived += (_, e) => { if (e.Data is not null) log.WriteLine(e.Data); };
            process.Exited += (_, _) =>
            {
                log.Dispose();
                // 我们主动收掉时 _process 已置空，那是预期内退出
                if (_process is null) return;
                StateChanged?.Invoke(new State(Phase.Failed,
                    $"引擎意外退出（状态码 {process.ExitCode}）。\n{LogTail()}"));
            };

            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            _process = process;
        }
        catch (Exception ex)
        {
            StateChanged?.Invoke(new State(Phase.Failed, $"无法启动引擎：{ex.Message}"));
            return;
        }

        await WaitUntilReadyAsync();
    }

    /// <summary>轮询到起得来为止；引擎首启要装配整棵插件树，给足 90 秒。</summary>
    private async Task WaitUntilReadyAsync()
    {
        var deadline = DateTime.UtcNow.AddSeconds(90);
        while (DateTime.UtcNow < deadline)
        {
            if (await IsUpAsync())
            {
                StateChanged?.Invoke(new State(Phase.Ready, string.Empty));
                return;
            }
            if (_process is { HasExited: true }) return;   // Exited 事件已经报过错了
            await Task.Delay(400);
        }
        StateChanged?.Invoke(new State(Phase.Failed, $"引擎启动超时（90 秒）。\n{LogTail()}"));
    }

    private string LogTail(int lines = 8)
    {
        try
        {
            // 引擎还开着这个文件，必须允许共享读
            using var stream = new FileStream(LogPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream);
            var all = reader.ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries);
            var tail = string.Join('\n', all.TakeLast(lines)).Trim();
            return tail.Length == 0 ? $"日志：{LogPath}" : tail;
        }
        catch
        {
            return $"日志：{LogPath}";
        }
    }

    /// <summary>只收自己拉起的引擎；附着到别人起的服务时什么都不做。</summary>
    public void Dispose()
    {
        var process = _process;
        _process = null;                 // 先置空，让 Exited 处理器知道这是预期内退出
        if (process is null) return;     // 附着模式：不是我们起的，不碰

        try
        {
            if (!process.HasExited)
            {
                // Windows 没有 SIGTERM，没有「优雅关闭」这条路可走。
                // 会话日志是 append-only JSONL，硬杀不会写坏。
                process.Kill(entireProcessTree: true);
                process.WaitForExit(3000);
            }
        }
        catch { /* 已经退了 */ }
        finally
        {
            process.Dispose();
            // 这里**不能**调 _job.TerminateAll()：本进程自己也是 job 成员，
            // 终止 job 会把我们一起杀掉，退出看起来就像崩溃。
            // 兜底交给 KILL_ON_JOB_CLOSE —— 本进程退出时句柄自动关闭，
            // 内核负责收掉 Kill 树遍历可能漏掉的后代（含崩溃路径）。
        }
    }
}
