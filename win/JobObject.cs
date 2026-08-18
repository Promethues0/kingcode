using System.Runtime.InteropServices;

namespace KingCode;

/// <summary>
/// 进程树的兜底回收：Job Object + KILL_ON_JOB_CLOSE。
///
/// 为什么不用 <c>Process.Kill(entireProcessTree: true)</c>：
/// ① 它的 Windows 实现是「先杀自己再枚举后代」，中间层进程若在别的 job 里
///    或权限不足看不到，递归会提前断掉，孙进程直接成孤儿
///    （dotnet/runtime#107992，修复排到 .NET 11）；
/// ② 它需要我们的代码活着才能执行——应用崩溃时一行都跑不到。
/// Job Object 是唯一覆盖崩溃场景的方案：内核在任何形式的进程终止时都会关掉
/// 句柄，KILL_ON_JOB_CLOSE 随之生效。
///
/// 关键手法是**把自己加进 job**：此后 CreateProcess 出来的后代自动继承成员
/// 身份，不存在「Start() 返回后再 Assign」那段可能漏掉孙进程的窗口期。
/// </summary>
internal sealed class JobObject : IDisposable
{
    private IntPtr _handle;

    private JobObject(IntPtr handle) => _handle = handle;

    /// <summary>本进程是否已成功进入 job；false 时调用方需退回逐进程 kill。</summary>
    internal bool Active => _handle != IntPtr.Zero;

    /// <summary>
    /// 建一个 KILL_ON_JOB_CLOSE 的 job 并把当前进程加进去。
    /// 宿主已经在别人的 job 里时（VS 调试器、Windows Terminal、CI agent、
    /// 容器），Win8+ 会自动嵌套；更老的系统会失败——所以全程 try/catch，
    /// 失败只是降级，绝不让启动流程崩掉。
    /// </summary>
    internal static JobObject CreateAndAssignSelf()
    {
        try
        {
            // lpJobAttributes 传 Zero：句柄**绝不能可继承**。子进程一旦继承到
            // 句柄副本，我们这边关掉时 job 还活着，KILL_ON_JOB_CLOSE 不触发，
            // 孤儿照留——这个 bug 只在崩溃路径上暴露，正常测试测不出来。
            var handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) return new JobObject(IntPtr.Zero);

            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
            {
                BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION
                {
                    // 刻意不设 BREAKAWAY_OK / SILENT_BREAKAWAY_OK：
                    // 设了就等于允许子进程脱离，整棵树覆盖不住。
                    LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
            };

            var length = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
            var buffer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(info, buffer, false);
                if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, buffer, (uint)length))
                {
                    CloseHandle(handle);
                    return new JobObject(IntPtr.Zero);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }

            if (!AssignProcessToJobObject(handle, GetCurrentProcess()))
            {
                CloseHandle(handle);
                return new JobObject(IntPtr.Zero);
            }
            return new JobObject(handle);
        }
        catch
        {
            return new JobObject(IntPtr.Zero);
        }
    }

    /// <summary>
    /// 主动终止 job 内的全部进程。
    ///
    /// ⚠️ 本进程自己也是 job 成员，所以这会**连调用方一起杀**。正常退出路径
    /// 不要用它——靠 KILL_ON_JOB_CLOSE 在句柄关闭时自动收尾即可。留着它只为
    /// 「明知要立刻整体终止」的场景。
    /// </summary>
    internal void TerminateAll()
    {
        if (_handle == IntPtr.Zero) return;
        try { TerminateJobObject(_handle, 0); } catch { /* 已经没了就算了 */ }
    }

    public void Dispose()
    {
        if (_handle == IntPtr.Zero) return;
        CloseHandle(_handle);
        _handle = IntPtr.Zero;
    }

    // ── P/Invoke ───────────────────────────────────────────────────────────

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);
}
