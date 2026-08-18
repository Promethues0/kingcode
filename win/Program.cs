namespace KingCode;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        // 第一件事就把自己加进 job：此后 CreateProcess 出来的后代自动继承成员
        // 身份，不存在「Start() 返回后再 Assign」那段可能漏掉孙进程的窗口期。
        // 失败（老系统 + 已在别人的 job 里）只是降级，不影响启动。
        using var job = JobObject.CreateAndAssignSelf();

        var port = int.TryParse(Environment.GetEnvironmentVariable("KINGCODE_PORT"), out var p) ? p : 3081;
        using var server = new ServerController(port, job);

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(server));
        // server 与 job 在这里依次 Dispose：先收自己拉起的引擎，
        // 再关 job 句柄让 KILL_ON_JOB_CLOSE 兜掉可能漏网的后代。
    }
}
